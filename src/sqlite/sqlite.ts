/**
 * A `StorageAdapter` over SQLite, for server-side and desktop use. Like `/browser`
 * and `/indexeddb`, this is an optional entry point: the core stays free of I/O,
 * and this file imports no driver. You open the database with `node:sqlite`,
 * `bun:sqlite` or any driver with the same small surface, and pass it in.
 */
import { describeUnknownError } from '../errors.js';
import {
  compareKeys,
  prefixFailure,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** The values a statement parameter can take here: keys, values and revisions. */
export type SqliteParameter = string | number | bigint | null;

/** The subset of a prepared statement this adapter uses. */
export interface SqliteStatementLike {
  run(...parameters: SqliteParameter[]): unknown;
  /** Resolves the first row, or `undefined` / `null` when there is none. */
  get(...parameters: SqliteParameter[]): unknown;
  /**
   * Optional: resolves every row. `node:sqlite` and `bun:sqlite` both have it. Without
   * it `list` reports that it is not supported.
   */
  all?(...parameters: SqliteParameter[]): unknown[];
}

/** The subset of a database this adapter uses (`DatabaseSync`, `bun:sqlite`'s `Database`). */
export interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatementLike;
}

export interface SqliteAdapterOptions {
  /** An open database. The adapter never closes it. */
  readonly database: SqliteDatabaseLike;
}

/*
 * Schema: one row per key. `storage_entry_id` is a random UUID (v4) made by SQLite
 * itself, so no crypto global is needed. Timestamps are UTC ISO-8601 text.
 */
const UUID_SQL =
  "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || " +
  "substr(hex(randomblob(2)), 2) || '-' || " +
  "substr('89ab', abs(random()) % 4 + 1, 1) || " +
  "substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))";
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS storage_entry (
  storage_entry_id TEXT PRIMARY KEY NOT NULL,
  entry_key TEXT NOT NULL UNIQUE,
  entry_value TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const SELECT_SQL =
  'SELECT entry_value, revision FROM storage_entry WHERE entry_key = ?';

/**
 * Writes the value and bumps the revision in one statement, so the check and the
 * write cannot be split by another connection. A non-numeric revision counts as 0,
 * matching the other adapters. Parameters: key, value.
 */
const UPSERT_SQL = `INSERT INTO storage_entry
  (storage_entry_id, entry_key, entry_value, revision, created_at, updated_at)
VALUES (${UUID_SQL}, ?, ?, '1', ${NOW_SQL}, ${NOW_SQL})
ON CONFLICT (entry_key) DO UPDATE SET
  entry_value = excluded.entry_value,
  revision = CAST(CAST(storage_entry.revision AS INTEGER) + 1 AS TEXT),
  updated_at = excluded.updated_at
RETURNING revision`;

/** Same, but only updates an existing row whose revision matches. Adds: ifRevision. */
const UPSERT_IF_REVISION_SQL = UPSERT_SQL.replace(
  'RETURNING revision',
  'WHERE storage_entry.revision = ?\nRETURNING revision'
);

const SELECT_REVISION_SQL =
  'SELECT revision FROM storage_entry WHERE entry_key = ?';
/** Keys that start with the prefix, compared as text (no LIKE, so no wildcards). Parameters: prefix twice. */
const LIST_SQL =
  'SELECT entry_key FROM storage_entry WHERE substr(entry_key, 1, length(?)) = ?';
const DELETE_SQL = 'DELETE FROM storage_entry WHERE entry_key = ?';

/** A conditional write is retried this many times if its row keeps vanishing. */
const MAX_WRITE_ATTEMPTS = 3;

interface Statements {
  readonly select: SqliteStatementLike;
  readonly upsert: SqliteStatementLike;
  readonly upsertIfRevision: SqliteStatementLike;
  readonly selectRevision: SqliteStatementLike;
  readonly remove: SqliteStatementLike;
}

/** SQLite's primary result codes that map to something other than `unavailable`. */
const SQLITE_PERM = 3;
const SQLITE_READONLY = 8;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_AUTH = 23;
const SQLITE_NOTADB = 26;

function resultCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const fields = error as { errcode?: unknown; errno?: unknown };
  const code: unknown = fields.errcode ?? fields.errno;
  // Extended result codes keep the primary code in the low byte.
  return typeof code === 'number' ? code & 0xff : null;
}

function classifyError(error: unknown): StoreErrorCode {
  const code: number | null = resultCodeOf(error);
  const message: string = describeUnknownError(error);
  if (code === SQLITE_FULL || /database or disk is full/i.test(message)) {
    return 'quota';
  }
  if (
    code === SQLITE_READONLY ||
    code === SQLITE_PERM ||
    code === SQLITE_AUTH ||
    /readonly database/i.test(message)
  ) {
    return 'forbidden';
  }
  if (
    code === SQLITE_CORRUPT ||
    code === SQLITE_NOTADB ||
    /malformed|not a database/i.test(message)
  ) {
    return 'corrupt';
  }
  return 'unavailable';
}

function failure<T>(
  code: StoreErrorCode,
  key: string,
  detail: string
): StoreResult<T> {
  return { ok: false, code, error: `SQLite ${detail} for key "${key}"` };
}

function failedWith<T>(
  error: unknown,
  key: string,
  verb: string
): StoreResult<T> {
  return failure(
    classifyError(error),
    key,
    `could not be ${verb} (${describeUnknownError(error)})`
  );
}

function revisionOf(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) {
    return undefined;
  }
  const revision: unknown = (row as { revision?: unknown }).revision;
  return typeof revision === 'string' ? revision : undefined;
}

