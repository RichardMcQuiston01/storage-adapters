/**
 * The ArangoDB adapter against a real ArangoDB server. Skipped unless a URL is set:
 *
 *   TEST_ARANGODB_URL=http://127.0.0.1:8529
 *   TEST_ARANGODB_USER=root TEST_ARANGODB_PASSWORD=secret   (if it needs a login)
 *
 * Every test gets its own collection in the `_system` database and drops it afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  arangoDbAdapter,
  type ArangoDbAdapterOptions,
} from '../src/arangodb/index.js';
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

const serverUrl: string | undefined = process.env.TEST_ARANGODB_URL;
if (serverUrl === undefined || serverUrl === '') {
  void describe('arangoDbAdapter on an ArangoDB server', () => {
    void it(
      'is skipped: set TEST_ARANGODB_URL to run it',
      { skip: true },
      () => {
        // Nothing to run without a server.
      }
    );
  });
} else {
  const user: string = process.env.TEST_ARANGODB_USER ?? '';
  const password: string = process.env.TEST_ARANGODB_PASSWORD ?? '';
  const basic = (name: string, secret: string): Record<string, string> => ({
    Authorization: `Basic ${Buffer.from(`${name}:${secret}`).toString('base64')}`,
  });
  const authorization: Record<string, string> =
    user === '' ? {} : basic(user, password);
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

  const freshCollection = (): string => `t_${randomBytes(6).toString('hex')}`;

  const dropCollection = async (name: string): Promise<void> => {
    await request('DELETE', `/_db/_system/_api/collection/${name}`);
  };

  const adapterFor = (
    collection: string,
    more: Partial<ArangoDbAdapterOptions> = {}
  ): StorageAdapter =>
    arangoDbAdapter({
      url: baseUrl,
      collection,
      fetch: (url, init) => fetch(url, init),
      headers: authorization,
      ...more,
    });

  runConformance('arangoDbAdapter on an ArangoDB server', {
    ownWrites: 'notifies',
    create: () => {
      const collection: string = freshCollection();
      return {
        adapter: adapterFor(collection),
        reopen: () => adapterFor(collection),
        cleanup: () => dropCollection(collection),
      };
    },
  });

  void describe('arangoDbAdapter on an ArangoDB server: beyond the contract', () => {
    const withCollection = async (
      body: (collection: string) => Promise<void>
    ): Promise<void> => {
      const collection: string = freshCollection();
      try {
        await body(collection);
      } finally {
        await dropCollection(collection);
      }
    };

    void it('uses ArangoDB revisions and keeps the document readable as JSON', async () => {
      await withCollection(async (collection) => {
        const adapter = adapterFor(collection);
        const stored = expectOk(await adapter.set('theme', 'dark', { signal }));
        assert.ok(
          typeof stored.revision === 'string' && stored.revision !== ''
        );
        const document = (await (
          await request('GET', `/_db/_system/_api/document/${collection}/theme`)
        ).json()) as { _rev: string; value: string };
        assert.equal(document.value, 'dark');
        assert.equal(document._rev, stored.revision);
        const replaced = expectOk(
          await adapter.set('theme', 'light', { signal })
        );
        assert.notEqual(replaced.revision, stored.revision);
      });
    });

    void it('creates the collection itself, once, and copes with it already being there', async () => {
      await withCollection(async (collection) => {
        const first = adapterFor(collection);
        const second = adapterFor(collection);
        expectOk(await first.set('a', '1', { signal }));
        expectOk(await second.set('b', '2', { signal }));
        assert.equal(expectOk(await first.get('b', { signal }))?.value, '2');
      });
    });

    void it('loses no update when two adapters count together', async () => {
      await withCollection(async (collection) => {
        const adapters: StorageAdapter[] = [
          adapterFor(collection),
          adapterFor(collection),
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

    void it('keeps the value exactly, including emoji, newlines, quotes and a large value', async () => {
      await withCollection(async (collection) => {
        const adapter = adapterFor(collection);
        for (const value of [
          'line one\nline two 😀 é\t"quoted" \\ back',
          '{"value":"looks like JSON"}',
          '',
          '123',
          'x'.repeat(2_000_000),
        ]) {
          expectOk(await adapter.set('k', value, { signal }));
          assert.equal(
            expectOk(await adapter.get('k', { signal }))?.value,
            value
          );
        }
      });
    });

    void it('stores awkward keys and lists them under a prefix', async () => {
      await withCollection(async (collection) => {
        const adapter = adapterFor(collection);
        const keys = [
          'user/1',
          'user/2 é',
          'users',
          'a b?#&=%',
          '😀',
          '_underscore',
          'a.b',
          'k'.repeat(100),
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

    void it('lists every batch, and skips documents it did not write', async () => {
      await withCollection(async (collection) => {
        const adapter = adapterFor(collection);
        expectOk(
          await adapter.set('warm-up', 'creates the collection', { signal })
        );
        const documents = Array.from({ length: 2150 }, (_, index) => ({
          _key: `n${String(index).padStart(5, '0')}`,
          value: 'v',
        }));
        const imported = await request(
          'POST',
          `/_db/_system/_api/document/${collection}`,
          [
            ...documents,
            { _key: 'plain.name', value: 'written by something else' },
          ]
        );
        assert.ok(imported.ok, String(imported.status));
        const listed = expectOk(
          (await adapter.list?.('n', { signal })) ?? { ok: true, value: [] }
        );
        assert.deepEqual(
          listed,
          documents.map((document) => document._key)
        );
        const all = expectOk(
          (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
        );
        assert.ok(!all.includes('plain.name'));
        assert.equal(all.length, 2151);
      });
    });

    void it('hears writes and removals made through another adapter when polling', async () => {
      await withCollection(async (collection) => {
        const listener = adapterFor(collection, { pollIntervalMs: 100 });
        const writer = adapterFor(collection);
        expectOk(await writer.set('other', 'warm-up', { signal }));
        const seen: (StoredValue | null)[] = [];
        const stop =
          listener.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 300));
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

    void it('says so when the collection does not exist and it may not create one', async () => {
      const adapter = adapterFor(freshCollection(), {
        createCollection: false,
      });
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.equal(result.code, 'unavailable');
      assert.match(result.error, /collection ".*" does not exist/);
      assert.ok(result.error.includes('"k"'), result.error);
    });

    void it('says so when the database does not exist', async () => {
      const adapter = adapterFor(freshCollection(), {
        database: 'no_such_database_here',
        createCollection: false,
      });
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.equal(result.code, 'unavailable');
      assert.match(
        result.error,
        /database "no_such_database_here" does not exist/
      );
    });

    void it('reports wrong credentials as forbidden', async () => {
      if (user === '') {
        return; // The server has no login to get wrong.
      }
      await withCollection(async (collection) => {
        const adapter = adapterFor(collection, {
          headers: basic(user, 'not-the-password'),
          createCollection: false,
        });
        const result = await adapter.get('k', { signal });
        assert.ok(!result.ok);
        assert.equal(result.code, 'forbidden');
        assert.ok(result.error.includes('"k"'), result.error);
      });
    });
  });
}
