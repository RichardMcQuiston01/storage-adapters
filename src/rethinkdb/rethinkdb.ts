/**
 * A `StorageAdapter` over RethinkDB. Like `/postgres`, this is an optional entry point
 * that imports no driver: you connect with `rethinkdb-ts` and pass in its `r` and your
 * connection.
 */
import { describeUnknownError } from '../errors.js';
import { createChangeListeners, sqlFailure } from '../sql-shared.js';
import {
  compareKeys,
  prefixFailure,
  utf8Length,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** Anything you can `run`. A ReQL query from `rethinkdb-ts` fits. */
export interface ReqlQueryLike {
  run(connection?: unknown, options?: unknown): PromiseLike<unknown>;
}

/** A value inside a ReQL expression, such as the `row` a `replace` function is given. */
export interface ReqlDatumLike extends ReqlQueryLike {
  eq(value: unknown): ReqlDatumLike;
  getField(name: string): ReqlDatumLike;
  hasFields(...names: string[]): ReqlDatumLike;
  typeOf(): ReqlDatumLike;
  add(value: unknown): ReqlDatumLike;
  merge(value: unknown): ReqlDatumLike;
  and(...values: unknown[]): ReqlDatumLike;
}

/** One document, picked by its key. */
export interface ReqlSelectionLike extends ReqlQueryLike {
  replace(
    func: (row: ReqlDatumLike) => unknown,
    options?: { returnChanges?: boolean }
  ): ReqlQueryLike;
  delete(): ReqlQueryLike;
  /** Running this gives a cursor of `{ old_val, new_val }` changes. */
  changes(options?: { includeInitial?: boolean }): ReqlQueryLike;
}

export interface ReqlStreamLike extends ReqlQueryLike {
  /** Keeps only these fields of each document. */
  pluck(...fields: string[]): ReqlQueryLike;
}

export interface ReqlTableLike extends ReqlStreamLike {
  get(key: string): ReqlSelectionLike;
  between(
    low: unknown,
    high: unknown,
    options?: { leftBound?: 'open' | 'closed'; rightBound?: 'open' | 'closed' }
  ): ReqlStreamLike;
  wait(options?: { waitFor?: string }): ReqlQueryLike;
}

export interface ReqlDatabaseLike {
  table(name: string): ReqlTableLike;
  tableList(): ReqlQueryLike;
  tableCreate(name: string): ReqlQueryLike;
}

/** The part of `rethinkdb-ts`'s `r` this adapter calls. */
export interface ReqlBuilderLike {
  db(name: string): ReqlDatabaseLike;
  branch(test: unknown, whenTrue: unknown, whenFalse: unknown): ReqlDatumLike;
  error(message: string): unknown;
  readonly maxval: unknown;
  readonly minval: unknown;
}

/** What running a changefeed gives: something to read changes from, and to close. */
export interface ReqlCursorLike {
  each(
    callback: (error: Error | undefined, change: unknown) => unknown
  ): PromiseLike<unknown>;
  close(): PromiseLike<unknown>;
}

export interface RethinkDbAdapterOptions {
  /** `rethinkdb-ts`'s `r`. */
  readonly r: ReqlBuilderLike;
  /**
   * The connection (or connection pool) queries run on; leave it out to use the
   * driver's default pool. The adapter never closes it.
   */
  readonly connection?: unknown;
  /** The database that holds the table. It must exist. Defaults to `test`. */
  readonly db?: string;
  /** The table that holds the entries. Defaults to `storage_entry`. */
  readonly table?: string;
  /**
   * Create the table before first use if it is not there. Defaults to true. Turn it off
   * for an account that may read and write but not change the schema.
   */
  readonly createTable?: boolean;
  /** Called when a changefeed fails to start or stops, with a message naming the key. */
  readonly onWatchError?: (message: string) => void;
  /**
   * Milliseconds to wait before watching a key again after its changefeed fails or
   * ends, for as long as someone is subscribed to it. Defaults to 5000; `0` never retries.
   */
  readonly watchRetryMs?: number;
}

const LABEL = 'RethinkDB';
const DEFAULT_DB = 'test';
const DEFAULT_TABLE = 'storage_entry';
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** RethinkDB limits a primary key to 127 characters; bytes are the safe measure. */
const MAX_KEY_BYTES = 127;
const DEFAULT_RETRY_MS = 5000;
const MAX_REVISION_DIGITS = 15;
const CONFLICT_MARK = 'storage-adapters: revision mismatch';
const NOT_AN_ENTRY_MARK = 'storage-adapters: not an entry';
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * The smallest string greater than every string that starts with `prefix`, or `null`
 * if there is none (an empty prefix, or one made only of the highest code point).
 * RethinkDB compares strings by code point, so this is the open end of a prefix range.
 */
export function prefixUpperBound(prefix: string): string | null {
  const points: number[] = Array.from(
    prefix,
    (char) => char.codePointAt(0) ?? 0
  );
  while (points.length > 0 && points[points.length - 1] === 0x10ffff) {
    points.pop();
  }
  const last: number | undefined = points.pop();
  if (last === undefined) {
    return null;
  }
  // Skip the surrogate range, which is not text.
  points.push(last + 1 === 0xd800 ? 0xe000 : last + 1);
  return String.fromCodePoint(...points);
}

function classifyError(error: unknown): StoreErrorCode {
  const message: string = describeUnknownError(error);
  if (
    /auth|permission|not allowed|password|credentials|access denied/i.test(
      message
    )
  ) {
    return 'forbidden';
  }
  if (/too long|too large|exceeds/i.test(message)) {
    return 'invalid';
  }
  if (/no space|disk full|out of space/i.test(message)) {
    return 'quota';
  }
  return 'unavailable';
}

function failedWith<T>(
  error: unknown,
  key: string,
  verb: string,
  where: string
): StoreResult<T> {
  const message: string = describeUnknownError(error);
  let detail = `could not be ${verb} (${message})`;
  if (/does not exist/i.test(message)) {
    detail = `could not be ${verb} (${message}; check that ${where} exists)`;
  } else if (/ambiguous/i.test(message)) {
    detail = `could not be ${verb} (${message}; RethinkDB has two tables with this name, most likely because several processes created ${where} at the same moment, which RethinkDB cannot prevent: remove the duplicate, and create the table once before starting several processes)`;
  } else if (
    verb !== 'read' &&
    /closed|connection|timed out|timeout|ECONN|primary replica|not available/i.test(
      message
    )
  ) {
    detail = `could not be ${verb} (${message}); the write may or may not have been applied, so read the key to find out`;
  }
  return sqlFailure(LABEL, classifyError(error), key, detail);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A whole-number revision a document holds, or `undefined`. */
function revisionNumber(cell: unknown): number | undefined {
  return typeof cell === 'number' &&
    Number.isSafeInteger(cell) &&
    cell >= 1 &&
    String(cell).length <= MAX_REVISION_DIGITS
    ? cell
    : undefined;
}

/** The entry a document holds, or `undefined` if it is not one. */
function entryFrom(
  doc: unknown
): { value: string; revision: number } | undefined {
  const record = recordOf(doc);
  const revision: number | undefined = revisionNumber(record?.revision);
  return typeof record?.value === 'string' && revision !== undefined
    ? { value: record.value, revision }
    : undefined;
}

function sameStored(a: StoredValue | null, b: StoredValue | null): boolean {
  return a === null || b === null
    ? a === b
    : a.value === b.value && a.revision === b.revision;
}

interface Watching {
  count: number;
  stopped: boolean;
  stop: (() => void) | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  restarts: number;
}

/**
 * A `StorageAdapter` over RethinkDB. Each entry is one document in one table, with the
 * key as its primary key and a counter `revision`. Every write is a single `replace`
 * with a function, which RethinkDB applies atomically to the document: two writers
 * holding the same revision cannot both win, and the loser is told the revision that
 * beat it. A write without `ifRevision` replaces whatever is stored in one request. A
 * key removed and written again starts at revision 1. `subscribe` opens a changefeed on
 * the key, so it hears changes made by any process. `list` is a range query on the
 * primary key. Keys can be at most 127 bytes, RethinkDB's limit for a primary key.
 * Nothing throws: every failure is a `StoreResult`.
 */
export function rethinkDbAdapter(
  options: RethinkDbAdapterOptions
): StorageAdapter {
  const { r, connection, onWatchError } = options;
  const dbName: string = options.db ?? DEFAULT_DB;
  const tableName: string = options.table ?? DEFAULT_TABLE;
  const namesAreSafe: boolean =
    NAME_PATTERN.test(dbName) && NAME_PATTERN.test(tableName);
  const createTable: boolean = options.createTable ?? true;
  const retryMs: number = options.watchRetryMs ?? DEFAULT_RETRY_MS;
  const where = `table "${dbName}.${tableName}"`;
  const listeners = createChangeListeners();
  const lastSeen = new Map<string, StoredValue | null>();
  const watches = new Map<string, Watching>();
  let ready: Promise<void> | null = null;

  const table = (): ReqlTableLike => r.db(dbName).table(tableName);

  /** Creates the table once if it is not there; a failure is not remembered. */
  const prepare = (): Promise<void> => {
    if (!createTable) {
      return Promise.resolve();
    }
    if (ready === null) {
      ready = (async (): Promise<void> => {
        const existing: unknown = await r
          .db(dbName)
          .tableList()
          .run(connection);
        if (!Array.isArray(existing) || !existing.includes(tableName)) {
          try {
            await r.db(dbName).tableCreate(tableName).run(connection);
          } catch (error: unknown) {
            // Another process may have created it between the list and the create.
            if (!/already exists/i.test(describeUnknownError(error))) {
              throw error;
            }
          }
        }
        await table().wait({ waitFor: 'all_replicas_ready' }).run(connection);
      })();
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
    if (!namesAreSafe) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use database "${dbName}" and table "${tableName}": names may hold only letters, digits, _ and - (at most 64)`
      );
    }
    if (LONE_SURROGATE.test(key) || utf8Length(key) > MAX_KEY_BYTES) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use this key: it must be valid Unicode text of at most ${String(MAX_KEY_BYTES)} bytes, RethinkDB's limit for a primary key`
      );
    }
    return null;
  };

  /** Reads the document for a key. */
  const readDoc = async (
    key: string
  ): Promise<StoreResult<{ value: string; revision: number } | null>> => {
    try {
      await prepare();
      const doc: unknown = await table().get(key).run(connection);
      if (doc === null || doc === undefined) {
        return { ok: true, value: null };
      }
      const entry = entryFrom(doc);
      if (entry === undefined) {
        return sqlFailure(
          LABEL,
          'corrupt',
          key,
          'holds a document that is not a stored entry (it needs a text "value" and a whole-number "revision"; remove the key to start again)'
        );
      }
      return { ok: true, value: entry };
    } catch (error: unknown) {
      return failedWith(error, key, 'read', where);
    }
  };

  /** Tells subscribers about a write, removal or change unless they have already heard. */
  const settle = (key: string, stored: StoredValue | null): void => {
    if (!listeners.has(key)) {
      return;
    }
    if (lastSeen.has(key) && sameStored(lastSeen.get(key) ?? null, stored)) {
      return;
    }
    lastSeen.set(key, stored);
    listeners.notify(key, stored);
  };

  const reportWatchError = (
    key: string,
    action: string,
    error: unknown
  ): void => {
    try {
      onWatchError?.(
        `${LABEL} could not ${action} for key "${key}" (${describeUnknownError(error)})`
      );
    } catch {
      // A faulty error handler must not break the adapter.
    }
  };

  const handleChange = (key: string, change: unknown): void => {
    const newValue: unknown = recordOf(change)?.new_val;
    if (newValue === null || newValue === undefined) {
      settle(key, null);
      return;
    }
    const entry = entryFrom(newValue);
    if (entry !== undefined) {
      settle(key, { value: entry.value, revision: String(entry.revision) });
    }
  };

  /**
   * Compares the table with what subscribers were last told. The first time a key is
   * watched this only records where it stands, so the next change is reported against
   * something; after a changefeed restarts it also reports what changed while it was down.
   */
  const catchUp = async (key: string, restarted: boolean): Promise<void> => {
    const before: StoredValue | null | undefined = lastSeen.get(key);
    const read = await readDoc(key);
    if (!read.ok || lastSeen.get(key) !== before) {
      return; // Unreadable, or the changefeed has delivered something newer meanwhile.
    }
    const current: StoredValue | null =
      read.value === null
        ? null
        : { value: read.value.value, revision: String(read.value.revision) };
    if (!lastSeen.has(key)) {
      lastSeen.set(key, current);
    } else if (restarted) {
      settle(key, current);
    }
  };

  const startWatching = (key: string, state: Watching): void => {
    if (state.stopped) {
      return;
    }
    const restarted: boolean = state.restarts > 0;
    const run = async (): Promise<void> => {
      try {
        await prepare();
        const cursor = (await table()
          .get(key)
          .changes({ includeInitial: false })
          .run(connection)) as ReqlCursorLike;
        if (state.stopped) {
          await cursor.close();
          return;
        }
        state.stop = () => {
          void Promise.resolve(cursor.close()).catch(() => undefined);
        };
        void catchUp(key, restarted);
        let failure: Error | undefined;
        await cursor.each((error, change) => {
          if (error !== undefined) {
            failure = error;
            return false;
          }
          try {
            handleChange(key, change);
          } catch (caught: unknown) {
            reportWatchError(key, 'read a change', caught);
          }
          return true;
        });
        if (failure !== undefined && !state.stopped) {
          reportWatchError(key, 'watch', failure);
        }
      } catch (error: unknown) {
        if (!state.stopped) {
          reportWatchError(key, 'watch', error);
        }
      }
      state.stop = null;
      if (!state.stopped && retryMs > 0) {
        state.restarts += 1;
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          startWatching(key, state);
        }, retryMs);
        // A pending retry alone should not keep a Node-style process running.
        (state.retryTimer as { unref?: () => void }).unref?.();
      }
    };
    void run();
  };

  /** Says what a `replace` answered: `null` if it worked, else why not. */
  const writeProblem = (
    result: unknown
  ): {
    readonly kind: 'conflict' | 'corrupt' | 'failed';
    readonly text: string;
  } | null => {
    const record = recordOf(result);
    const errors: unknown = record?.errors;
    if (typeof errors === 'number' && errors > 0) {
      const text: string =
        typeof record?.first_error === 'string'
          ? record.first_error
          : 'unknown error';
      if (text.includes(CONFLICT_MARK)) {
        return { kind: 'conflict', text };
      }
      if (text.includes(NOT_AN_ENTRY_MARK)) {
        return { kind: 'corrupt', text };
      }
      return { kind: 'failed', text };
    }
    return record === null ? { kind: 'failed', text: 'no answer' } : null;
  };

  /** The revision a `replace` with `returnChanges` wrote. */
  const writtenRevision = (result: unknown): number | undefined => {
    const changes: unknown = recordOf(result)?.changes;
    const first: unknown = Array.isArray(changes) ? changes[0] : undefined;
    return revisionNumber(recordOf(recordOf(first)?.new_val)?.revision);
  };

  const adapter = {
    async get(key, { signal }) {
      const refused = refusal<StoredValue | null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      const read = await readDoc(key);
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
      // A revision that is not a whole number can never match what is stored.
      const expected: number | null | undefined =
        ifRevision === undefined
          ? undefined
          : /^[0-9]{1,15}$/.test(ifRevision) && Number(ifRevision) >= 1
            ? Number(ifRevision)
            : null;
      const now = new Date();
      const fresh = {
        id: key,
        value,
        revision: 1,
        created_at: now,
        updated_at: now,
      };
      try {
        await prepare();
        const result: unknown = await table()
          .get(key)
          .replace(
            (row) =>
              r.branch(
                row.eq(null),
                fresh,
                r.branch(
                  expected === undefined
                    ? row
                        .hasFields('revision')
                        .and(row.getField('revision').typeOf().eq('NUMBER'))
                    : expected === null
                      ? false
                      : row.getField('revision').eq(expected),
                  row.merge({
                    value,
                    revision: row.getField('revision').add(1),
                    updated_at: now,
                  }),
                  r.error(
                    expected === undefined ? NOT_AN_ENTRY_MARK : CONFLICT_MARK
                  )
                )
              ),
            { returnChanges: true }
          )
          .run(connection);
        const problem = writeProblem(result);
        if (problem !== null) {
          if (problem.kind === 'conflict') {
            const holds = await readDoc(key);
            return sqlFailure(
              LABEL,
              'conflict',
              key,
              holds.ok && holds.value !== null
                ? `holds revision ${String(holds.value.revision)}, but revision ${ifRevision ?? ''} was expected`
                : `changed while it was being written, so revision ${ifRevision ?? ''} no longer applies`
            );
          }
          if (problem.kind === 'corrupt') {
            return sqlFailure(
              LABEL,
              'corrupt',
              key,
              'holds a document that is not a stored entry (it has no whole-number revision; remove the key to start again)'
            );
          }
          return failedWith(new Error(problem.text), key, 'written', where);
        }
        const revision: number | undefined = writtenRevision(result);
        if (revision === undefined) {
          return sqlFailure(
            LABEL,
            'corrupt',
            key,
            'answered a write without saying which revision it wrote'
          );
        }
        const stored: StoredValue = { value, revision: String(revision) };
        settle(key, stored);
        return { ok: true, value: stored };
      } catch (error: unknown) {
        return failedWith(error, key, 'written', where);
      }
    },

    async remove(key, { signal }) {
      const refused = refusal<null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      try {
        await prepare();
        const result: unknown = await table().get(key).delete().run(connection);
        const problem = writeProblem(result);
        if (problem !== null) {
          return failedWith(new Error(problem.text), key, 'removed', where);
        }
      } catch (error: unknown) {
        return failedWith(error, key, 'removed', where);
      }
      settle(key, null);
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
      if (!namesAreSafe) {
        return prefixFailure(
          LABEL,
          'invalid',
          keyPrefix,
          `cannot use database "${dbName}" and table "${tableName}": names may hold only letters, digits, _ and - (at most 64)`
        );
      }
      if (LONE_SURROGATE.test(keyPrefix)) {
        return prefixFailure(
          LABEL,
          'invalid',
          keyPrefix,
          'cannot use this prefix: it must be valid Unicode text'
        );
      }
      try {
        await prepare();
        const upper: string | null = prefixUpperBound(keyPrefix);
        const range = table().between(keyPrefix, upper ?? r.maxval);
        const docs: unknown = await range.pluck('id').run(connection);
        const keys: string[] = [];
        for (const doc of Array.isArray(docs) ? (docs as unknown[]) : []) {
          const id: unknown = recordOf(doc)?.id;
          if (typeof id === 'string' && id.startsWith(keyPrefix)) {
            keys.push(id);
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
      const unsubscribe: () => void = listeners.subscribe(key, onChange);
      let state: Watching | undefined = watches.get(key);
      if (state === undefined) {
        state = {
          count: 0,
          stopped: false,
          stop: null,
          retryTimer: null,
          restarts: 0,
        };
        watches.set(key, state);
        startWatching(key, state);
      }
      state.count += 1;
      const mine: Watching = state;
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        unsubscribe();
        mine.count -= 1;
        if (mine.count > 0) {
          return;
        }
        mine.stopped = true;
        watches.delete(key);
        lastSeen.delete(key);
        if (mine.retryTimer !== null) {
          clearTimeout(mine.retryTimer);
          mine.retryTimer = null;
        }
        try {
          mine.stop?.();
        } catch (error: unknown) {
          reportWatchError(key, 'stop watching', error);
        }
      };
    },
  } satisfies StorageAdapter;

  return adapter;
}
