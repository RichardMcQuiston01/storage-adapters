/**
 * A `StorageAdapter` over Supabase, for apps that already run on it. Supabase is
 * PostgreSQL behind PostgREST, so the table and the atomic revision check of
 * `/postgres` carry over; this adapter reaches them through the `supabase-js`
 * client (`from`, `rpc` and Realtime) instead of a direct connection. Like the other
 * optional entry points it imports no SDK: you create the client and pass it in.
 * Run `supabaseSetupSql()` once (in the SQL editor or a migration) to create the
 * table and the two functions it calls. Row-level security stays your job.
 */
import { describeUnknownError } from '../errors.js';
import {
  createChangeListeners,
  revisionParameter,
  revisionText,
  sqlFailure,
} from '../sql-shared.js';
import {
  compareKeys,
  keysWithPrefix,
  prefixFailure,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/* ------------------------------------------------------------------ */
/* The client this adapter talks to                                    */
/* ------------------------------------------------------------------ */

/** A PostgREST error, as `supabase-js` reports it. */
export interface SupabaseErrorLike {
  readonly message: string;
  readonly code?: string;
  readonly details?: string | null;
  readonly hint?: string | null;
}

/** What a `supabase-js` query resolves: the rows or an error, never both. */
export interface SupabaseResultLike {
  readonly data: unknown;
  readonly error: SupabaseErrorLike | null;
  readonly status?: number;
}

/** A query builder from `supabase-js`: chain filters, then `await` it. */
export interface SupabaseQueryLike extends PromiseLike<SupabaseResultLike> {
  eq(column: string, value: string): SupabaseQueryLike;
  range(from: number, to: number): SupabaseQueryLike;
  maybeSingle(): PromiseLike<SupabaseResultLike>;
}

export interface SupabaseTableLike {
  select(columns: string): SupabaseQueryLike;
  delete(): SupabaseQueryLike;
}

/** A change delivered by Realtime `postgres_changes`. */
export interface SupabaseChangeLike {
  readonly eventType: string;
  readonly new: Readonly<Record<string, unknown>>;
  readonly old: Readonly<Record<string, unknown>>;
}

/** A Realtime channel from `supabase-js`. */
export interface SupabaseChannelLike {
  on(
    type: 'postgres_changes',
    filter: { event: '*'; schema: string; table: string },
    callback: (payload: SupabaseChangeLike) => void
  ): SupabaseChannelLike;
  subscribe(
    callback?: (status: string, error?: Error) => void
  ): SupabaseChannelLike;
}

/**
 * The subset of the `supabase-js` client this adapter uses. What `from`, `rpc` and
 * `channel` return is typed `unknown` on purpose: the real builders are generic types
 * so deep that TypeScript cannot compare them with a hand-written one. The adapter
 * uses them as `SupabaseTableLike`, `SupabaseQueryLike` and `SupabaseChannelLike`,
 * which the real ones satisfy; a client of your own must return those shapes.
 */
export interface SupabaseClientLike {
  from(table: string): unknown;
  rpc(functionName: string, args: Record<string, unknown>): unknown;
  channel(name: string): unknown;
  removeChannel(channel: never): PromiseLike<unknown>;
}

export interface SupabaseAdapterOptions {
  /** A client from `createClient(url, key)`. The adapter never signs out or closes it. */
  readonly client: SupabaseClientLike;
  /**
   * The table made by `supabaseSetupSql`; its functions are `<table>_set` and
   * `<table>_list`. Letters, digits and underscores. Defaults to `storage_entry`.
   */
  readonly table?: string;
  /** The schema the table is in, for Realtime. Defaults to `public`. */
  readonly schema?: string;
  /**
   * Called when the Realtime channel `subscribe` opened fails or reports something
   * it cannot use (the table is not in the `supabase_realtime` publication, or a
   * delete arrives without its key). Writes made through this adapter are still
   * reported.
   */
  readonly onWatchError?: (message: string) => void;
}

/* ------------------------------------------------------------------ */
/* The setup SQL                                                       */
/* ------------------------------------------------------------------ */

const LABEL = 'Supabase';
const DEFAULT_TABLE = 'storage_entry';
const DEFAULT_SCHEMA = 'public';
/** Revisions are counters from 1, so this never matches a stored one. */
const NEVER_MATCHES = '-1';
/** A conditional write is retried this many times if its row keeps vanishing. */
const MAX_WRITE_ATTEMPTS = 3;
/** Rows asked for per request when listing; the server may return fewer. */
const LIST_PAGE_SIZE = 1000;

function isSafeIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * The SQL that sets a project up for `supabaseAdapter`: the table (one row per key,
 * with a UUID id, a counter `revision` and timestamps), row-level security turned on
 * with no policies, the key's unique index as the replica identity (so that Realtime
 * can say which key a delete was for, and tells subscribers nothing but the key:
 * Realtime does not apply row-level security to deletes), the table in the
 * `supabase_realtime` publication, and two functions
 * called through `rpc`: `<table>_set`, which checks the revision and writes in one
 * statement, and `<table>_list`. Safe to run again. Add the policies you want, or
 * use the service-role key on a server (which bypasses them).
 */
