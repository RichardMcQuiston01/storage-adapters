/**
 * The NATS KV adapter against a real NATS server with JetStream enabled. Skipped
 * unless a URL is set:
 *
 *   TEST_NATS_URL=nats://127.0.0.1:4222
 *
 * Every test gets its own bucket and destroys it afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { Kvm, type KV } from '@nats-io/kv';
import { connect, type NatsConnection } from '@nats-io/transport-node';

import { natsKvAdapter, type NatsKvLike } from '../src/nats/index.js';
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

/** Waits until a condition holds, or fails after two seconds. */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const natsUrl: string | undefined = process.env.TEST_NATS_URL;
if (natsUrl === undefined || natsUrl === '') {
  void describe('natsKvAdapter on a NATS server', () => {
    void it('is skipped: set TEST_NATS_URL to run it', { skip: true }, () => {
      // Nothing to run without a server.
    });
  });
} else {
  const connections: NatsConnection[] = [];
  const open = async (): Promise<NatsConnection> => {
    const connection: NatsConnection = await connect({ servers: natsUrl });
    connections.push(connection);
    return connection;
  };
  after(async () => {
    await Promise.all(connections.map((connection) => connection.close()));
  });
  const bucketName = (): string => `test_${randomBytes(6).toString('hex')}`;

  runConformance('natsKvAdapter on a NATS server', {
    ownWrites: 'notifies',
    create: async () => {
      const connection: NatsConnection = await open();
      const bucket: KV = await new Kvm(connection).create(bucketName());
      const kv: NatsKvLike = bucket;
      return {
        adapter: natsKvAdapter({ kv }),
        reopen: () => natsKvAdapter({ kv }),
        cleanup: async () => {
          await bucket.destroy();
        },
      };
    },
  });

  void describe('natsKvAdapter on a NATS server: beyond the contract', () => {
    const withBucket = async (
      body: (bucket: KV, other: KV) => Promise<void>
    ): Promise<void> => {
      const first: NatsConnection = await open();
      const second: NatsConnection = await open();
      const name: string = bucketName();
      const bucket: KV = await new Kvm(first).create(name);
      const other: KV = await new Kvm(second).open(name);
      try {
        await body(bucket, other);
      } finally {
        await bucket.destroy();
      }
    };

    void it('loses no update when two connections count together', async () => {
      await withBucket(async (bucket, other) => {
        const adapters: StorageAdapter[] = [
          natsKvAdapter({ kv: bucket }),
          natsKvAdapter({ kv: other }),
        ];
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
        // Start from a stored value: with nothing stored the first write of each
        // side is a plain overwrite, not a compare-and-set.
        expectOk(await natsKvAdapter({ kv: bucket }).set('n', '0', { signal }));
        await Promise.all(adapters.map(bump));
        assert.equal(
          expectOk(
            (await adapters[0]?.get('n', { signal })) ?? {
              ok: true,
              value: null,
            }
          )?.value,
          '30'
        );
      });
    });

    void it('hears a write made on another connection', async () => {
      await withBucket(async (bucket, other) => {
        const listener = natsKvAdapter({ kv: bucket });
        const writer = natsKvAdapter({ kv: other });
        const seen: (StoredValue | null)[] = [];
        const stop =
          listener.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
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

    void it('reports each of our own writes once', async () => {
      await withBucket(async (bucket) => {
        const adapter = natsKvAdapter({ kv: bucket });
        const seen: (StoredValue | null)[] = [];
        const stop =
          adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expectOk(await adapter.set('k', 'one', { signal }));
        expectOk(await adapter.set('k', 'two', { signal }));
        expectOk(
          (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        stop();
        assert.deepEqual(
          seen.map((stored) => stored?.value ?? null),
          ['one', 'two', null]
        );
      });
    });

    void it('lists only keys it wrote, and only under the prefix', async () => {
      await withBucket(async (bucket) => {
        const adapter = natsKvAdapter({ kv: bucket });
        expectOk(await adapter.set('user/1', 'a', { signal }));
        expectOk(await adapter.set('user/2', 'b', { signal }));
        expectOk(await adapter.set('users', 'c', { signal }));
        expectOk(await adapter.set('é.😀', 'd', { signal }));
        await bucket.put('plain.name', 'written by something else');
        const list = async (prefix: string): Promise<readonly string[]> =>
          expectOk(
            (await adapter.list?.(prefix, { signal })) ?? {
              ok: true,
              value: [],
            }
          );
        assert.deepEqual(await list('user/'), ['user/1', 'user/2']);
        assert.deepEqual(await list(''), ['user/1', 'user/2', 'users', 'é.😀']);
        assert.deepEqual(await list('é.'), ['é.😀']);
      });
    });

    void it('keeps the value exactly, including emoji and newlines', async () => {
      await withBucket(async (bucket) => {
        const adapter = natsKvAdapter({ kv: bucket });
        const value = 'line one\nline two 😀 é\t"quoted"';
        expectOk(await adapter.set('k', value, { signal }));
        assert.equal(
          expectOk(await adapter.get('k', { signal }))?.value,
          value
        );
      });
    });

    void it('reports a value over the server limit as invalid, naming the key', async () => {
      await withBucket(async (bucket) => {
        const adapter = natsKvAdapter({ kv: bucket });
        const result = await adapter.set('big', 'x'.repeat(2 * 1024 * 1024), {
          signal,
        });
        assert.ok(!result.ok);
        assert.equal(result.code, 'invalid');
        assert.ok(result.error.includes('"big"'), result.error);
      });
    });

    void it('reports a closed connection as unavailable', async () => {
      const connection: NatsConnection = await connect({ servers: natsUrl });
      const name: string = bucketName();
      const bucket: KV = await new Kvm(connection).create(name);
      const adapter = natsKvAdapter({ kv: bucket });
      await connection.close();
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.equal(result.code, 'unavailable');
      assert.ok(result.error.includes('"k"'), result.error);
      const cleanup: NatsConnection = await open();
      await (await new Kvm(cleanup).open(name)).destroy();
    });
  });
}
