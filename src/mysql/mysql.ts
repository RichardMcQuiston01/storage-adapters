/**
 * A `StorageAdapter` over MySQL (and MariaDB), for servers. Like `/sqlite`, this is
 * an optional entry point that imports no driver: you connect with `mysql2/promise`
 * or anything else whose `query(sql, parameters)` resolves `[result, ...]`, and
 * pass it in. Connect with the `utf8mb4` character set so emoji and other
 * four-byte characters survive.
 */
import { describeUnknownError } from '../errors.js';
import {
  createChangeListeners,
  isSafeTableName,
  revisionParameter,
  revisionText,
  sqlFailure,
} from '../sql-shared.js';
import {
  compareKeys,
  prefixFailure,
  utf8Length,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** The values a statement parameter can take here: keys, values and revisions. */
export type MysqlParameter = string | number | bigint | null;

/**
 * The subset of a client this adapter uses: `mysql2/promise`'s `Pool` or
 * `Connection`. `query` resolves `[result, fields]`; for a `SELECT` the result is
 * the array of rows, for a write it is the header with `insertId`. With a pool,
 * every statement may run on a different connection; that is fine, because the
 * adapter reads what it needs from each statement's own result.
 */
export interface MysqlClientLike {
  query(
    sql: string,
    parameters: MysqlParameter[]
  ): Promise<readonly [unknown, ...unknown[]]>;
}

export interface MysqlAdapterOptions {
  /** A connected client. The adapter never closes it. */
  readonly client: MysqlClientLike;
  /**
   * The table to use, created on first use if it is missing. Letters, digits and
   * underscores, with an optional `schema.` prefix. Defaults to `storage_entry`.
   */
  readonly table?: string;
}

const LABEL = 'MySQL';
const DEFAULT_TABLE = 'storage_entry';
/** Revisions are counters from 1, so this never matches a stored one. */
const NEVER_MATCHES = '0';
/** Keys are stored as 1024 bytes of binary, which compares exactly (case, spaces). */
const MAX_KEY_BYTES = 1024;
/** Creating the table can race another process doing the same; try again once. */
const MAX_SETUP_ATTEMPTS = 2;

interface Statements {
  readonly select: string;
  readonly upsert: string;
  readonly update: string;
  readonly insert: string;
  readonly selectRevision: string;
  readonly remove: string;
  readonly list: string;
}

/*
 * Schema: one row per key. `storage_entry_id` is a UUID kept as CHAR(36). The key
 * is VARBINARY so that 'A' and 'a', or 'a' and 'a ', are different keys whatever
 * the server's collation says. `revision` is a counter.
 *
 * MySQL has no RETURNING. Instead each write sets `revision = LAST_INSERT_ID(
 * revision + 1)`, which makes the server hand the new revision back as the
 * statement's own `insertId`. That belongs to this statement only, so it is safe
 * on a pool where the next statement may run on another connection.
 */
function statementsFor(table: string): {
  readonly create: string;
  readonly statements: Statements;
} {
  return {
    create: `CREATE TABLE IF NOT EXISTS ${table} (
  storage_entry_id CHAR(36) NOT NULL PRIMARY KEY,
  entry_key VARBINARY(${MAX_KEY_BYTES}) NOT NULL,
  entry_value LONGTEXT CHARACTER SET utf8mb4 NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY entry_key (entry_key)
)`,
    statements: {
      select: `SELECT entry_value, CAST(revision AS CHAR) AS revision FROM ${table} WHERE entry_key = ?`,
      // Creates the key (insertId 0) or bumps it (insertId is the new revision).
      upsert: `INSERT INTO ${table} (storage_entry_id, entry_key, entry_value)
VALUES (UUID(), ?, ?)
ON DUPLICATE KEY UPDATE
  entry_value = VALUES(entry_value),
  revision = LAST_INSERT_ID(revision + 1),
  updated_at = CURRENT_TIMESTAMP(3)`,
      // Bumps the key only if its revision matches: insertId is 0 when it did not.
      update: `UPDATE ${table} SET
  entry_value = ?,
  revision = LAST_INSERT_ID(revision + 1),
  updated_at = CURRENT_TIMESTAMP(3)
WHERE entry_key = ? AND revision = ?`,
      // Creates a key that had nothing stored; "duplicate entry" means it exists.
      insert: `INSERT INTO ${table} (storage_entry_id, entry_key, entry_value) VALUES (UUID(), ?, ?)`,
      selectRevision: `SELECT CAST(revision AS CHAR) AS revision FROM ${table} WHERE entry_key = ?`,
      remove: `DELETE FROM ${table} WHERE entry_key = ?`,
      // LIKE on the binary key, with '!' as the escape so the prefix's own % and _ are literal.
      list: `SELECT CONVERT(entry_key USING utf8mb4) AS entry_key FROM ${table} WHERE entry_key LIKE ? ESCAPE '!'`,
    },
  };
}

function fieldOf(error: unknown, field: 'errno' | 'code'): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

const ER_DUP_ENTRY = 1062;

function isDuplicateEntry(error: unknown): boolean {
  return (
    fieldOf(error, 'errno') === ER_DUP_ENTRY ||
    fieldOf(error, 'code') === 'ER_DUP_ENTRY'
  );
}

/** Maps a MySQL error number (or, failing that, its name) to an error code. */
function classifyError(error: unknown): StoreErrorCode {
  const errno: unknown = fieldOf(error, 'errno');
  const name: unknown = fieldOf(error, 'code');
  const message: string = describeUnknownError(error);
  const code: string = typeof name === 'string' ? name : '';
  if (
    errno === 1021 || // ER_DISK_FULL
    errno === 1114 || // ER_RECORD_FILE_FULL
    errno === 1153 || // ER_NET_PACKET_TOO_LARGE
    /^ER_(DISK_FULL|RECORD_FILE_FULL|NET_PACKET_TOO_LARGE)$/.test(code)
  ) {
    return 'quota';
  }
  if (
    errno === 1044 || // ER_DBACCESS_DENIED_ERROR
    errno === 1045 || // ER_ACCESS_DENIED_ERROR
    errno === 1142 || // ER_TABLEACCESS_DENIED_ERROR
    errno === 1143 || // ER_COLUMNACCESS_DENIED_ERROR
    errno === 1290 || // ER_OPTION_PREVENTS_STATEMENT (read-only server)
    errno === 1836 || // ER_READ_ONLY_MODE
    /^ER_(DBACCESS_DENIED_ERROR|ACCESS_DENIED_ERROR|TABLEACCESS_DENIED_ERROR|READ_ONLY_MODE)$/.test(
      code
    )
  ) {
    return 'forbidden';
  }
  if (
    errno === 1366 || // ER_TRUNCATED_WRONG_VALUE_FOR_FIELD (incorrect string value)
    errno === 1300 || // ER_INVALID_CHARACTER_STRING
    errno === 1406 || // ER_DATA_TOO_LONG
    /^ER_(TRUNCATED_WRONG_VALUE_FOR_FIELD|INVALID_CHARACTER_STRING|DATA_TOO_LONG)$/.test(
      code
    ) ||
    /incorrect string value/i.test(message)
  ) {
    return 'invalid';
  }
  return 'unavailable';
}

function failedWith<T>(
  error: unknown,
  key: string,
  verb: string
): StoreResult<T> {
  return sqlFailure(
    LABEL,
    classifyError(error),
    key,
    `could not be ${verb} (${describeUnknownError(error)})`
  );
}

/** The rows of a `SELECT`'s `[rows, fields]`, first row only. */
function firstRow(
  result: readonly [unknown, ...unknown[]]
): Record<string, unknown> | null {
  const rows: unknown = result[0];
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  return typeof row === 'object' && row !== null
    ? (row as Record<string, unknown>)
    : null;
}

/** The `insertId` of a write's `[header, ...]`: the new revision, or 0 if none. */
function insertIdOf(result: readonly [unknown, ...unknown[]]): string {
  const header: unknown = result[0];
  const id: unknown =
    typeof header === 'object' && header !== null
      ? (header as { insertId?: unknown }).insertId
      : undefined;
  return revisionText(id) ?? '0';
}

/**
 * A `StorageAdapter` over a MySQL or MariaDB table. Each key is a row with a
 * counter revision. `set` with `ifRevision` reports `conflict` when another
 * connection wrote first, and creates a key that has nothing stored. Each step is
 * one atomic statement. `subscribe` reports changes made through this adapter; it
 * does not listen for writes made by other processes. Keys can be up to 1024 bytes
 * of UTF-8. Nothing throws: every failure is a `StoreResult`.
 */
export function mysqlAdapter(options: MysqlAdapterOptions): StorageAdapter {
  const { client } = options;
  const table: string = options.table ?? DEFAULT_TABLE;
  const tableIsSafe: boolean = isSafeTableName(table);
  const sql = statementsFor(table);
  const listeners = createChangeListeners();
  let ready: Promise<void> | null = null;

  /** Creates the table once; a failure is not remembered, so the next call retries. */
  const prepare = (): Promise<void> => {
    if (ready === null) {
      ready = (async (): Promise<void> => {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < MAX_SETUP_ATTEMPTS; attempt += 1) {
          try {
            await client.query(sql.create, []);
            return;
          } catch (error: unknown) {
            lastError = error;
          }
        }
        throw lastError;
      })();
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  };

  /** Why this call cannot go ahead, or null if it can. */
  const refusal = <T>(
    key: string,
    signal: AbortSignal,
    checkKey: boolean
  ): StoreResult<T> | null => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    if (!tableIsSafe) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use table name "${table}": use letters, digits and underscores, with an optional schema prefix`
      );
    }
    if (checkKey && utf8Length(key) > MAX_KEY_BYTES) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot be stored: the key is longer than ${MAX_KEY_BYTES} bytes of UTF-8`
      );
    }
    return null;
  };

  const conflictFor = async (
    key: string,
    ifRevision: string
  ): Promise<StoreResult<StoredValue>> => {
    const current: string | undefined = revisionText(
      firstRow(await client.query(sql.statements.selectRevision, [key]))
        ?.revision
    );
    return sqlFailure(
      LABEL,
      'conflict',
      key,
      current === undefined
        ? `changed since revision ${ifRevision} was read`
        : `holds revision ${current}, but revision ${ifRevision} was expected`
    );
  };

  return {
    async get(key, { signal }) {
      const refused = refusal<StoredValue | null>(key, signal, false);
      if (refused !== null) {
        return refused;
      }
      try {
        await prepare();
        const row = firstRow(await client.query(sql.statements.select, [key]));
        if (row === null) {
          return { ok: true, value: null };
        }
        const revision: string | undefined = revisionText(row.revision);
        if (typeof row.entry_value !== 'string' || revision === undefined) {
          return sqlFailure(
            LABEL,
            'corrupt',
            key,
            'holds a row that is not a stored entry'
          );
        }
        return { ok: true, value: { value: row.entry_value, revision } };
      } catch (error: unknown) {
        return failedWith(error, key, 'read');
      }
    },

    async set(key, value, { signal, ifRevision }) {
      const refused = refusal<StoredValue>(key, signal, true);
      if (refused !== null) {
        return refused;
      }
      try {
        await prepare();
        let revision = '1';
        if (ifRevision === undefined) {
          const id: string = insertIdOf(
            await client.query(sql.statements.upsert, [key, value])
          );
          revision = id === '0' ? '1' : id;
        } else {
          const id: string = insertIdOf(
            await client.query(sql.statements.update, [
              value,
              key,
              revisionParameter(ifRevision, NEVER_MATCHES),
            ])
          );
          if (id !== '0') {
            revision = id;
          } else {
            // Nothing matched: either the key has nothing stored (create it) or it
            // holds another revision (a "duplicate entry" tells the two apart).
            try {
              await client.query(sql.statements.insert, [key, value]);
            } catch (error: unknown) {
              if (isDuplicateEntry(error)) {
                return await conflictFor(key, ifRevision);
              }
              throw error;
            }
          }
        }
        const stored: StoredValue = { value, revision };
        listeners.notify(key, stored);
        return { ok: true, value: stored };
      } catch (error: unknown) {
        return failedWith(error, key, 'written');
      }
    },

    async remove(key, { signal }) {
      const refused = refusal<null>(key, signal, false);
      if (refused !== null) {
        return refused;
      }
      try {
        await prepare();
        await client.query(sql.statements.remove, [key]);
      } catch (error: unknown) {
        return failedWith(error, key, 'removed');
      }
      listeners.notify(key, null);
      return { ok: true, value: null };
    },

    async list(prefix, { signal }) {
      if (signal.aborted) {
        return prefixFailure(
          LABEL,
          'unavailable',
          prefix,
          'request to list keys was aborted'
        );
      }
      if (!tableIsSafe) {
        return prefixFailure(
          LABEL,
          'invalid',
          prefix,
          `cannot use table name "${table}": use letters, digits and underscores, with an optional schema prefix`
        );
      }
      try {
        await prepare();
        const [rows] = await client.query(sql.statements.list, [
          `${prefix.replace(/[!%_]/g, '!$&')}%`,
        ]);
        const keys: string[] = [];
        for (const row of Array.isArray(rows) ? rows : []) {
          const key: unknown = (row as { entry_key?: unknown } | null)
            ?.entry_key;
          if (typeof key === 'string') {
            keys.push(key);
          }
        }
        return { ok: true, value: keys.sort(compareKeys) };
      } catch (error: unknown) {
        return prefixFailure(
          LABEL,
          classifyError(error),
          prefix,
          `could not list keys (${describeUnknownError(error)})`
        );
      }
    },

    subscribe: listeners.subscribe,
  };
}