export function supabaseSetupSql(
  options: { readonly table?: string; readonly schema?: string } = {}
): string {
  const table: string = options.table ?? DEFAULT_TABLE;
  const schema: string = options.schema ?? DEFAULT_SCHEMA;
  if (!isSafeIdentifier(table) || !isSafeIdentifier(schema)) {
    throw new Error(
      `Supabase setup SQL cannot use table "${table}" in schema "${schema}": use letters, digits and underscores`
    );
  }
  const qualified = `${schema}.${table}`;
  return `create table if not exists ${qualified} (
  storage_entry_id uuid primary key default gen_random_uuid(),
  entry_key text not null constraint ${table}_entry_key_key unique,
  entry_value text not null,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table ${qualified} enable row level security;
alter table ${qualified} replica identity using index ${table}_entry_key_key;

-- Writes the value and returns 'written' with the new revision. With p_if_revision,
-- a row at another revision is left alone and 'conflict' comes back with the revision
-- it holds; a key with nothing stored is created. One statement, so two writers
-- holding the same revision cannot both win.
create or replace function ${qualified}_set(
  p_key text,
  p_value text,
  p_if_revision bigint default null
)
returns table (outcome text, current_revision bigint)
language plpgsql
set search_path = ''
as $$
begin
  return query
    insert into ${qualified} as e (entry_key, entry_value)
    values (p_key, p_value)
    on conflict (entry_key) do update
      set entry_value = excluded.entry_value,
          revision = e.revision + 1,
          updated_at = now()
      where p_if_revision is null or e.revision = p_if_revision
    returning 'written'::text, e.revision;
  if not found then
    return query
      select 'conflict'::text, t.revision
      from ${qualified} t
      where t.entry_key = p_key;
  end if;
end;
$$;

-- The keys that start with p_prefix, compared as plain text (no LIKE patterns), in
-- byte order so that paging through them is stable.
create or replace function ${qualified}_list(p_prefix text)
returns table (entry_key text)
language sql
stable
set search_path = ''
as $$
  select t.entry_key
  from ${qualified} t
  where left(t.entry_key, char_length(p_prefix)) = p_prefix
  order by t.entry_key collate "C"
$$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = '${schema}'
         and tablename = '${table}'
     ) then
    alter publication supabase_realtime add table ${qualified};
  end if;
end;
$$;
`;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function errorCode(error: SupabaseErrorLike): string {
  return typeof error.code === 'string' ? error.code : '';
}

/** Maps a PostgREST error (SQLSTATE, `PGRST...` code or HTTP status) to a code. */
function classifyError(
  error: SupabaseErrorLike,
  status: number | undefined
): StoreErrorCode {
  const code: string = errorCode(error);
  if (
    code === '42501' || // insufficient_privilege, including row-level security
    code === 'PGRST301' || // JWT expired or invalid
    code === 'PGRST302' || // anonymous access is disabled
    code.startsWith('28') || // invalid_authorization_specification
    status === 401 ||
    status === 403
  ) {
    return 'forbidden';
  }
  if (code === '53100' || status === 429 || status === 413 || status === 507) {
    return 'quota';
  }
  if (
    code === '22021' || // character_not_in_repertoire (for example a NUL)
    code === '22P05' ||
    code === '22001' ||
    code === 'PGRST202' || // the function is not in the schema cache
    code === 'PGRST205' || // the table is not in the schema cache
    code === '42P01' || // undefined_table
    code === '42883' // undefined_function
  ) {
    return 'invalid';
  }
  return 'unavailable';
}

function describeError(error: SupabaseErrorLike): string {
  const code: string = errorCode(error);
  const detail: string = [error.message, error.details, error.hint]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join('; ');
  const text: string = detail === '' ? 'no detail given' : detail;
  const missing: boolean = ['PGRST202', 'PGRST205', '42P01', '42883'].includes(
    code
  );
  return `${code === '' ? '' : `${code}: `}${text}${missing ? '; run supabaseSetupSql() to create the table and functions' : ''}`;
}

/** The result of a call that did not throw: the rows, or why not. */
type Reply =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly code: StoreErrorCode;
      readonly detail: string;
    };

