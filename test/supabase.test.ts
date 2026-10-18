import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { supabaseAdapter, supabaseSetupSql } from '../src/supabase/index.js';
import type { StoredValue, StoreResult } from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { fakeSupabase, postgrestError } from './support/fake-supabase.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

function expectFailure<T>(
  result: StoreResult<T>,
  code: string,
  subject: string
): string {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  assert.ok(
    result.error.startsWith('Supabase '),
    `error should name the store: ${result.error}`
  );
  assert.ok(
    result.error.includes(`"${subject}"`),
    `error should name "${subject}": ${result.error}`
  );
  return result.error;
}

/** Lets queued Realtime deliveries run. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
};

runConformance('supabaseAdapter on an in-memory client', {
  ownWrites: 'notifies',
  create: () => {
    const client = fakeSupabase();
    return {
      adapter: supabaseAdapter({ client }),
      reopen: () => supabaseAdapter({ client }),
    };
  },
});

void describe('supabaseSetupSql', () => {
  void it('creates the table, the two functions and turns on row-level security', () => {
    const sql = supabaseSetupSql();
    assert.match(sql, /create table if not exists public\.storage_entry/);
    assert.match(
      sql,
      /storage_entry_id uuid primary key default gen_random_uuid\(\)/
    );
    assert.match(sql, /revision bigint not null default 1/);
    assert.match(sql, /created_at timestamptz.*\n.*updated_at timestamptz/);
    assert.match(sql, /enable row level security/);
    assert.match(
      sql,
      /replica identity using index storage_entry_entry_key_key/
    );
    assert.ok(!sql.includes('replica identity full'));
    assert.match(sql, /function public\.storage_entry_set\(/);
    assert.match(sql, /function public\.storage_entry_list\(/);
    assert.match(
      sql,
      /alter publication supabase_realtime add table public\.storage_entry/
    );
    assert.match(sql, /set search_path = ''/);
  });

  void it('uses the table and schema it is given', () => {
    const sql = supabaseSetupSql({ table: 'app_setting', schema: 'private' });
    assert.match(sql, /create table if not exists private\.app_setting/);
    assert.match(sql, /function private\.app_setting_set\(/);
    assert.match(sql, /function private\.app_setting_list\(/);
    assert.ok(!sql.includes('storage_entry_set'));
    assert.ok(!sql.includes('public.storage_entry'));
  });

  void it('refuses a name that could change the SQL', () => {
    assert.throws(
      () => supabaseSetupSql({ table: 'x; drop table y' }),
      /cannot use table "x; drop table y"/
    );
    assert.throws(() => supabaseSetupSql({ schema: 'a.b' }), /schema "a\.b"/);
  });
});

void describe('supabaseAdapter', () => {
  void it('calls the set function with only the arguments it was given', async () => {
    const client = fakeSupabase();
    const adapter = supabaseAdapter({ client, table: 'app_setting' });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await adapter.set('k', 'w', { signal, ifRevision: '1' }));
    expectOk(await adapter.get('k', { signal }));
    assert.ok(
      client.calls.includes('rpc app_setting_set'),
      client.calls.join()
    );
    assert.ok(
      client.calls.includes('select app_setting entry_value, revision')
    );
    assert.ok(!client.calls.some((call) => call.includes('storage_entry')));
  });

  void it('says what revision it holds when a write is stale', async () => {
    const adapter = supabaseAdapter({ client: fakeSupabase() });
    const first = expectOk(await adapter.set('k', 'v1', { signal }));
    expectOk(
      await adapter.set('k', 'v2', { signal, ifRevision: first.revision ?? '' })
    );
    const message = expectFailure(
      await adapter.set('k', 'v3', {
        signal,
        ifRevision: first.revision ?? '',
      }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 2, but revision 1 was expected/);
  });

  void it('treats a revision that is not a number as one that matches nothing', async () => {
    const client = fakeSupabase();
    const adapter = supabaseAdapter({ client });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectFailure(
      await adapter.set('k', 'w', { signal, ifRevision: 'abc' }),
      'conflict',
      'k'
    );
    assert.deepEqual(expectOk(await adapter.get('k', { signal })), {
      value: 'v',
      revision: '1',
    });
    // Nothing stored: even a junk revision creates the key.
    expectOk(await adapter.set('new', 'v', { signal, ifRevision: 'abc' }));
  });

  void it('writes again when the row vanished between the check and the read', async () => {
    const client = fakeSupabase();
    const adapter = supabaseAdapter({ client });
    let answered = 0;
    const rpc = client.rpc.bind(client);
    client.rpc = (functionName, args) => {
      answered += 1;
      if (functionName.endsWith('_set') && answered === 1) {
        // The function found a mismatch but the row was gone when it looked.
        return {
          eq: () => client.rpc(functionName, args),
          range: () => client.rpc(functionName, args),
          maybeSingle: () => client.rpc(functionName, args),
          then: (onfulfilled, onrejected) =>
            Promise.resolve({ data: [], error: null }).then(
              onfulfilled,
              onrejected
            ),
        };
      }
      return rpc(functionName, args);
    };
    assert.deepEqual(
      expectOk(await adapter.set('k', 'v', { signal, ifRevision: '5' })),
      { value: 'v', revision: '1' }
    );
  });

  void it('refuses a table or schema that is not a plain name, and touches nothing', async () => {
    const client = fakeSupabase();
    const adapter = supabaseAdapter({ client, table: 'a;b' });
    const message = expectFailure(
      await adapter.get('k', { signal }),
      'invalid',
      'k'
    );
    assert.match(message, /cannot use table "a;b"/);
    expectFailure(await adapter.set('k', 'v', { signal }), 'invalid', 'k');
    expectFailure(
      await (adapter.remove?.('k', { signal }) ?? Promise.reject()),
      'invalid',
      'k'
    );
    expectFailure(
      await (adapter.list?.('p', { signal }) ?? Promise.reject()),
      'invalid',
      'p'
    );
    assert.deepEqual(client.calls, []);
  });

  void it('does not touch the client when the signal is already aborted', async () => {
    const client = fakeSupabase();
    const adapter = supabaseAdapter({ client });
    const controller = new AbortController();
    controller.abort();
    const aborted = { signal: controller.signal };
    expectFailure(await adapter.get('k', aborted), 'unavailable', 'k');
    expectFailure(await adapter.set('k', 'v', aborted), 'unavailable', 'k');
    expectFailure(
      await (adapter.remove?.('k', aborted) ?? Promise.reject()),
      'unavailable',
      'k'
    );
    expectFailure(
      await (adapter.list?.('p', aborted) ?? Promise.reject()),
      'unavailable',
      'p'
    );
    assert.deepEqual(client.calls, []);
  });

  void it('calls a row that is not a stored entry corrupt', async () => {
    const client = fakeSupabase();
    client.rows.set('k', {
      entry_key: 'k',
      entry_value: 7,
      revision: 1,
    } as never);
    const adapter = supabaseAdapter({ client });
    expectFailure(await adapter.get('k', { signal }), 'corrupt', 'k');
  });

  void describe('errors from PostgREST', () => {
    const cases: readonly [string, string, number | undefined][] = [
      ['forbidden', '42501', 403], // also row-level security
      ['forbidden', 'PGRST301', 401],
      ['forbidden', 'PGRST302', 401],
      ['forbidden', '28000', undefined],
      ['forbidden', '', 401],
      ['quota', '53100', 507],
      ['quota', '', 429],
      ['invalid', '22021', 400],
      ['invalid', 'PGRST202', 404],
      ['invalid', 'PGRST205', 404],
      ['invalid', '42P01', 404],
      ['unavailable', 'PGRST000', 503],
      ['unavailable', '57014', 500],
      ['unavailable', '', undefined],
    ];
    for (const [code, sqlState, status] of cases) {
      void it(`maps ${sqlState === '' ? 'status ' + String(status) : sqlState} to ${code} for get, set, remove and list`, async () => {
        const client = fakeSupabase();
        const adapter = supabaseAdapter({ client });
        const failure = () => ({
          error: postgrestError(sqlState, 'postgrest said no', {
            hint: 'try this',
          }),
          ...(status === undefined ? {} : { status }),
        });
        client.failNext.get = failure();
        const read = expectFailure(
          await adapter.get('k', { signal }),
          code,
          'k'
        );
        assert.match(read, /could not be read \(.*postgrest said no; try this/);
        client.failNext.set = failure();
        expectFailure(await adapter.set('k', 'v', { signal }), code, 'k');
        client.failNext.remove = failure();
        expectFailure(
          await (adapter.remove?.('k', { signal }) ?? Promise.reject()),
          code,
          'k'
        );
        client.failNext.list = failure();
        expectFailure(
          await (adapter.list?.('p', { signal }) ?? Promise.reject()),
          code,
          'p'
        );
      });
    }

    void it('tells you to run the setup SQL when the function or table is missing', async () => {
      const client = fakeSupabase();
      const adapter = supabaseAdapter({ client });
      client.failNext.set = {
        error: postgrestError('PGRST202', 'Could not find the function'),
        status: 404,
      };
      assert.match(
        expectFailure(await adapter.set('k', 'v', { signal }), 'invalid', 'k'),
        /PGRST202: Could not find the function; run supabaseSetupSql\(\)/
      );
    });

    void it('turns a rejected call (a network failure) into unavailable', async () => {
      const client = fakeSupabase();
      const adapter = supabaseAdapter({ client });
      client.failNext.get = new TypeError('fetch failed');
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k'),
        /could not be read \(fetch failed\)/
      );
    });

    void it('does not tell subscribers about a write that failed', async () => {
      const client = fakeSupabase();
      const adapter = supabaseAdapter({ client });
      const heard: (StoredValue | null)[] = [];
      adapter.subscribe?.('k', (stored) => heard.push(stored));
      client.failNext.set = { error: postgrestError('57014'), status: 500 };
      expectFailure(
        await adapter.set('k', 'v', { signal }),
        'unavailable',
        'k'
      );
      await settle();
      assert.deepEqual(heard, []);
    });
  });

  void describe('list', () => {
    void it('keeps asking until the server has nothing more, even when it caps a response', async () => {
      const client = fakeSupabase();
      client.maxRows = 3;
      const adapter = supabaseAdapter({ client });
      const keys = Array.from(
        { length: 10 },
        (_, index) => `key-${String(index).padStart(2, '0')}`
      );
      for (const key of keys) {
        expectOk(await adapter.set(key, 'v', { signal }));
      }
      assert.deepEqual(
        expectOk(
          await (adapter.list?.('key-', { signal }) ?? Promise.reject())
        ),
        keys
      );
      assert.ok(
        client.calls.filter((call) => call === 'rpc storage_entry_list')
          .length >= 4
      );
    });

    void it('matches the prefix as plain text', async () => {
      const adapter = supabaseAdapter({ client: fakeSupabase() });
      for (const key of [
        '100%',
        '100%sure',
        'a_b',
        'axb',
        'a*b',
        'user:1',
        'users',
      ]) {
        expectOk(await adapter.set(key, 'v', { signal }));
      }
      const list = async (prefix: string): Promise<string[]> =>
        expectOk(
          await (adapter.list?.(prefix, { signal }) ?? Promise.reject())
        );
      assert.deepEqual(await list('100%'), ['100%', '100%sure']);
      assert.deepEqual(await list('a_'), ['a_b']);
      assert.deepEqual(await list('a*'), ['a*b']);
      assert.deepEqual(await list('user:'), ['user:1']);
      assert.equal((await list('')).length, 7);
    });
  });

  void describe('subscribe', () => {
    void it('opens one Realtime channel for any number of keys, and closes it with the last', async () => {
      const client = fakeSupabase();
      const adapter = supabaseAdapter({ client });
      const stopFirst = adapter.subscribe?.('a', () => undefined);
      const stopSecond = adapter.subscribe?.('b', () => undefined);
      const stopThird = adapter.subscribe?.('a', () => undefined);
      assert.equal(client.openChannels.size, 1);
      stopFirst?.();
      stopFirst?.();
      stopSecond?.();
      assert.equal(client.openChannels.size, 1);
      stopThird?.();
      assert.equal(client.openChannels.size, 0);
      // And it opens a new one for the next subscriber.
      adapter.subscribe?.('a', () => undefined);
      assert.equal(client.openChannels.size, 1);
    });

    void it('gives each adapter its own channel name', () => {
      const client = fakeSupabase();
      supabaseAdapter({ client }).subscribe?.('k', () => undefined);
      supabaseAdapter({ client }).subscribe?.('k', () => undefined);
      const topics = [...client.openChannels].map((channel) => channel.topic);
      assert.equal(new Set(topics).size, 2, topics.join());
    });

    void it('reports a change another client makes, once', async () => {
      const client = fakeSupabase();
      const adapter = supabaseAdapter({ client });
      const heard: (StoredValue | null)[] = [];
      adapter.subscribe?.('k', (stored) => heard.push(stored));
      client.emit({
        eventType: 'INSERT',
        new: { entry_key: 'k', entry_value: 'one', revision: 1 },
        old: {},
      });
      client.emit({
        eventType: 'UPDATE',
        new: { entry_key: 'k', entry_value: 'two', revision: '2' },
        old: {},
      });
      client.emit({
        eventType: 'UPDATE',
        new: { entry_key: 'k', entry_value: 'two', revision: '2' },
        old: {},
      });
      client.emit({
        eventType: 'DELETE',
        new: {},
        old: { entry_key: 'k' },
      });
      assert.deepEqual(heard, [
        { value: 'one', revision: '1' },
        { value: 'two', revision: '2' },
        null,
      ]);
    });

    void it('reports its own write once, though Realtime sends it back', async () => {
      const client = fakeSupabase();
      const adapter = supabaseAdapter({ client });
      const heard: (StoredValue | null)[] = [];
      adapter.subscribe?.('k', (stored) => heard.push(stored));
      expectOk(await adapter.set('k', 'v', { signal }));
      await settle();
      expectOk(await (adapter.remove?.('k', { signal }) ?? Promise.reject()));
      await settle();
      assert.deepEqual(heard, [{ value: 'v', revision: '1' }, null]);
    });

    void it('ignores keys nobody listens to', async () => {
      const client = fakeSupabase();
      const adapter = supabaseAdapter({ client });
      const heard: (StoredValue | null)[] = [];
      adapter.subscribe?.('mine', (stored) => heard.push(stored));
      client.emit({
        eventType: 'INSERT',
        new: { entry_key: 'theirs', entry_value: 'v', revision: 1 },
        old: {},
      });
      await settle();
      assert.deepEqual(heard, []);
    });

    void it('hears a change again after unsubscribing and subscribing again', async () => {
      const client = fakeSupabase();
      const adapter = supabaseAdapter({ client });
      adapter.subscribe?.('k', () => undefined)();
      const heard: (StoredValue | null)[] = [];
      adapter.subscribe?.('k', (stored) => heard.push(stored));
      client.emit({
        eventType: 'INSERT',
        new: { entry_key: 'k', entry_value: 'v', revision: 1 },
        old: {},
      });
      assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
    });

    void it('says so when a delete arrives without its key', () => {
      const client = fakeSupabase();
      const problems: string[] = [];
      const adapter = supabaseAdapter({
        client,
        onWatchError: (message) => problems.push(message),
      });
      adapter.subscribe?.('k', () => undefined);
      client.emit({
        eventType: 'DELETE',
        new: {},
        old: { storage_entry_id: 'x' },
      });
      assert.equal(problems.length, 1);
      assert.match(
        problems[0] ?? '',
        /Supabase received a DELETE on "public\.storage_entry" without its key.*set the replica identity/
      );
    });

    void it('says so when the channel cannot be joined, and still reports its own writes', async () => {
      const client = fakeSupabase();
      client.channelStatusNext = 'CHANNEL_ERROR';
      client.echoWrites = false;
      const problems: string[] = [];
      const adapter = supabaseAdapter({
        client,
        onWatchError: (message) => problems.push(message),
      });
      const heard: (StoredValue | null)[] = [];
      adapter.subscribe?.('k', (stored) => heard.push(stored));
      await settle();
      assert.match(
        problems[0] ?? '',
        /Realtime channel for "public\.storage_entry" is CHANNEL_ERROR: is the table in the supabase_realtime publication\?/
      );
      expectOk(await adapter.set('k', 'v', { signal }));
      assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
    });

    void it('says so when the channel cannot be opened at all', () => {
      const client = fakeSupabase();
      client.channel = () => {
        throw new Error('no websocket');
      };
      const problems: string[] = [];
      const adapter = supabaseAdapter({
        client,
        onWatchError: (message) => problems.push(message),
      });
      adapter.subscribe?.('k', () => undefined);
      assert.match(
        problems[0] ?? '',
        /could not open a Realtime channel for "public\.storage_entry" \(no websocket\)/
      );
    });
  });
});