/**
 * A `StorageAdapter` over a SQLite database. Each key is a row with a counter
 * revision. The revision check and the write are one statement, so `set` with
 * `ifRevision` reports `conflict` when another connection wrote first. The table
 * `storage_entry` is created on first use. `subscribe` reports changes made
 * through this adapter, like `memoryAdapter`; SQLite cannot announce writes made
 * by other processes. Nothing throws: every failure is a `StoreResult`.
 */
export function sqliteAdapter(options: SqliteAdapterOptions): StorageAdapter {
  const { database } = options;
  const listeners = new Map<
    string,
    Set<(stored: StoredValue | null) => void>
  >();
  let statements: Statements | null = null;

  /** Creates the table and prepares the statements once; a failure is retried. */
  const prepare = (): Statements => {
    if (statements === null) {
      database.exec(CREATE_TABLE_SQL);
      statements = {
        select: database.prepare(SELECT_SQL),
        upsert: database.prepare(UPSERT_SQL),
        upsertIfRevision: database.prepare(UPSERT_IF_REVISION_SQL),
        selectRevision: database.prepare(SELECT_REVISION_SQL),
        remove: database.prepare(DELETE_SQL),
      };
    }
    return statements;
  };

  const stopped = <T>(
    key: string,
    signal: AbortSignal
  ): StoreResult<T> | null =>
    signal.aborted ? failure('unavailable', key, 'request was aborted') : null;

  const notify = (key: string, stored: StoredValue | null): void => {
    for (const listener of listeners.get(key) ?? []) {
      try {
        listener(stored);
      } catch {
        // A faulty listener must not turn a successful write into a failure.
      }
    }
  };

  return {
    get(key, { signal }) {
      const abortedResult = stopped<StoredValue | null>(key, signal);
      if (abortedResult !== null) {
        return Promise.resolve(abortedResult);
      }
      try {
        const row: unknown = prepare().select.get(key);
        if (row === undefined || row === null) {
          return Promise.resolve({ ok: true, value: null });
        }
        const fields = row as { entry_value?: unknown; revision?: unknown };
        if (
          typeof fields.entry_value !== 'string' ||
          typeof fields.revision !== 'string'
        ) {
          return Promise.resolve(
            failure('corrupt', key, 'holds a row that is not a stored entry')
          );
        }
        return Promise.resolve({
          ok: true,
          value: { value: fields.entry_value, revision: fields.revision },
        });
      } catch (error: unknown) {
        return Promise.resolve(failedWith(error, key, 'read'));
      }
    },

    set(key, value, { signal, ifRevision }) {
      const abortedResult = stopped<StoredValue>(key, signal);
      if (abortedResult !== null) {
        return Promise.resolve(abortedResult);
      }
      try {
        const ready: Statements = prepare();
        for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
          const row: unknown =
            ifRevision === undefined
              ? ready.upsert.get(key, value)
              : ready.upsertIfRevision.get(key, value, ifRevision);
          const revision: string | undefined = revisionOf(row);
          if (revision !== undefined) {
            const stored: StoredValue = { value, revision };
            notify(key, stored);
            return Promise.resolve({ ok: true, value: stored });
          }
          // No row came back: the revision did not match. Say what it is now.
          const current: string | undefined = revisionOf(
            ready.selectRevision.get(key)
          );
          if (current !== undefined) {
            return Promise.resolve(
              failure(
                'conflict',
                key,
                `holds revision ${current}, but revision ${ifRevision ?? ''} was expected`
              )
            );
          }
          // The row was removed in between, so the write can now go in as new.
        }
        return Promise.resolve(
          failure('unavailable', key, 'changed too often to be written')
        );
      } catch (error: unknown) {
        return Promise.resolve(failedWith(error, key, 'written'));
      }
    },

    remove(key, { signal }) {
      const abortedResult = stopped<null>(key, signal);
      if (abortedResult !== null) {
        return Promise.resolve(abortedResult);
      }
      try {
        prepare().remove.run(key);
      } catch (error: unknown) {
        return Promise.resolve(failedWith(error, key, 'removed'));
      }
      notify(key, null);
      return Promise.resolve({ ok: true, value: null });
    },

    list(prefix, { signal }) {
      if (signal.aborted) {
        return Promise.resolve(
          prefixFailure(
            'SQLite',
            'unavailable',
            prefix,
            'request to list keys was aborted'
          )
        );
      }
      try {
        prepare();
        const statement: SqliteStatementLike = database.prepare(LIST_SQL);
        if (statement.all === undefined) {
          return Promise.resolve(
            prefixFailure(
              'SQLite',
              'invalid',
              prefix,
              'cannot list keys: the statement has no all() method'
            )
          );
        }
        const keys: string[] = [];
        for (const row of statement.all(prefix, prefix)) {
          const key: unknown = (row as { entry_key?: unknown } | null)
            ?.entry_key;
          if (typeof key === 'string') {
            keys.push(key);
          }
        }
        return Promise.resolve({ ok: true, value: keys.sort(compareKeys) });
      } catch (error: unknown) {
        return Promise.resolve(
          prefixFailure(
            'SQLite',
            classifyError(error),
            prefix,
            `could not list keys (${describeUnknownError(error)})`
          )
        );
      }
    },

    subscribe(key, onChange) {
      const set: Set<(stored: StoredValue | null) => void> =
        listeners.get(key) ?? new Set();
      set.add(onChange);
      listeners.set(key, set);
      return () => {
        set.delete(onChange);
        if (set.size === 0) {
          listeners.delete(key);
        }
      };
    },
  };
}