async function ask(query: PromiseLike<SupabaseResultLike>): Promise<Reply> {
  try {
    const result: SupabaseResultLike = await query;
    if (result.error !== null) {
      return {
        ok: false,
        code: classifyError(result.error, result.status),
        detail: describeError(result.error),
      };
    }
    return { ok: true, data: result.data };
  } catch (error: unknown) {
    return {
      ok: false,
      code: 'unavailable',
      detail: describeUnknownError(error),
    };
  }
}

function asRows(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data)
    ? data.filter(
        (row): row is Record<string, unknown> =>
          typeof row === 'object' && row !== null
      )
    : [];
}

/* ------------------------------------------------------------------ */
/* The adapter                                                         */
/* ------------------------------------------------------------------ */

let channelCounter = 0;

/**
 * A `StorageAdapter` over a Supabase table. Each key is a row with a counter
 * revision. `set` calls the `<table>_set` function, which checks the revision and
 * writes in one statement, so `set` with `ifRevision` reports `conflict` when
 * another client wrote first, and a key with nothing stored is created.
 * `subscribe` reports your own writes and, through one Realtime channel on the table,
 * changes other clients make (while a subscriber is listening). Nothing throws:
 * every failure is a `StoreResult`.
 */
export function supabaseAdapter(
  options: SupabaseAdapterOptions
): StorageAdapter {
  const { client } = options;
  const table: string = options.table ?? DEFAULT_TABLE;
  const schema: string = options.schema ?? DEFAULT_SCHEMA;
  const settingsProblem: string | null =
    isSafeIdentifier(table) && isSafeIdentifier(schema)
      ? null
      : `cannot use table "${table}" in schema "${schema}": use letters, digits and underscores`;
  const listeners = createChangeListeners();
  /** The revision last reported for each key someone listens to (null: removed). */
  const reported = new Map<string, string | null>();
  let channel: SupabaseChannelLike | null = null;
  const tableOf = (): SupabaseTableLike =>
    client.from(table) as SupabaseTableLike;
  const rpcOf = (
    functionName: string,
    args: Record<string, unknown>
  ): SupabaseQueryLike => client.rpc(functionName, args) as SupabaseQueryLike;
  /** How many subscriptions are open, across all keys. */
  let subscribers = 0;

  /** Why this call cannot go ahead, or null if it can. */
  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): StoreResult<T> | null => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    if (settingsProblem !== null) {
      return sqlFailure(LABEL, 'invalid', key, settingsProblem);
    }
    return null;
  };

  /** Tells subscribers, once per change, whichever way the change reached us. */
  const report = (key: string, stored: StoredValue | null): void => {
    if (!listeners.has(key)) {
      return;
    }
    const revision: string | null = stored?.revision ?? null;
    if (reported.has(key) && reported.get(key) === revision) {
      return;
    }
    reported.set(key, revision);
    listeners.notify(key, stored);
  };

  const watchProblem = (message: string): void => {
    options.onWatchError?.(`${LABEL} ${message}`);
  };

  const onChange = (change: SupabaseChangeLike): void => {
    const removed: boolean = change.eventType === 'DELETE';
    const row: Readonly<Record<string, unknown>> = removed
      ? change.old
      : change.new;
    const key: unknown = row.entry_key;
    if (typeof key !== 'string') {
      watchProblem(
        `received a ${change.eventType} on "${schema}.${table}" without its key, so it cannot tell which key changed: run supabaseSetupSql() to set the replica identity`
      );
      return;
    }
    if (removed) {
      report(key, null);
      return;
    }
    const revision: string | undefined = revisionText(row.revision);
    if (typeof row.entry_value === 'string' && revision !== undefined) {
      report(key, { value: row.entry_value, revision });
    }
  };

  const openChannel = (): void => {
    if (channel !== null) {
      return;
    }
    try {
      channelCounter += 1;
      const opened: SupabaseChannelLike = (
        client.channel(
          `storage-adapters:${schema}.${table}:${channelCounter}:${Math.random().toString(36).slice(2)}`
        ) as SupabaseChannelLike
      )
        .on('postgres_changes', { event: '*', schema, table }, onChange)
        .subscribe((status, error) => {
          if (
            status === 'CHANNEL_ERROR' ||
            status === 'TIMED_OUT' ||
            status === 'CLOSED'
          ) {
            watchProblem(
              `Realtime channel for "${schema}.${table}" is ${status}${error === undefined ? '' : ` (${describeUnknownError(error)})`}: is the table in the supabase_realtime publication?`
            );
          }
        });
      channel = opened;
    } catch (error: unknown) {
      watchProblem(
        `could not open a Realtime channel for "${schema}.${table}" (${describeUnknownError(error)})`
      );
    }
  };

  const closeChannel = (): void => {
    const open: SupabaseChannelLike | null = channel;
    channel = null;
    if (open !== null) {
      try {
        Promise.resolve(client.removeChannel(open as never)).catch(
          () => undefined
        );
      } catch {
        // Nothing more to do: the channel is dropped either way.
      }
    }
  };

  const failedWith = <T>(
    reply: Extract<Reply, { ok: false }>,
    key: string,
    verb: string
  ): StoreResult<T> =>
    sqlFailure(
      LABEL,
      reply.code,
      key,
      `could not be ${verb} (${reply.detail})`
    );

  return {
    async get(key, { signal }) {
      const refused = refusal<StoredValue | null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      const reply: Reply = await ask(
        tableOf()
          .select('entry_value, revision')
          .eq('entry_key', key)
          .maybeSingle()
      );
      if (!reply.ok) {
        return failedWith(reply, key, 'read');
      }
      if (reply.data === null || reply.data === undefined) {
        return { ok: true, value: null };
      }
      const row = reply.data as Record<string, unknown>;
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
    },

    async set(key, value, { signal, ifRevision }) {
      const refused = refusal<StoredValue>(key, signal);
      if (refused !== null) {
        return refused;
      }
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        const reply: Reply = await ask(
          rpcOf(`${table}_set`, {
            p_key: key,
            p_value: value,
            ...(ifRevision === undefined
              ? {}
              : {
                  p_if_revision: revisionParameter(ifRevision, NEVER_MATCHES),
                }),
          })
        );
        if (!reply.ok) {
          return failedWith(reply, key, 'written');
        }
        const row: Record<string, unknown> | undefined = asRows(reply.data)[0];
        const revision: string | undefined = revisionText(
          row?.current_revision
        );
        if (row?.outcome === 'written' && revision !== undefined) {
          const stored: StoredValue = { value, revision };
          report(key, stored);
          return { ok: true, value: stored };
        }
        if (row?.outcome === 'conflict' && revision !== undefined) {
          return sqlFailure(
            LABEL,
            'conflict',
            key,
            `holds revision ${revision}, but revision ${ifRevision ?? ''} was expected`
          );
        }
        // No row: it was removed between the check and the read, so it can go in as new.
      }
      return sqlFailure(
        LABEL,
        'unavailable',
        key,
        'changed too often to be written'
      );
    },

    async remove(key, { signal }) {
      const refused = refusal<null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      const reply: Reply = await ask(tableOf().delete().eq('entry_key', key));
      if (!reply.ok) {
        return failedWith(reply, key, 'removed');
      }
      report(key, null);
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
      if (settingsProblem !== null) {
        return prefixFailure(LABEL, 'invalid', prefix, settingsProblem);
      }
      const keys: string[] = [];
      // The server may cap a response below the page asked for, so keep asking
      // from where the last answer ended until it has nothing more.
      for (;;) {
        const reply: Reply = await ask(
          rpcOf(`${table}_list`, { p_prefix: prefix }).range(
            keys.length,
            keys.length + LIST_PAGE_SIZE - 1
          )
        );
        if (!reply.ok) {
          return prefixFailure(
            LABEL,
            reply.code,
            prefix,
            `could not list keys (${reply.detail})`
          );
        }
        const rows: Record<string, unknown>[] = asRows(reply.data);
        for (const row of rows) {
          if (typeof row.entry_key === 'string') {
            keys.push(row.entry_key);
          }
        }
        if (rows.length === 0) {
          break;
        }
      }
      return {
        ok: true,
        value: keysWithPrefix(keys, prefix).sort(compareKeys),
      };
    },

    subscribe: (key, onKeyChange) => {
      const stopListening: () => void = listeners.subscribe(key, onKeyChange);
      subscribers += 1;
      openChannel();
      let stopped = false;
      return () => {
        if (stopped) {
          return;
        }
        stopped = true;
        stopListening();
        subscribers -= 1;
        if (!listeners.has(key)) {
          reported.delete(key);
        }
        if (subscribers === 0) {
          closeChannel();
        }
      };
    },
  };
}
