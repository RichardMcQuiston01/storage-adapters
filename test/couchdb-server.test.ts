/**
 * The CouchDB adapter against a real CouchDB server. Skipped unless a URL is set:
 *
 *   TEST_COUCHDB_URL=http://127.0.0.1:5984
 *   TEST_COUCHDB_USER=admin TEST_COUCHDB_PASSWORD=secret   (if it needs a login)
 *
 * Every test gets its own database and deletes it afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  couchDbAdapter,
  type CouchDbAdapterOptions,
} from '../src/couchdb/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

/** Waits until a condition holds, or fails after five seconds. */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const serverUrl: string | undefined = process.env.TEST_COUCHDB_URL;
if (serverUrl === undefined || serverUrl === '') {
  void describe('couchDbAdapter on a CouchDB server', () => {
    void it(
      'is skipped: set TEST_COUCHDB_URL to run it',
      { skip: true },
      () => {
        // Nothing to run without a server.
      }
    );
  });
} else {
  const user: string = process.env.TEST_COUCHDB_USER ?? '';
  const password: string = process.env.TEST_COUCHDB_PASSWORD ?? '';
  const authorization: Record<string, string> =
    user === ''
      ? {}
      : {
          Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
        };
  const baseUrl: string = serverUrl.replace(/\/+$/, '');

  const request = (
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...authorization, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const createDatabase = async (): Promise<string> => {
    const name = `test_${randomBytes(6).toString('hex')}`;
    const created: Response = await request('PUT', `/${name}`);
    assert.ok(
      created.ok,
      `could not create ${name}: ${String(created.status)}`
    );
    return name;
  };

  const dropDatabase = async (name: string): Promise<void> => {
    await request('DELETE', `/${name}`);
  };

  const adapterFor = (
    database: string,
    more: Partial<CouchDbAdapterOptions> = {}
  ): StorageAdapter =>
    couchDbAdapter({
      url: baseUrl,
      database,
      fetch: (url, init) => fetch(url, init),
      headers: authorization,
      changesTimeoutMs: 5000,
      ...more,
    });

  runConformance('couchDbAdapter on a CouchDB server', {
    ownWrites: 'notifies',
    create: async () => {
      const database: string = await createDatabase();
      return {
        adapter: adapterFor(database),
        reopen: () => adapterFor(database),
        cleanup: () => dropDatabase(database),
      };
    },
  });

  void describe('couchDbAdapter on a CouchDB server: beyond the contract', () => {
    const withDatabase = async (
      body: (database: string) => Promise<void>
    ): Promise<void> => {
      const database: string = await createDatabase();
      try {
        await body(database);
      } finally {
        await dropDatabase(database);
      }
    };

    void it('uses CouchDB revisions and keeps the document readable as JSON', async () => {
      await withDatabase(async (database) => {
        const adapter = adapterFor(database);
        const stored = expectOk(await adapter.set('theme', 'dark', { signal }));
        assert.match(stored.revision ?? '', /^1-[0-9a-f]{32}$/);
        const document = (await (
          await request('GET', `/${database}/storage%3Atheme`)
        ).json()) as { _rev: string; value: string };
        assert.equal(document.value, 'dark');
        assert.equal(document._rev, stored.revision);
      });
    });

    void it('loses no update when two adapters count together', async () => {
      await withDatabase(async (database) => {
        const adapters: StorageAdapter[] = [
          adapterFor(database),
          adapterFor(database),
        ];
        expectOk(
          (await adapters[0]?.set('n', '0', { signal })) ?? {
            ok: true,
            value: { value: '' },
          }
        );
        const bump = async (adapter: StorageAdapter): Promise<void> => {
          for (let done = 0; done < 15;) {
            const current = expectOk(await adapter.get('n', { signal }));
            const next: string = String(Number(current?.value ?? '0') + 1);
            const result = await adapter.set('n', next, {
              signal,
              ...(current?.revision === undefined
                ? {}
                : { ifRevision: current.revision }),
            });
            if (result.ok) {
              done += 1;
            } else {
              assert.equal(result.code, 'conflict');
            }
          }
        };
        await Promise.all(adapters.map(bump));
        assert.equal(
          expectOk(
            (await adapters[1]?.get('n', { signal })) ?? {
              ok: true,
              value: null,
            }
          )?.value,
          '30'
        );
      });
    });

    void it('keeps the value exactly, including emoji, newlines and quotes', async () => {
      await withDatabase(async (database) => {
        const adapter = adapterFor(database);
        const value = 'line one\nline two 😀 é\t"quoted" \\ back';
        expectOk(await adapter.set('k', value, { signal }));
        assert.equal(
          expectOk(await adapter.get('k', { signal }))?.value,
          value
        );
      });
    });

    void it('stores awkward keys and lists them under a prefix', async () => {
      await withDatabase(async (database) => {
        const adapter = adapterFor(database);
        const keys = [
          'user/1',
          'user/2 é',
          'users',
          'a b?#&=%',
          '😀',
          '_underscore',
        ];
        for (const key of keys) {
          expectOk(await adapter.set(key, key, { signal }));
          assert.equal(
            expectOk(await adapter.get(key, { signal }))?.value,
            key
          );
        }
        const list = async (prefix: string): Promise<readonly string[]> =>
          expectOk(
            (await adapter.list?.(prefix, { signal })) ?? {
              ok: true,
              value: [],
            }
          );
        assert.deepEqual(await list('user/'), ['user/1', 'user/2 é']);
        assert.deepEqual(await list(''), [...keys].sort());
      });
    });

    void it('lists every page and skips design documents when there is no prefix', async () => {
      await withDatabase(async (database) => {
        const documents = Array.from({ length: 2150 }, (_, index) => ({
          _id: `n${String(index).padStart(5, '0')}`,
          value: 'v',
        }));
        const bulk: Response = await request(
          'POST',
          `/${database}/_bulk_docs`,
          {
            docs: [...documents, { _id: '_design/views', views: {} }],
          }
        );
        assert.ok(bulk.ok, String(bulk.status));
        const adapter = adapterFor(database, { prefix: '' });
        const listed = expectOk(
          (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
        );
        assert.deepEqual(
          listed,
          documents.map((document) => document._id)
        );
      });
    });

    void it('keeps adapters with different prefixes apart', async () => {
      await withDatabase(async (database) => {
        const first = adapterFor(database, { prefix: 'a:' });
        const second = adapterFor(database, { prefix: 'b:' });
        expectOk(await first.set('k', '1', { signal }));
        expectOk(await second.set('k', '2', { signal }));
        assert.equal(expectOk(await first.get('k', { signal }))?.value, '1');
        assert.deepEqual(
          expectOk(
            (await first.list?.('', { signal })) ?? { ok: true, value: [] }
          ),
          ['k']
        );
      });
    });

    void it('hears writes and removals made through another adapter', async () => {
      await withDatabase(async (database) => {
        const listener = adapterFor(database);
        const writer = adapterFor(database);
        const seen: (StoredValue | null)[] = [];
        const stop =
          listener.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const written = expectOk(await writer.set('k', 'v', { signal }));
        await eventually(() => seen.length === 1, 'the write');
        expectOk(
          (await writer.remove?.('k', { signal })) ?? { ok: true, value: null }
        );
        await eventually(() => seen.length === 2, 'the removal');
        stop();
        assert.deepEqual(seen, [written, null]);
      });
    });

    void it('reports each of its own writes once, and hears a key added later', async () => {
      await withDatabase(async (database) => {
        const adapter = adapterFor(database);
        const writer = adapterFor(database);
        const first: (StoredValue | null)[] = [];
        const second: (StoredValue | null)[] = [];
        const stopFirst =
          adapter.subscribe?.('a', (stored) => first.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const stopSecond =
          adapter.subscribe?.('b', (stored) => second.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expectOk(await adapter.set('a', 'one', { signal }));
        expectOk(await adapter.set('a', 'two', { signal }));
        expectOk(await writer.set('b', 'from elsewhere', { signal }));
        await eventually(
          () => first.length >= 2 && second.length >= 1,
          'the changes'
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        stopFirst();
        stopSecond();
        assert.deepEqual(
          first.map((stored) => stored?.value ?? null),
          ['one', 'two']
        );
        assert.deepEqual(
          second.map((stored) => stored?.value ?? null),
          ['from elsewhere']
        );
      });
    });

    void it('says so when the database does not exist', async () => {
      const result = await adapterFor('no_such_database_here').get('k', {
        signal,
      });
      assert.ok(!result.ok);
      assert.equal(result.code, 'unavailable');
      assert.match(
        result.error,
        /database "no_such_database_here" does not exist/
      );
      assert.ok(result.error.includes('"k"'), result.error);
    });

    void it('reports wrong credentials as forbidden', async () => {
      if (user === '') {
        return; // The server has no login to get wrong.
      }
      await withDatabase(async (database) => {
        const adapter = adapterFor(database, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${user}:not-the-password`).toString('base64')}`,
          },
        });
        const result = await adapter.get('k', { signal });
        assert.ok(!result.ok);
        assert.equal(result.code, 'forbidden');
        assert.ok(result.error.includes('"k"'), result.error);
      });
    });
  });
}
