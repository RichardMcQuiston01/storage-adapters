import type {
  SupabaseChangeLike,
  SupabaseChannelLike,
  SupabaseClientLike,
  SupabaseErrorLike,
  SupabaseQueryLike,
  SupabaseResultLike,
  SupabaseTableLike,
} from '../../src/supabase/index.js';

/** An error shaped like the ones PostgREST sends through `supabase-js`. */
export function postgrestError(
  code: string,
  message = code,
  extra: Partial<SupabaseErrorLike> = {}
): SupabaseErrorLike {
  return { message, code, details: null, hint: null, ...extra };
}

interface Row {
  entry_key: string;
  entry_value: string;
  revision: number;
}

export interface FakeSupabase extends SupabaseClientLike {
  from(table: string): SupabaseTableLike;
  rpc(functionName: string, args: Record<string, unknown>): SupabaseQueryLike;
  channel(name: string): FakeChannel;
  removeChannel(channel: SupabaseChannelLike): PromiseLike<unknown>;
  readonly rows: Map<string, Row>;
  readonly calls: string[];
  /** Makes the next call of this kind answer with this error (or reject, if an Error). */
  failNext: Partial<
    Record<
      'get' | 'set' | 'remove' | 'list',
      { error: SupabaseErrorLike; status?: number } | Error
    >
  >;
  /** The most rows the server returns for one request, like PostgREST's `max-rows`. */
  maxRows: number;
  /** Channels that are open right now. */
  readonly openChannels: Set<FakeChannel>;
  /** Delivers a change to every open channel, as Realtime would. */
  emit(change: SupabaseChangeLike): void;
  /** Makes opening the next channel report this status. */
  channelStatusNext: string | null;
  /** Realtime echoes every write made through the client when true (the default). */
  echoWrites: boolean;
}

export interface FakeChannel extends SupabaseChannelLike {
  readonly topic: string;
  deliver(change: SupabaseChangeLike): void;
}

/** Orders by code point, like `collate "C"` on UTF-8 text. */
function byBytes(left: string, right: string): number {
  const a = [...left].map((c) => c.codePointAt(0) ?? 0);
  const b = [...right].map((c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return a.length - b.length;
}

/**
 * An in-memory `supabase-js` client for the calls the adapter makes: the table
 * through `from`, the two functions made by `supabaseSetupSql` through `rpc`, and
 * Realtime channels. The functions behave like the SQL: `<table>_set` checks the
 * revision and writes as one step, and `<table>_list` compares plain text.
 */
export function fakeSupabase(): FakeSupabase {
  const rows = new Map<string, Row>();
  const calls: string[] = [];
  const openChannels = new Set<FakeChannel>();

  const fake: FakeSupabase = {
    rows,
    calls,
    failNext: {},
    maxRows: 1000,
    openChannels,
    channelStatusNext: null,
    echoWrites: true,
    emit: (change) => {
      for (const channel of [...openChannels]) {
        channel.deliver(change);
      }
    },
    from: (table): SupabaseTableLike => ({
      select: (columns) => {
        calls.push(`select ${table} ${columns}`);
        return query('get', (filters, single) => {
          const key = filters.get('entry_key');
          const row = key === undefined ? undefined : rows.get(key);
          return {
            data: single ? (row ?? null) : row === undefined ? [] : [row],
          };
        });
      },
      delete: () => {
        calls.push(`delete ${table}`);
        return query('remove', (filters) => {
          const key = filters.get('entry_key');
          const row = key === undefined ? undefined : rows.get(key);
          if (key !== undefined && row !== undefined) {
            rows.delete(key);
            echo({
              eventType: 'DELETE',
              new: {},
              old: { entry_key: key },
            });
          }
          return { data: null };
        });
      },
    }),
    rpc: (functionName, args) => {
      calls.push(`rpc ${functionName}`);
      if (functionName.endsWith('_set')) {
        return query('set', () => {
          const key = args.p_key as string;
          const value = args.p_value as string;
          const expected = args.p_if_revision;
          const row = rows.get(key);
          if (row === undefined) {
            rows.set(key, { entry_key: key, entry_value: value, revision: 1 });
          } else if (
            expected === undefined ||
            String(row.revision) === String(expected)
          ) {
            row.entry_value = value;
            row.revision += 1;
          } else {
            return {
              data: [{ outcome: 'conflict', current_revision: row.revision }],
            };
          }
          const written = rows.get(key) as Row;
          echo({
            eventType: row === undefined ? 'INSERT' : 'UPDATE',
            new: { ...written },
            old: {},
          });
          return {
            data: [{ outcome: 'written', current_revision: written.revision }],
          };
        });
      }
      return query('list', (_filters, _single, range) => {
        const prefix = args.p_prefix as string;
        const all = [...rows.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort(byBytes)
          .map((entry_key) => ({ entry_key }));
        const from = range?.[0] ?? 0;
        const wanted = (range?.[1] ?? from + all.length) - from + 1;
        return { data: all.slice(from, from + Math.min(wanted, fake.maxRows)) };
      });
    },
    channel: (topic) => {
      let callback: ((change: SupabaseChangeLike) => void) | null = null;
      const channel: FakeChannel = {
        topic,
        deliver: (change) => callback?.(change),
        on: (_type, _filter, onChange) => {
          callback = onChange;
          return channel;
        },
        subscribe: (onStatus) => {
          calls.push(`channel ${topic}`);
          openChannels.add(channel);
          const status = fake.channelStatusNext ?? 'SUBSCRIBED';
          fake.channelStatusNext = null;
          queueMicrotask(() => onStatus?.(status));
          return channel;
        },
      };
      return channel;
    },
    removeChannel: (channel) => {
      calls.push('removeChannel');
      openChannels.delete(channel as FakeChannel);
      return Promise.resolve('ok');
    },
  };

  /** What Realtime sends after a write (a moment later, and to every client). */
  function echo(change: SupabaseChangeLike): void {
    if (fake.echoWrites) {
      queueMicrotask(() => {
        fake.emit(change);
      });
    }
  }

  function query(
    kind: 'get' | 'set' | 'remove' | 'list',
    run: (
      filters: Map<string, string>,
      single: boolean,
      range: [number, number] | null
    ) => { data: unknown }
  ): SupabaseQueryLike {
    const filters = new Map<string, string>();
    let single = false;
    let range: [number, number] | null = null;
    const builder: SupabaseQueryLike = {
      eq: (column, value) => {
        filters.set(column, value);
        return builder;
      },
      range: (from, to) => {
        range = [from, to];
        return builder;
      },
      maybeSingle: () => {
        single = true;
        return builder;
      },
      then: (onfulfilled, onrejected) => {
        const failure = fake.failNext[kind];
        let settled: Promise<SupabaseResultLike>;
        if (failure !== undefined) {
          delete fake.failNext[kind];
          settled =
            failure instanceof Error
              ? Promise.reject(failure)
              : Promise.resolve({
                  data: null,
                  error: failure.error,
                  ...(failure.status === undefined
                    ? {}
                    : { status: failure.status }),
                });
        } else {
          const { data } = run(filters, single, range);
          settled = Promise.resolve({ data, error: null, status: 200 });
        }
        return settled.then(onfulfilled, onrejected);
      },
    };
    return builder;
  }

  return fake;
}
