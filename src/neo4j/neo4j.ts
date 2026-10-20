/**
 * A `StorageAdapter` over Neo4j. Like `/postgres`, this is an optional entry point that
 * imports no driver: you connect with `neo4j-driver` and pass the driver in.
 */
import { createChangePoller } from '../change-poller.js';
import { describeUnknownError } from '../errors.js';
import { revisionText, sqlFailure } from '../sql-shared.js';
import {
  compareKeys,
  prefixFailure,
  utf8Length,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** One row of a result. `neo4j-driver`'s `Record` fits as it is. */
export interface Neo4jRecordLike {
  get(key: string): unknown;
}

/** What `run` resolves. */
export interface Neo4jResultLike {
  readonly records: readonly Neo4jRecordLike[];
}

/** A session, as far as this adapter uses one. */
export interface Neo4jSessionLike {
  run(
    query: string,
    parameters?: Record<string, unknown>
  ): PromiseLike<Neo4jResultLike>;
  close(): PromiseLike<void>;
}

/** The session settings the adapter chooses; yours (`sessionConfig`) are added to them. */
export interface Neo4jSessionConfig {
  /** `'READ'` or `'WRITE'`, which `neo4j.session.READ` and `.WRITE` also are. */
  readonly defaultAccessMode: 'READ' | 'WRITE';
  readonly [setting: string]: unknown;
}

/**
 * The one thing this adapter needs from a driver: open a session. A `Driver` from
 * `neo4j-driver` fits as it is. Failures should reject.
 */
export interface Neo4jDriverLike {
  session(config: Neo4jSessionConfig): Neo4jSessionLike;
}

export interface Neo4jAdapterOptions {
  /** A driver you created. The adapter never closes it. */
  readonly driver: Neo4jDriverLike;
  /**
   * The label of the nodes that hold entries: letters, digits and underscores, starting
   * with a letter or underscore. Defaults to `StorageEntry`.
   */
  readonly label?: string;
  /**
   * Create the uniqueness constraint on `key` before first use if it is not there.
   * Defaults to true. The constraint is what makes concurrent first writes safe, so if
   * you turn this off, create it yourself:
   * `CREATE CONSTRAINT FOR (n:StorageEntry) REQUIRE n.key IS UNIQUE`.
   */
  readonly createConstraint?: boolean;
  /**
   * Extra settings for every session, such as `database` or a `bookmarkManager` (which
   * keeps a read from missing a write in a cluster).
   */
  readonly sessionConfig?: Readonly<Record<string, unknown>>;
  /**
   * Milliseconds between looks at the subscribed keys for changes other processes made
   * (at least 50). Neo4j cannot announce changes to a client, so `subscribe` hears only
   * this adapter's own writes unless you give this. Off by default.
   */
  readonly pollIntervalMs?: number;
  /** Called once per run of failed polls, with a message naming the label. */
  readonly onPollError?: (message: string) => void;
}

const LABEL = 'Neo4j';
const DEFAULT_NODE_LABEL = 'StorageEntry';
/** A string property in a uniqueness index is limited to about 8 kB. */
const MAX_KEY_BYTES = 8000;
/** A statement that meets a lock conflict (a deadlock, say) is tried this many times. */
const MAX_TRANSIENT_ATTEMPTS = 12;
const MAX_BACKOFF_MS = 100;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * The statements, for one label. Writes take the node's lock first (`SET n.lock_`) and
 * only then read the revision: Neo4j does not lock a node for reading, so without this
 * two writers could both read revision 5 and both write 6.
 */
function statementsFor(label: string): Readonly<Record<string, string>> {
  return {
    constraint: `CREATE CONSTRAINT ${label}_key_unique IF NOT EXISTS FOR (n:${label}) REQUIRE n.key IS UNIQUE`,
    select: `MATCH (n:${label} {key: $key}) RETURN n.value AS value, n.revision AS revision`,
    // Creates the node, or fails on the uniqueness constraint if the key is taken.
    create: `CREATE (n:${label} {key: $key, value: $value, revision: 1, created_at: datetime(), updated_at: datetime()}) RETURN n.revision AS revision`,
    // Creates the node at revision 1, or replaces it and counts up. A node that has no
    // whole-number revision is left alone (no row comes back).
    upsert: `MERGE (n:${label} {key: $key})
ON CREATE SET n.value = $value, n.revision = 0, n.created_at = datetime()
ON MATCH SET n.lock_ = true
WITH n
WHERE n.revision IS NOT NULL AND n.revision = toInteger(n.revision)
SET n.value = $value, n.revision = n.revision + 1, n.updated_at = datetime()
REMOVE n.lock_
RETURN n.revision AS revision`,
    // Replaces the value only if the revision is the expected one; either way it says
    // which revision it found and whether it wrote. No row means there is no such node.
    compareAndSet: `MATCH (n:${label} {key: $key})
SET n.lock_ = true
WITH n, n.revision AS found, (n.revision = toInteger($expected)) AS matched
FOREACH (_ IN CASE WHEN matched THEN [1] ELSE [] END |
  SET n.value = $value, n.revision = toInteger($expected) + 1, n.updated_at = datetime())
REMOVE n.lock_
RETURN found AS revision, matched AS applied`,
    remove: `MATCH (n:${label} {key: $key}) DETACH DELETE n`,
    list: `MATCH (n:${label}) WHERE n.key STARTS WITH $prefix RETURN n.key AS key`,
    many: `MATCH (n:${label}) WHERE n.key IN $keys RETURN n.key AS key, n.value AS value, n.revision AS revision`,
  };
}

/** The status code a Neo4j error carries (`Neo.ClientError...`, `ServiceUnavailable`), or ''. */
function codeOf(error: unknown): string {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/** A lock conflict or the like: nothing was done, and trying again can work. */
function isTransient(error: unknown): boolean {
  const code: string = codeOf(error);
  return (
    code.startsWith('Neo.TransientError.Transaction') ||
    code.startsWith('Neo.TransientError.Schema')
  );
}

function isUniquenessViolation(error: unknown): boolean {
  return codeOf(error) === 'Neo.ClientError.Schema.ConstraintValidationFailed';
}

/** The connection broke or the cluster could not be reached, so a write's outcome is unknown. */
function isConnectionLoss(error: unknown): boolean {
  const code: string = codeOf(error);
  return code === 'ServiceUnavailable' || code === 'SessionExpired';
}

function classifyError(error: unknown): StoreErrorCode {
  const message: string = describeUnknownError(error);
  const code: string = codeOf(error);
  if (
    code.startsWith('Neo.ClientError.Security') ||
    /unauthori[sz]ed|forbidden|authentication/i.test(message)
  ) {
    return 'forbidden';
  }
  if (code === 'Neo.ClientError.Database.DatabaseNotFound') {
    return 'unavailable';
  }
  if (/too large to index|too large|exceeds/i.test(message)) {
    return 'invalid';
  }
  if (
    code === 'Neo.ClientError.Statement.SyntaxError' ||
    code === 'Neo.ClientError.Statement.ParameterMissing'
  ) {
    return 'invalid';
  }
  if (
    /out of memory|memory pool|no space left|disk full|out of space/i.test(
      message
    )
  ) {
    return 'quota';
  }
  return 'unavailable';
}

function failedWith<T>(
  error: unknown,
  key: string,
  verb: string,
  label: string
): StoreResult<T> {
  const code: StoreErrorCode = classifyError(error);
  const message: string = describeUnknownError(error);
  let detail = `could not be ${verb} (${message})`;
  if (codeOf(error) === 'Neo.ClientError.Database.DatabaseNotFound') {
    detail = `could not be ${verb} (the database does not exist: ${message})`;
  } else if (verb !== 'read' && isConnectionLoss(error)) {
    detail = `could not be ${verb} (${message}); the write may or may not have been applied, so read the key to find out`;
  } else if (
    classifyError(error) === 'invalid' &&
    /too large to index/i.test(message)
  ) {
    detail = `could not be ${verb} (the key is too large for the uniqueness index on label "${label}": ${message})`;
  }
  return sqlFailure(LABEL, code, key, detail);
}

/** A whole-number revision a result holds (as a driver `Integer`, number or string). */
function revisionNumber(cell: unknown): number | undefined {
  const text: string | undefined =
    typeof cell === 'object' && cell !== null
      ? revisionText(String(cell))
      : revisionText(cell);
  if (text === undefined || text.length > 15) {
    return undefined;
  }
  const value: number = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type Attempt =
  | { readonly kind: 'applied'; readonly revision: number }
  | { readonly kind: 'refused'; readonly revision: number | undefined }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly result: StoreResult<never> };

/**
 * A `StorageAdapter` over Neo4j. Each key is one node (label `StorageEntry` unless you
 * choose another) holding the value and a counter revision, with a uniqueness
 * constraint on `key`. Every write is one Cypher statement that takes the node's lock
 * before it reads the revision, so `ifRevision` is checked atomically across processes:
 * two writers holding the same revision cannot both win, and the loser is told the
 * revision that beat it. A write without `ifRevision` replaces whatever is stored in one
 * statement. A key removed and written again starts at revision 1. `list` reads every
 * key under the prefix in one query. Nothing throws: every failure is a `StoreResult`.
 */
export function neo4jAdapter(options: Neo4jAdapterOptions): StorageAdapter {
  const { driver } = options;
  const label: string = options.label ?? DEFAULT_NODE_LABEL;
  const labelIsSafe: boolean = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(label);
  const createConstraint: boolean = options.createConstraint ?? true;
  const sql = statementsFor(label);
  let ready: Promise<void> | null = null;

  /** Runs one statement in its own session and transaction. */
  const run = async (
    query: string,
    params: Record<string, unknown>,
    mode: 'READ' | 'WRITE'
  ): Promise<readonly Neo4jRecordLike[]> => {
    for (let attempt = 1; ; attempt += 1) {
      const session = driver.session({
        ...options.sessionConfig,
        defaultAccessMode: mode,
      });
      try {
        return (await session.run(query, params)).records;
      } catch (error: unknown) {
        if (!isTransient(error) || attempt >= MAX_TRANSIENT_ATTEMPTS) {
          throw error;
        }
      } finally {
        try {
          await session.close();
        } catch {
          // A session that will not close cannot change what the statement did.
        }
      }
      // A lock conflict: wait a random moment so the two do not collide again.
      await pause(
        Math.floor(Math.random() * Math.min(MAX_BACKOFF_MS, 2 ** attempt))
      );
    }
  };

  /** Creates the constraint once; a failure is not remembered, so the next call retries. */
  const prepare = (): Promise<void> => {
    if (!createConstraint) {
      return Promise.resolve();
    }
    if (ready === null) {
      ready = run(sql.constraint ?? '', {}, 'WRITE').then(() => undefined);
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  };

  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): StoreResult<T> | null => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    if (!labelIsSafe) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use label "${label}": use letters, digits and underscores, starting with a letter or underscore`
      );
    }
    if (LONE_SURROGATE.test(key) || utf8Length(key) > MAX_KEY_BYTES) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use this key: it must be valid Unicode text of at most ${String(MAX_KEY_BYTES)} bytes`
      );
    }
    return null;
  };

  /** Reads the node for a key. */
  const readNode = async (
    key: string
  ): Promise<StoreResult<{ value: string; revision: number } | null>> => {
    try {
      await prepare();
      const row = (await run(sql.select ?? '', { key }, 'READ'))[0];
      if (row === undefined) {
        return { ok: true, value: null };
      }
      const value: unknown = row.get('value');
      const revision: number | undefined = revisionNumber(row.get('revision'));
      if (typeof value !== 'string' || revision === undefined) {
        return sqlFailure(
          LABEL,
          'corrupt',
          key,
          'holds a node that is not a stored entry (it needs a text value and a whole-number revision; remove the key to start again)'
        );
      }
      return { ok: true, value: { value, revision } };
    } catch (error: unknown) {
      return failedWith(error, key, 'read', label);
    }
  };

  /** Creates the node only if the key is free (the uniqueness constraint decides). */
  const createNode = async (key: string, value: string): Promise<Attempt> => {
    try {
      await prepare();
      await run(sql.create ?? '', { key, value }, 'WRITE');
      return { kind: 'applied', revision: 1 };
    } catch (error: unknown) {
      if (isUniquenessViolation(error)) {
        return { kind: 'refused', revision: undefined };
      }
      return {
        kind: 'failed',
        result: failedWith(error, key, 'written', label),
      };
    }
  };

  /** Replaces the node only if it still has this revision. */
  const compareAndSet = async (
    key: string,
    value: string,
    expected: number
  ): Promise<Attempt> => {
    try {
      await prepare();
      const row = (
        await run(
          sql.compareAndSet ?? '',
          { key, value, expected: String(expected) },
          'WRITE'
        )
      )[0];
      if (row === undefined) {
        return { kind: 'missing' };
      }
      if (row.get('applied') === true) {
        return { kind: 'applied', revision: expected + 1 };
      }
      return { kind: 'refused', revision: revisionNumber(row.get('revision')) };
    } catch (error: unknown) {
      return {
        kind: 'failed',
        result: failedWith(error, key, 'written', label),
      };
    }
  };

  /** Reads these keys together; throws if that fails. */
  const readKeys = async (
    keys: readonly string[]
  ): Promise<ReadonlyMap<string, StoredValue>> => {
    await prepare();
    const found = new Map<string, StoredValue>();
    for (const row of await run(sql.many ?? '', { keys }, 'READ')) {
      const name: unknown = row.get('key');
      const value: unknown = row.get('value');
      const revision: number | undefined = revisionNumber(row.get('revision'));
      if (
        typeof name === 'string' &&
        typeof value === 'string' &&
        revision !== undefined
      ) {
        found.set(name, { value, revision: String(revision) });
      }
    }
    return found;
  };

  const poller = createChangePoller({
    intervalMs: options.pollIntervalMs,
    readKeys,
    onError: options.onPollError,
    describeFailure: (cause) =>
      `${LABEL} could not poll label "${label}" for changes (${cause})`,
  });

  const adapter = {
    async get(key, { signal }) {
      const refused = refusal<StoredValue | null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      const read = await readNode(key);
      if (!read.ok) {
        return read;
      }
      return {
        ok: true,
        value:
          read.value === null
            ? null
            : {
                value: read.value.value,
                revision: String(read.value.revision),
              },
      };
    },

    async set(key, value, { signal, ifRevision }) {
      const refused = refusal<StoredValue>(key, signal);
      if (refused !== null) {
        return refused;
      }
      if (LONE_SURROGATE.test(value)) {
        return sqlFailure(
          LABEL,
          'invalid',
          key,
          'cannot store this value: it is not valid Unicode text'
        );
      }
      const finish = (revision: number): StoreResult<StoredValue> => {
        const stored: StoredValue = { value, revision: String(revision) };
        poller.announce(key, stored);
        return { ok: true, value: stored };
      };
      const conflict = (holds: number | undefined): StoreResult<StoredValue> =>
        sqlFailure(
          LABEL,
          'conflict',
          key,
          holds === undefined
            ? `changed while it was being written, so revision ${ifRevision ?? ''} no longer applies`
            : `holds revision ${String(holds)}, but revision ${ifRevision ?? ''} was expected`
        );
      const notAnEntry = (): StoreResult<StoredValue> =>
        sqlFailure(
          LABEL,
          'corrupt',
          key,
          'holds a node that is not a stored entry (it has no whole-number revision; remove the key to start again)'
        );

      if (ifRevision !== undefined) {
        // A revision that is not a whole number can never match what is stored.
        const expected: number | undefined = /^[0-9]{1,15}$/.test(ifRevision)
          ? Number(ifRevision)
          : undefined;
        if (expected !== undefined && expected >= 1) {
          const attempt = await compareAndSet(key, value, expected);
          if (attempt.kind === 'applied') {
            return finish(attempt.revision);
          }
          if (attempt.kind === 'failed') {
            return attempt.result;
          }
          if (attempt.kind === 'refused') {
            return attempt.revision === undefined
              ? notAnEntry()
              : conflict(attempt.revision);
          }
        } else {
          const read = await readNode(key);
          if (!read.ok) {
            return read;
          }
          if (read.value !== null) {
            return conflict(read.value.revision);
          }
        }
        // Nothing is stored, so there is no revision to differ from: create it.
        const created = await createNode(key, value);
        if (created.kind === 'applied') {
          return finish(1);
        }
        if (created.kind === 'failed') {
          return created.result;
        }
        return conflict(undefined);
      }

      // Replace whatever is stored, in one statement. When several writers create the
      // same key at once, the losers meet the uniqueness constraint; the key exists
      // by then, so trying again replaces it.
      try {
        await prepare();
        for (let attempt = 1; ; attempt += 1) {
          try {
            const row = (
              await run(sql.upsert ?? '', { key, value }, 'WRITE')
            )[0];
            if (row === undefined) {
              return notAnEntry();
            }
            const revision: number | undefined = revisionNumber(
              row.get('revision')
            );
            return revision === undefined ? notAnEntry() : finish(revision);
          } catch (error: unknown) {
            if (!isUniquenessViolation(error)) {
              throw error;
            }
            if (attempt >= MAX_TRANSIENT_ATTEMPTS) {
              return sqlFailure(
                LABEL,
                'conflict',
                key,
                `kept changing while it was being written (gave up after ${String(MAX_TRANSIENT_ATTEMPTS)} tries)`
              );
            }
          }
        }
      } catch (error: unknown) {
        return failedWith(error, key, 'written', label);
      }
    },

    async remove(key, { signal }) {
      const refused = refusal<null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      try {
        await prepare();
        await run(sql.remove ?? '', { key }, 'WRITE');
      } catch (error: unknown) {
        return failedWith(error, key, 'removed', label);
      }
      poller.announce(key, null);
      return { ok: true, value: null };
    },

    async list(keyPrefix, { signal }) {
      if (signal.aborted) {
        return prefixFailure(
          LABEL,
          'unavailable',
          keyPrefix,
          'request to list keys was aborted'
        );
      }
      if (!labelIsSafe) {
        return prefixFailure(
          LABEL,
          'invalid',
          keyPrefix,
          `cannot use label "${label}": use letters, digits and underscores, starting with a letter or underscore`
        );
      }
      try {
        await prepare();
        const keys: string[] = [];
        for (const row of await run(
          sql.list ?? '',
          { prefix: keyPrefix },
          'READ'
        )) {
          const name: unknown = row.get('key');
          if (typeof name === 'string') {
            keys.push(name);
          }
        }
        return { ok: true, value: keys.sort(compareKeys) };
      } catch (error: unknown) {
        return prefixFailure(
          LABEL,
          classifyError(error),
          keyPrefix,
          `could not list keys (${describeUnknownError(error)})`
        );
      }
    },

    subscribe(key, onChange) {
      return poller.subscribe(key, onChange);
    },
  } satisfies StorageAdapter;

  return {
    ...adapter,
    set: (key, value, setOptions) =>
      poller.trackWrite(key, () => adapter.set(key, value, setOptions)),
    remove: (key, removeOptions) =>
      poller.trackWrite(key, () => adapter.remove(key, removeOptions)),
  };
}
