/**
 * The Supabase adapter against a real PostgreSQL server and a real PostgREST (the
 * REST layer Supabase puts in front of its database), through the real `supabase-js`
 * client. The default test run skips this (it uses an in-memory client, in
 * `supabase.test.ts`). To run it, start PostgreSQL and PostgREST (with
 * `db-max-rows = 1000`, as Supabase has) and set:
 *
 *   TEST_SUPABASE_DB_URL=postgres://postgres@127.0.0.1:5433/supabase_test
 *   TEST_SUPABASE_REST_URL=http://127.0.0.1:3010
 *   TEST_SUPABASE_JWT_SECRET=<the secret PostgREST was given, 32 characters or more>
 *
 * The test creates the API roles, the table and the two functions itself, and
 * empties the table before each test. Realtime is not part of this: it needs the
 * Supabase Realtime server, so `subscribe` is covered with a fake channel in
 * `supabase.test.ts`.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { supabaseAdapter, supabaseSetupSql } from '../src/supabase/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;
const databaseUrl: string | undefined = process.env.TEST_SUPABASE_DB_URL;
const restUrl: string | undefined = process.env.TEST_SUPABASE_REST_URL;
const jwtSecret: string | undefined = process.env.TEST_SUPABASE_JWT_SECRET;
const enabled: boolean =
  databaseUrl !== undefined && restUrl !== undefined && jwtSecret !== undefined;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

function expectFailure<T>(result: StoreResult<T>, code: string): string {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code, result.error);
  return result.error;
}

/** A signed token for an API role, as Supabase's keys are. */
function tokenFor(role: string, secret: string): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, iss: 'supabase', exp: 4_102_444_800 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/**
 * Supabase serves PostgREST under `/rest/v1`, and `supabase-js` adds that prefix;
 * a bare PostgREST does not have it, so this forwards after taking it off.
 */
