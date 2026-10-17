/**
 * A `StorageAdapter` over PostgreSQL, for servers. Like `/sqlite`, this is an
 * optional entry point that imports no driver: you connect with `pg`, `PGlite` or
 * anything else with a `query(sql, parameters)` that resolves `{ rows }`, and pass
 * it in.
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
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** The values a statement parameter can take here: keys, values and revisions. */
export type PostgresParameter = string | number | bigint | null;

/** What a query resolves: the rows it returned, if any. */
export interface PostgresResultLike {
  readonly rows: readonly unknown[];
}

/**
 * The subset of a client this adapter uses: `pg`'s `Pool` or `Client`, or PGlite.
 * With a pool, every statement may run on a different connection; that is fine,
 * because each write is a single statement.
 */
export interface PostgresClientLike {
  query(
    sql: string,
    parameters: PostgresParameter[]
  ): Promise<PostgresResultLike>;
}

export interface PostgresAdapterOptions {
  /** A connected client. The adapter never closes it. */
  readonly client: PostgresClientLike;
  /**
   * The table to use, created on first use if it is missing. Letters, digits and
   * underscores, with an optional `schema.` prefix. Defaults to `storage_entry`.
   */
  readonly table?: string;
}

const LABEL = 'Postgres';
const DEFAULT_TABLE = 'storage_entry';
/** Revisions are counters from 1, so this never matches a stored one. */
const NEVER_MATCHES = '-1';
/** A conditional write is retried this many times if its row keeps vanishing. */
const MAX_WRITE_ATTEMPTS = 3;
/** Creating the table can race another process doing the same; try again once. */
const MAX_SETUP_ATTEMPTS = 2;

interface Statements {
  readonly select: string;
  readonly upsert: string;
  readonly upsertIfRevision: string;
  readonly selectRevision: string;
  readonly remove: string;
  readonly list: string;
}

/*
 * Schema: one row per key. `storage_entry_id` is a native UUID made by the server
 * (`gen_random_uuid`, PostgreSQL 13 and later). `revision` is a counter.
 */
function statementsFor(table: string): {
  readonly create: string;
  readonly statements: Statements;
} {
  const upsert = `INSERT INTO ${table} (entry_key, entry_value)
VALUES ($1, $2)
ON CONFLICT (entry_key) DO UPDATE SET
  entry_value = EXCLUDED.entry_value,
  revision = ${table}.revision + 1,
  updated_at = now()`;
  return {
    create: `CREATE TABLE IF NOT EXISTS ${table} (
  storage_entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_key text NOT NULL UNIQUE,
  entry_value text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
    statements: {
      select: `SELECT entry_value, revision::text AS revision FROM ${table} WHERE entry_key = $1`,
      // The check and the write are one statement, so another connection cannot
      // slip in between them. A key with nothing stored is simply created.
      upsert: `${upsert}\nRETURNING revision::text AS revision`,
      upsertIfRevision: `${upsert}\nWHERE ${table}.revision = $3::bigint\nRETURNING revision::text AS revision`,
      selectRevision: `SELECT revision::text AS revision FROM ${table} WHERE entry_key = $1`,
      remove: `DELETE FROM ${table} WHERE entry_key = $1`,
      // Compared as text with left(), so the prefix's characters are never wildcards.
      list: `SELECT entry_key FROM ${table} WHERE left(entry_key, char_length($1::text)) = $1::text`,
    },
  };
}

function sqlStateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Maps an SQLSTATE (or a message, for drivers that do not give one) to a code. */
function classifyError(error: unknown): StoreErrorCode {
  const state: string | null = sqlStateOf(error);
  const message: string = describeUnknownError(error);
  if (state === '53100' || /no space left|disk full/i.test(message)) {
    return 'quota';
  }
  if (
    state === '42501' || // insufficient_privilege
    state === '25006' || // read_only_sql_transaction
    state?.startsWith('28') === true || // invalid_authorization_specification
    /permission denied|read-only transaction/i.test(message)
  ) {
    return 'forbidden';
  }
  if (
    state === '22021' || // character_not_in_repertoire (for example a NUL)
    state === '22P05' || // untranslatable_character
    state === '22001' // string_data_right_truncation
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

function firstRow(result: PostgresResultLike): Record<string, unknown> | null {
  const row: unknown = Array.isArray(result.rows) ? result.rows[0] : undefined;
  return typeof row === 'object' && row !== null
    ? (row as Record<string, unknown>)
    : null;
}

/**
 * A `StorageAdapter` over a PostgreSQL table. Each key is a row with a counter
 * revision. The revision check and the write are one `INSERT ... ON CONFLICT ...
 * WHERE ... RETURNING` statement, so `set` with `ifRevision` reports `conflict`
 * when another connection wrote first, and a key with nothing stored is created.
 * `subscribe` reports changes made through this adapter; it does not listen for
 * writes made by other processes. Nothing throws: every failure is a `StoreResult`.
 */
export function postgresAdapter(
  options: PostgresAdapterOptions
): StorageAdapter {
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
        `cannot use table name "${table}": use letters, digits and underscores, with an optional schema prefix`
      );
    }
    return null;
  };

  return {
    async get(key, { signal }) {
      const refused = refusal<StoredValue | null>(key, signal);
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
      const refused = refusal<StoredValue>(key, signal);
      if (refused !== null) {
        return refused;
      }
      try {
        await prepare();
        for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
          const result: PostgresResultLike =
            ifRevision === undefined
              ? await client.query(sql.statements.upsert, [key, value])
              : await client.query(sql.statements.upsertIfRevision, [
                  key,
                  value,
                  revisionParameter(ifRevision, NEVER_MATCHES),
                ]);
          const revision: string | undefined = revisionText(
            firstRow(result)?.revision
          );
          if (revision !== undefined) {
            const stored: StoredValue = { value, revision };
            listeners.notify(key, stored);
            return { ok: true, value: stored };
          }
          // No row came back: the revision did not match. Say what it is now.
          const current: string | undefined = revisionText(
            firstRow(await client.query(sql.statements.selectRevision, [key]))
              ?.revision
          );
          if (current !== undefined) {
            return sqlFailure(
              LABEL,
              'conflict',
              key,
              `holds revision ${current}, but revision ${ifRevision ?? ''} was expected`
            );
          }
          // The row was removed in between, so the write can now go in as new.
        }
        return sqlFailure(
          LABEL,
          'unavailable',
          key,
          'changed too often to be written'
        );
      } catch (error: unknown) {
        return failedWith(error, key, 'written');
      }
    },

    async remove(key, { signal }) {
      const refused = refusal<null>(key, signal);
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
        const result = await client.query(sql.statements.list, [prefix]);
        const keys: string[] = [];
        for (const row of Array.isArray(result.rows) ? result.rows : []) {
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
