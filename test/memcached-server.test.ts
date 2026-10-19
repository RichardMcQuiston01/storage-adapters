/**
 * The Memcached adapter against a real Memcached server, through `memcache-client`.
 * Skipped unless a server is named:
 *
 *   TEST_MEMCACHED_SERVER=127.0.0.1:11211
 *
 * Every test uses its own key prefix, so tests never see each other's keys.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { MemcacheClient } from 'memcache-client';

import {
  memcachedAdapter,
  memcachedFromMemcacheClient,
  type MemcachedAdapterOptions,
} from '../src/memcached/index.js';
import type { StorageAdapter, StoreResult } from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

const server: string | undefined = process.env.TEST_MEMCACHED_SERVER;
if (server === undefined || server === '') {
  void describe('memcachedAdapter on a Memcached server', () => {
    void it(
      'is skipped: set TEST_MEMCACHED_SERVER to run it',
      { skip: true },
      () => {
        // Nothing to run without a server.
      }
    );
  });
} else {
  const clients: MemcacheClient[] = [];
  const connect = (): MemcacheClient => {
    const client = new MemcacheClient({ server });
    clients.push(client);
    return client;
  };
  after(() => {
    for (const client of clients) {
      client.shutdown();
    }
  });
  const freshPrefix = (): string => `t${randomBytes(6).toString('hex')}:`;
  const adapterOn = (
    client: MemcacheClient,
    prefix: string,
    more: Partial<MemcachedAdapterOptions> = {}
  ): StorageAdapter =>
    memcachedAdapter({
      client: memcachedFromMemcacheClient(client),
      prefix,
      ...more,
    });

  runConformance('memcachedAdapter on a Memcached server', {
    ownWrites: 'notifies',
    create: () => {
      const client: MemcacheClient = connect();
      const prefix: string = freshPrefix();
      return {
        adapter: adapterOn(client, prefix),
        reopen: () => adapterOn(connect(), prefix),
      };
    },
  });

  void describe('memcachedAdapter on a Memcached server: beyond the contract', () => {
    void it('loses no update when two connections count together', async () => {
      const prefix: string = freshPrefix();
      const adapters: StorageAdapter[] = [
        adapterOn(connect(), prefix),
        adapterOn(connect(), prefix),
      ];
      expectOk(
        (await adapters[0]?.set('n', '0', { signal })) ?? {
          ok: true,
          value: { value: '' },
        }
      );
      const bump = async (adapter: StorageAdapter): Promise<void> => {
        for (let done = 0; done < 25;) {
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
      const total = expectOk(
        (await adapters[1]?.get('n', { signal })) ?? { ok: true, value: null }
      );
      assert.equal(total?.value, '50');
      assert.equal(total?.revision, '51');
    });

    void it('counts every unconditional write from two connections', async () => {
      const prefix: string = freshPrefix();
      const first = adapterOn(connect(), prefix);
      const second = adapterOn(connect(), prefix);
      const write = async (adapter: StorageAdapter): Promise<void> => {
        for (let done = 0; done < 20; done += 1) {
          expectOk(await adapter.set('k', 'v', { signal }));
        }
      };
      await Promise.all([write(first), write(second)]);
      assert.equal(expectOk(await first.get('k', { signal }))?.revision, '40');
    });

    void it('keeps the value exactly, including emoji, newlines, quotes and JSON text', async () => {
      const adapter = adapterOn(connect(), freshPrefix());
      for (const value of [
        'line one\nline two 😀 é\t"quoted" \\ back',
        '{"r":9,"v":"looks like an entry"}',
        '',
        '123',
        'x'.repeat(500_000),
      ]) {
        expectOk(await adapter.set('k', value, { signal }));
        assert.equal(
          expectOk(await adapter.get('k', { signal }))?.value,
          value
        );
      }
    });

    void it('stores awkward keys and keeps them apart', async () => {
      const adapter = adapterOn(connect(), freshPrefix());
      const keys = [
        'a b',
        'a\nb',
        'a.b',
        'a=b',
        'é😀',
        'user/1?x=1&y=2',
        '"',
        'k'.repeat(120),
      ];
      for (const key of keys) {
        expectOk(await adapter.set(key, `value of ${key}`, { signal }));
      }
      for (const key of keys) {
        assert.equal(
          expectOk(await adapter.get(key, { signal }))?.value,
          `value of ${key}`
        );
      }
    });

    void it('forgets a key after its ttl, and a new write starts again at revision 1', async () => {
      const adapter = adapterOn(connect(), freshPrefix(), { ttlSeconds: 1 });
      expectOk(await adapter.set('k', 'one', { signal }));
      assert.equal(
        expectOk(await adapter.set('k', 'two', { signal })).revision,
        '2'
      );
      await new Promise((resolve) => setTimeout(resolve, 2300));
      assert.equal(expectOk(await adapter.get('k', { signal })), null);
      assert.equal(
        expectOk(await adapter.set('k', 'three', { signal, ifRevision: '2' }))
          .revision,
        '1'
      );
    });

    void it('reports a value over the item size limit as invalid, naming the key', async () => {
      const adapter = adapterOn(connect(), freshPrefix());
      const result = await adapter.set('big', 'x'.repeat(2 * 1024 * 1024), {
        signal,
      });
      assert.ok(!result.ok);
      assert.equal(result.code, 'invalid');
      assert.ok(result.error.includes('"big"'), result.error);
      assert.match(result.error, /item size limit/);
      assert.equal(expectOk(await adapter.get('big', { signal })), null);
    });

    void it('reports a connection that cannot be made as unavailable', async () => {
      const dead = new MemcacheClient({
        server: '127.0.0.1:1',
        connectTimeout: 500,
      });
      try {
        const adapter = adapterOn(dead, freshPrefix());
        const result = await adapter.get('k', { signal });
        assert.ok(!result.ok);
        assert.equal(result.code, 'unavailable');
        assert.ok(result.error.includes('"k"'), result.error);
      } finally {
        dead.shutdown();
      }
    });
  });
}