function startPrefixProxy(target: string): Promise<Server> {
  const upstream = new URL(target);
  const server = createServer((from: IncomingMessage, to: ServerResponse) => {
    const forwarded = request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: from.method,
        path: (from.url ?? '/').replace(/^\/rest\/v1/, ''),
        headers: from.headers,
      },
      (answer) => {
        to.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(to);
      }
    );
    forwarded.on('error', () => {
      to.writeHead(502).end();
    });
    from.pipe(forwarded);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

void describe('supabaseAdapter against PostgreSQL and PostgREST', async () => {
  if (!enabled) {
    void it(
      'is skipped: set TEST_SUPABASE_DB_URL, TEST_SUPABASE_REST_URL and TEST_SUPABASE_JWT_SECRET to run it',
      { skip: true },
      () => {
        /* nothing to run */
      }
    );
    return;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const { default: pg } = await import('pg');
  const database = new pg.Client({ connectionString: databaseUrl });
  let proxy: Server | undefined;
  let baseUrl = '';
  const secret = jwtSecret ?? '';
  const serviceKey = tokenFor('service_role', secret);
  const anonKey = tokenFor('anon', secret);

  const clientFor = (key: string) =>
    createClient(baseUrl, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  const adapterFor = (key: string, table?: string): StorageAdapter =>
    supabaseAdapter({
      client: clientFor(key),
      ...(table === undefined ? {} : { table }),
    });

  /** PostgREST learns about new tables and functions when told to reload. */
  const reloadSchema = async (): Promise<void> => {
    await database.query("notify pgrst, 'reload schema'");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = await fetch(`${restUrl}/rpc/storage_entry_list`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ p_prefix: '' }),
      });
      if (probe.ok) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail('PostgREST did not pick up the new functions');
  };

  before(async () => {
    await database.connect();
    await database.query(
      readFileSync(
        new URL('./support/supabase-local.sql', import.meta.url),
        'utf8'
      )
    );
    await database.query(supabaseSetupSql());
    await database.query(supabaseSetupSql({ table: 'app_setting' }));
    await reloadSchema();
    proxy = await startPrefixProxy(restUrl ?? '');
    baseUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  after(async () => {
    proxy?.close();
    await database.end();
  });

  const emptyTable = async (table = 'storage_entry'): Promise<void> => {
    await database.query(`truncate public.${table}`);
  };

  runConformance('supabaseAdapter on PostgREST through supabase-js', {
    ownWrites: 'notifies',
    create: async () => {
      await emptyTable();
      const client = clientFor(serviceKey);
      return {
        adapter: supabaseAdapter({ client }),
        reopen: () => supabaseAdapter({ client }),
      };
    },
  });

  runConformance('supabaseAdapter on PostgREST with a table of its own', {
    ownWrites: 'notifies',
    create: async () => {
      await emptyTable('app_setting');
      const client = clientFor(serviceKey);
      return {
        adapter: supabaseAdapter({ client, table: 'app_setting' }),
        reopen: () => supabaseAdapter({ client, table: 'app_setting' }),
      };
    },
  });

  void describe('the database', () => {
    void it('stores a row per key with a UUID id, a counter revision and timestamps', async () => {
      await emptyTable();
      const adapter = adapterFor(serviceKey);
      expectOk(await adapter.set('k', 'one', { signal }));
      expectOk(await adapter.set('k', 'two', { signal }));
      const { rows } = await database.query(
        'select storage_entry_id, entry_key, entry_value, revision::text, created_at < updated_at as touched from public.storage_entry'
      );
      assert.equal(rows.length, 1);
      assert.match(
        rows[0].storage_entry_id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      assert.equal(rows[0].entry_key, 'k');
      assert.equal(rows[0].entry_value, 'two');
      assert.equal(rows[0].revision, '2');
      assert.equal(rows[0].touched, true);
    });

    void it('sends only the key, never the value, for a delete (replica identity is the key index)', async () => {
      const { rows } = await database.query(
        `select c.relreplident, i.relname as identity_index
         from pg_class c
         left join pg_index x on x.indrelid = c.oid and x.indisreplident
         left join pg_class i on i.oid = x.indexrelid
         where c.oid = 'public.storage_entry'::regclass`
      );
      assert.equal(rows[0].relreplident, 'i');
      assert.equal(rows[0].identity_index, 'storage_entry_entry_key_key');
    });

    void it('lets exactly one of several clients holding the same revision win', async () => {
      await emptyTable();
      const adapters = Array.from({ length: 4 }, () => adapterFor(serviceKey));
      const first = expectOk(
        await (adapters[0] as StorageAdapter).set('race', 'start', { signal })
      );
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          (adapters[index % adapters.length] as StorageAdapter).set(
            'race',
            `writer-${index}`,
            { signal, ifRevision: first.revision ?? '' }
          )
        )
      );
      assert.equal(results.filter((result) => result.ok).length, 1);
      for (const result of results) {
        if (!result.ok) {
          assert.equal(result.code, 'conflict', result.error);
        }
      }
      const { rows } = await database.query(
        "select revision::text from public.storage_entry where entry_key = 'race'"
      );
      assert.equal(rows[0].revision, '2');
    });

    void it('loses no update when several clients add to one counter', async () => {
      await emptyTable();
      const adapters = Array.from({ length: 4 }, () => adapterFor(serviceKey));
      expectOk(
        await (adapters[0] as StorageAdapter).set('count', '0', { signal })
      );
      const bump = async (adapter: StorageAdapter): Promise<void> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const current = expectOk(await adapter.get('count', { signal }));
          const written = await adapter.set(
            'count',
            String(Number(current?.value ?? '0') + 1),
            { signal, ifRevision: current?.revision ?? '' }
          );
          if (written.ok) {
            return;
          }
          assert.equal(written.code, 'conflict', written.error);
        }
        assert.fail('could not add after 200 attempts');
      };
      await Promise.all(
        adapters.flatMap((adapter) =>
          Array.from({ length: 10 }, () => bump(adapter))
        )
      );
      const stored = expectOk(
        await (adapters[0] as StorageAdapter).get('count', { signal })
      );
      assert.equal(stored?.value, '40');
    });

    void it('keeps awkward keys and values exactly', async () => {
      await emptyTable();
      const adapter = adapterFor(serviceKey);
      const keys = [
        'a/b/c',
        '..',
        'with space',
        'é and \u{1f600}',
        '100%',
        'a_b',
        'a*b',
        "it's",
        'q"uote',
        'a,b',
        'a=b',
        '?&#',
      ];
      for (const key of keys) {
        expectOk(
          await adapter.set(key, `value of ${key}\nline two`, { signal })
        );
      }
      for (const key of keys) {
        assert.equal(
          expectOk(await adapter.get(key, { signal }))?.value,
          `value of ${key}\nline two`
        );
      }
      assert.deepEqual(
        expectOk(await (adapter.list?.('', { signal }) ?? Promise.reject())),
        [...keys].sort()
      );
      expectOk(await (adapter.remove?.('a=b', { signal }) ?? Promise.reject()));
      assert.equal(expectOk(await adapter.get('a=b', { signal })), null);
    });

    void it('stores a large value unchanged', async () => {
      await emptyTable();
      const adapter = adapterFor(serviceKey);
      const big = 'x\u{1f600}é'.repeat(100_000);
      expectOk(await adapter.set('big', big, { signal }));
      assert.equal(expectOk(await adapter.get('big', { signal }))?.value, big);
    });

    void it('refuses text PostgreSQL cannot hold, as invalid', async () => {
      await emptyTable();
      const adapter = adapterFor(serviceKey);
      const message = expectFailure(
        await adapter.set('k', 'before\u0000after', { signal }),
        'invalid'
      );
      assert.match(
        message,
        /^Supabase could not be written \(.+\) for key "k"$/
      );
      assert.equal(expectOk(await adapter.get('k', { signal })), null);
    });

    void it('lists every key when there are more than the server returns at once', async () => {
      await emptyTable();
      await database.query(
        "insert into public.storage_entry (entry_key, entry_value) select 'bulk:' || lpad(n::text, 5, '0'), 'v' from generate_series(1, 2350) n"
      );
      await database.query(
        "insert into public.storage_entry (entry_key, entry_value) values ('other', 'v')"
      );
      const adapter = adapterFor(serviceKey);
      const keys = expectOk(
        await (adapter.list?.('bulk:', { signal }) ?? Promise.reject())
      );
      assert.equal(keys.length, 2350);
      assert.equal(keys[0], 'bulk:00001');
      assert.equal(keys.at(-1), 'bulk:02350');
      assert.equal(
        expectOk(await (adapter.list?.('', { signal }) ?? Promise.reject()))
          .length,
        2351
      );
    });
  });

  void describe('row-level security and missing setup', () => {
    void it('refuses writes without a policy, and reads look empty', async () => {
      await emptyTable();
      const service = adapterFor(serviceKey);
      expectOk(await service.set('k', 'secret', { signal }));
      const anon = adapterFor(anonKey);
      assert.equal(expectOk(await anon.get('k', { signal })), null);
      const message = expectFailure(
        await anon.set('other', 'v', { signal }),
        'forbidden'
      );
      assert.match(message, /row-level security|permission denied/i);
      assert.deepEqual(
        expectOk(await (anon.list?.('', { signal }) ?? Promise.reject())),
        []
      );
    });

    void it('works for a role the policies allow', async () => {
      await emptyTable();
      await database.query(
        "create policy anon_all on public.storage_entry for all to anon using (entry_key like 'public:%') with check (entry_key like 'public:%')"
      );
      try {
        const anon = adapterFor(anonKey);
        expectOk(await anon.set('public:k', 'v', { signal }));
        assert.equal(
          expectOk(await anon.get('public:k', { signal }))?.value,
          'v'
        );
        expectFailure(
          await anon.set('private:k', 'v', { signal }),
          'forbidden'
        );
        assert.deepEqual(
          expectOk(await (anon.list?.('', { signal }) ?? Promise.reject())),
          ['public:k']
        );
      } finally {
        await database.query('drop policy anon_all on public.storage_entry');
      }
    });

    void it('refuses a bad key, as forbidden', async () => {
      const adapter = adapterFor(tokenFor('service_role', 'y'.repeat(40)));
      expectFailure(await adapter.get('k', { signal }), 'forbidden');
      expectFailure(await adapter.set('k', 'v', { signal }), 'forbidden');
    });

    void it('says to run the setup SQL when the table or functions are missing', async () => {
      const adapter = adapterFor(serviceKey, 'never_created');
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'invalid'),
        /run supabaseSetupSql\(\)/
      );
      assert.match(
        expectFailure(await adapter.set('k', 'v', { signal }), 'invalid'),
        /run supabaseSetupSql\(\)/
      );
      assert.match(
        expectFailure(
          await (adapter.list?.('', { signal }) ?? Promise.reject()),
          'invalid'
        ),
        /run supabaseSetupSql\(\)/
      );
    });

    void it('reports an unreachable server as unavailable', async () => {
      const adapter = supabaseAdapter({
        client: createClient('http://127.0.0.1:1', serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          // supabase-js retries a failed read three times with a back-off of 7 s.
          db: { retry: false },
        }),
      });
      expectFailure(await adapter.get('k', { signal }), 'unavailable');
      expectFailure(await adapter.set('k', 'v', { signal }), 'unavailable');
    });

    void it('reports its own writes to a subscriber', async () => {
      await emptyTable();
      const client = clientFor(serviceKey);
      const adapter = supabaseAdapter({
        client,
        // The Realtime server is not part of this test, so its channel never joins.
        onWatchError: () => undefined,
      });
      const heard: (StoredValue | null)[] = [];
      const stop = adapter.subscribe?.('k', (stored) => heard.push(stored));
      expectOk(await adapter.set('k', 'v', { signal }));
      expectOk(await (adapter.remove?.('k', { signal }) ?? Promise.reject()));
      stop?.();
      await client.removeAllChannels();
      assert.deepEqual(heard, [{ value: 'v', revision: '1' }, null]);
    });
  });
});
