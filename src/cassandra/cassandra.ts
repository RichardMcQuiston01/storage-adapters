/**
 * A `StorageAdapter` over Apache Cassandra (and ScyllaDB, which speaks the same CQL).
 * Like `/postgres`, this is an optional entry point that imports no driver: you connect
 * with `cassandra-driver` and pass the client in.
 */
import { createChangePoller } from '../change-poller.js';
import { describeUnknownError } from '../errors.js';
import { isSafeTableName, sqlFailure } from '../sql-shared.js';
import {
  compareKeys,
  prefixFailure,
  utf8Length,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** What `execute` resolves: the rows (column values as properties) and the next page. */
export interface CassandraResultLike {
  readonly rows: readonly unknown[];
  /** Pass this back to read the next page; empty at the end. */
  readonly pageState?: string | null | undefined;
}

export interface CassandraExecuteOptions {
  /** Always true: the adapter's statements are prepared. */
  readonly prepare: true;
  /** A CQL protocol consistency code, such as 8 for SERIAL. */
  readonly consistency?: number;
  readonly fetchSize?: number;
  readonly pageState?: string;
}

/**
 * The one thing this adapter needs from a client: run a statement. A `Client` from
 * `cassandra-driver` fits as it is. Failures should reject.
 */
export interface CassandraClientLike {
  execute(
    query: string,
    params: readonly unknown[],
    options: CassandraExecuteOptions
  ): Promise<CassandraResultLike>;
}

export interface CassandraAdapterOptions {
  /** A connected client. The adapter never closes it. */
  readonly client: CassandraClientLike;
  /**
   * The table, optionally with its keyspace: `storage_entry` or `app.storage_entry`.
   * Letters, digits and underscores only. Defaults to `storage_entry`, which needs a
   * keyspace set on the client.
   */
  readonly table?: string;
  /**
   * Create the table before first use if it is not there. Defaults to true. The
   * keyspace must already exist. Turn it off for an account that may not create tables.
   */
  readonly createTable?: boolean;
  /**
   * Which Paxos consistency reads use, so they see every committed write. `'serial'`
   * (the default) asks replicas in every data center; `'localSerial'` only the local
   * one, which is cheaper in a multi-data-center cluster.
   */
  readonly readConsistency?: 'serial' | 'localSerial';
  /**
   * Milliseconds between looks at the subscribed keys for changes other processes made
   * (at least 50). Cassandra cannot announce changes to a client, so `subscribe` hears
   * only this adapter's own writes unless you give this. Off by default.
   */
  readonly pollIntervalMs?: number;
  /** Called once per run of failed polls, with a message naming the table. */
  readonly onPollError?: (message: string) => void;
}

const LABEL = 'Cassandra';
const DEFAULT_TABLE = 'storage_entry';
/** CQL protocol consistency codes. */
const SERIAL = 8;
const LOCAL_SERIAL = 9;
/** A partition key can be at most 65535 bytes. */
const MAX_KEY_BYTES = 65_535;
const LIST_PAGE_SIZE = 1000;
/** A write that keeps meeting a newer version is tried this many times. */
const MAX_WRITE_ATTEMPTS = 12;
const MAX_BACKOFF_MS = 30;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function statementsFor(table: string): Readonly<Record<string, string>> {
  return {
    create: `CREATE TABLE IF NOT EXISTS ${table} (
  entry_key text PRIMARY KEY,
  entry_value text,
  revision bigint,
  created_at timestamp,
  updated_at timestamp
)`,
    select: `SELECT entry_value, revision FROM ${table} WHERE entry_key = ?`,
    insert: `INSERT INTO ${table} (entry_key, entry_value, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?) IF NOT EXISTS`,
    update: `UPDATE ${table} SET entry_value = ?, revision = ?, updated_at = ? WHERE entry_key = ? IF revision = ?`,
    remove: `DELETE FROM ${table} WHERE entry_key = ? IF EXISTS`,
    list: `SELECT entry_key FROM ${table}`,
    many: `SELECT entry_key, entry_value, revision FROM ${table} WHERE entry_key IN ?`,
  };
}

/** The error code Cassandra's `ResponseError` carries, or 0. */
function codeOf(error: unknown): number {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : 0;
}

function classifyError(error: unknown): StoreErrorCode {
  const message: string = describeUnknownError(error);
  const code: number = codeOf(error);
  // 0x0100 bad credentials, 0x2100 unauthorized.
  if (
    code === 0x0100 ||
    code === 0x2100 ||
    /unauthori[sz]ed|not authori[sz]ed|has no .* permission|authentication/i.test(
      message
    )
  ) {
    return 'forbidden';
  }
  if (/does not exist|unconfigured table|unknown keyspace/i.test(message)) {
    return 'unavailable';
  }
  if (
    /request is too big|too large|exceeds maximum|key may not be empty/i.test(
      message
    )
  ) {
    return 'invalid';
  }
  if (/no space left|disk full|out of space/i.test(message)) {
    return 'quota';
  }
  // 0x2000 syntax error, 0x2200 invalid query.
  if (code === 0x2000 || code === 0x2200) {
    return 'invalid';
  }
  return 'unavailable';
}

function failedWith<T>(
  error: unknown,
  key: string,
  verb: string,
  table: string
): StoreResult<T> {
  const code: StoreErrorCode = classifyError(error);
  const message: string = describeUnknownError(error);
  let detail = `could not be ${verb} (${message})`;
  if (/does not exist|unconfigured table|unknown keyspace/i.test(message)) {
    detail = `could not be ${verb} (table "${table}" or its keyspace does not exist: ${message})`;
  } else if (
    verb !== 'read' &&
    /timed out|timeout|CAS operation result is unknown/i.test(message)
  ) {
    detail = `could not be ${verb} (${message}); the write may or may not have been applied, so read the key to find out`;
  }
  return sqlFailure(LABEL, code, key, detail);
}

/** What a revision cell holds as a safe whole number, or `undefined` if it is not one. */
function revisionNumber(cell: unknown): number | undefined {
  if (cell === null || cell === undefined) {
    return undefined;
  }
  const text: string = String(cell);
  if (!/^[0-9]{1,15}$/.test(text)) {
    return undefined;
  }
  const value: number = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

function firstRow(result: CassandraResultLike): Record<string, unknown> | null {
  const row: unknown = result.rows[0];
  return typeof row === 'object' && row !== null
    ? (row as Record<string, unknown>)
    : null;
}

/** Whether a conditional statement took effect. */
function wasApplied(result: CassandraResultLike): boolean {
  return firstRow(result)?.['[applied]'] === true;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type Attempt =
  | { readonly kind: 'applied' }
  | { readonly kind: 'refused'; readonly revision: number | undefined }
  | { readonly kind: 'not_a_row' }
  | { readonly kind: 'failed'; readonly result: StoreResult<never> };

/**
 * A `StorageAdapter` over Cassandra. Each key is one row holding the value and a counter
 * revision. Every write is a lightweight transaction (`IF NOT EXISTS`, `IF revision = ?`,
 * `IF EXISTS`), which is what makes `ifRevision` atomic across processes: two writers
 * holding the same revision cannot both win, and the loser is told the revision that
 * beat it. A write without `ifRevision` replaces whatever is stored, retrying with the
 * revision the server reports until it lands. Reads use SERIAL consistency so they see
 * every committed write. Lightweight transactions cost several round trips each, so this
 * is for configuration-sized data, not high write rates. A key removed and written again
 * starts at revision 1. `list` scans the whole table. Nothing throws: every failure is
 * a `StoreResult`.
 */
export function cassandraAdapter(
  options: CassandraAdapterOptions
): StorageAdapter {
  const { client } = options;
  const table: string = options.table ?? DEFAULT_TABLE;
  const tableIsSafe: boolean = isSafeTableName(table);
  const createTable: boolean = options.createTable ?? true;
  const readConsistency: number =
    options.readConsistency === 'localSerial' ? LOCAL_SERIAL : SERIAL;
  const sql = statementsFor(table);
  let ready: Promise<void> | null = null;

  /** Creates the table once; a failure is not remembered, so the next call retries. */
  const prepare = (): Promise<void> => {
    if (!createTable) {
      return Promise.resolve();
    }
    if (ready === null) {
      ready = client
        .execute(sql.create ?? '', [], { prepare: true })
        .then(() => undefined);
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
    if (!tableIsSafe) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use table "${table}": use letters, digits and underscores, optionally as keyspace.table`
      );
    }
    if (key === '') {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        'cannot use an empty key: Cassandra does not allow an empty partition key'
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

  const run = (
    query: string | undefined,
    params: readonly unknown[],
    more: Omit<CassandraExecuteOptions, 'prepare'> = {}
  ): Promise<CassandraResultLike> =>
    client.execute(query ?? '', params, { prepare: true, ...more });

  /** Reads the row for a key at SERIAL consistency. */
  const readRow = async (
    key: string
  ): Promise<StoreResult<{ value: string; revision: number } | null>> => {
    try {
      await prepare();
      const row = firstRow(
        await run(sql.select, [key], { consistency: readConsistency })
      );
      if (row === null) {
        return { ok: true, value: null };
      }
      const revision: number | undefined = revisionNumber(row.revision);
      if (typeof row.entry_value !== 'string' || revision === undefined) {
        return sqlFailure(
          LABEL,
          'corrupt',
          key,
          'holds a row that is not a stored entry (it needs a text entry_value and a numeric revision; remove the key to start again)'
        );
      }
      return { ok: true, value: { value: row.entry_value, revision } };
    } catch (error: unknown) {
      return failedWith(error, key, 'read', table);
    }
  };

  /** Creates the row only if the key is free. */
  const insertRow = async (key: string, value: string): Promise<Attempt> => {
    try {
      await prepare();
      const now = new Date();
      const result = await run(sql.insert, [key, value, 1, now, now]);
      if (wasApplied(result)) {
        return { kind: 'applied' };
      }
      return {
        kind: 'refused',
        revision: revisionNumber(firstRow(result)?.revision),
      };
    } catch (error: unknown) {
      return {
        kind: 'failed',
        result: failedWith(error, key, 'written', table),
      };
    }
  };

  /** Replaces the row only if it still has this revision; the new revision is one more. */
  const updateRow = async (
    key: string,
    value: string,
    expected: number
  ): Promise<Attempt> => {
    try {
      await prepare();
      const result = await run(sql.update, [
        value,
        expected + 1,
        new Date(),
        key,
        expected,
      ]);
      if (wasApplied(result)) {
        return { kind: 'applied' };
      }
      const row = firstRow(result);
      // A refusal for a missing row carries nothing but `[applied]`.
      if (row === null || !('revision' in row)) {
        return { kind: 'not_a_row' };
      }
      return { kind: 'refused', revision: revisionNumber(row.revision) };
    } catch (error: unknown) {
      return {
        kind: 'failed',
        result: failedWith(error, key, 'written', table),
      };
    }
  };

  /** Reads these keys together; throws if that fails. */
  const readKeys = async (
    keys: readonly string[]
  ): Promise<ReadonlyMap<string, StoredValue>> => {
    await prepare();
    const result = await run(sql.many, [keys]);
    const found = new Map<string, StoredValue>();
    for (const row of result.rows) {
      const entry = row as Record<string, unknown> | null;
      const revision: number | undefined = revisionNumber(entry?.revision);
      if (
        typeof entry?.entry_key === 'string' &&
        typeof entry.entry_value === 'string' &&
        revision !== undefined
      ) {
        found.set(entry.entry_key, {
          value: entry.entry_value,
          revision: String(revision),
        });
      }
    }
    return found;
  };

  const poller = createChangePoller({
    intervalMs: options.pollIntervalMs,
    readKeys,
    onError: options.onPollError,
    describeFailure: (cause) =>
      `${LABEL} could not poll table "${table}" for changes (${cause})`,
  });

  const adapter = {
    async get(key, { signal }) {
      const refused = refusal<StoredValue | null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      const read = await readRow(key);
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
          'holds a row that is not a stored entry (it has no numeric revision; remove the key to start again)'
        );

      if (ifRevision !== undefined) {
        // A revision that is not a whole number can never match what is stored.
        const expected: number | undefined = /^[0-9]{1,15}$/.test(ifRevision)
          ? Number(ifRevision)
          : undefined;
        if (expected !== undefined && expected >= 1) {
          const attempt = await updateRow(key, value, expected);
          if (attempt.kind === 'applied') {
            return finish(expected + 1);
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
          const read = await readRow(key);
          if (!read.ok) {
            return read;
          }
          if (read.value !== null) {
            return conflict(read.value.revision);
          }
        }
        // Nothing is stored, so there is no revision to differ from: create it.
        const created = await insertRow(key, value);
        if (created.kind === 'applied') {
          return finish(1);
        }
        if (created.kind === 'failed') {
          return created.result;
        }
        return conflict(
          created.kind === 'refused' ? created.revision : undefined
        );
      }

      // Replace whatever is stored. Each refusal tells us the revision to try next.
      let known: number | null = null;
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        const outcome: Attempt =
          known === null
            ? await insertRow(key, value)
            : await updateRow(key, value, known);
        if (outcome.kind === 'applied') {
          return finish((known ?? 0) + 1);
        }
        if (outcome.kind === 'failed') {
          return outcome.result;
        }
        if (outcome.kind === 'refused') {
          if (outcome.revision === undefined) {
            return notAnEntry();
          }
          known = outcome.revision;
        } else {
          known = null; // The row was removed; create it.
        }
        if (attempt >= 1) {
          // Waiting a random moment keeps two writers from losing to each other forever.
          await pause(
            Math.floor(Math.random() * Math.min(MAX_BACKOFF_MS, 2 ** attempt))
          );
        }
      }
      return sqlFailure(
        LABEL,
        'conflict',
        key,
        `kept changing while it was being written (gave up after ${String(MAX_WRITE_ATTEMPTS)} tries)`
      );
    },

    async remove(key, { signal }) {
      const refused = refusal<null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      try {
        await prepare();
        await run(sql.remove, [key]);
      } catch (error: unknown) {
        return failedWith(error, key, 'removed', table);
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
      if (!tableIsSafe) {
        return prefixFailure(
          LABEL,
          'invalid',
          keyPrefix,
          `cannot use table "${table}": use letters, digits and underscores, optionally as keyspace.table`
        );
      }
      try {
        await prepare();
        const keys: string[] = [];
        let pageState: string | undefined;
        do {
          if (signal.aborted) {
            return prefixFailure(
              LABEL,
              'unavailable',
              keyPrefix,
              'request to list keys was aborted'
            );
          }
          const page = await run(sql.list, [], {
            fetchSize: LIST_PAGE_SIZE,
            ...(pageState === undefined ? {} : { pageState }),
          });
          for (const row of page.rows) {
            const name: unknown = (row as Record<string, unknown> | null)
              ?.entry_key;
            if (typeof name === 'string' && name.startsWith(keyPrefix)) {
              keys.push(name);
            }
          }
          pageState =
            typeof page.pageState === 'string' && page.pageState !== ''
              ? page.pageState
              : undefined;
        } while (pageState !== undefined);
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
    set: (key, value, options) =>
      poller.trackWrite(key, () => adapter.set(key, value, options)),
    remove: (key, options) =>
      poller.trackWrite(key, () => adapter.remove(key, options)),
  };
}
