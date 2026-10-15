/**
 * The Redis adapter. A small in-memory Redis (below) always runs, so the default
 * test run stays offline. A real server is used only when a URL is set:
 *
 *   TEST_REDIS_URL=redis://127.0.0.1:6379
 *
 * Every test there uses its own key prefix and deletes its keys afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { Redis } from 'ioredis';
import { createClient } from 'redis';

import {
  redisAdapter,
  redisCommandsFromIoredis,
  redisCommandsFromNodeRedis,
  redisSubscriberFromIoredis,
  redisSubscriberFromNodeRedis,
  type RedisClientLike,
  type RedisSubscriberLike,
} from '../src/redis/index.js';
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

function expectFailure<T>(
  result: StoreResult<T>,
  code: string,
  key: string
): string {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  assert.ok(
    result.error.includes(`"${key}"`),
    `error should name the key: ${result.error}`
  );
  assert.ok(result.error.startsWith('Redis '), result.error);
  return result.error;
}

interface FakeRedis extends RedisClientLike, RedisSubscriberLike {
  readonly hashes: Map<string, { r: string; v: string }>;
  readonly commands: string[][];
  /** Makes the next command reject with this error. */
  failNext: Error | null;
  /** Makes the next `subscribe` reject with this error. */
  failSubscribe: Error | null;
  readonly activeSubscriptions: () => number;
}

/** Behaves like the two Lua scripts and `HMGET`, and delivers Pub/Sub messages. */
function fakeRedis(): FakeRedis {
  const hashes = new Map<string, { r: string; v: string }>();
  const commands: string[][] = [];
  const channels = new Map<string, Set<(message: string) => void>>();
  const publish = (channel: string, message: object): void => {
    for (const listener of channels.get(channel) ?? []) {
      listener(JSON.stringify(message));
    }
  };
  const fake: FakeRedis = {
    hashes,
    commands,
    failNext: null,
    failSubscribe: null,
    activeSubscriptions: () =>
      [...channels.values()].reduce((sum, set) => sum + set.size, 0),
    command: (args) => {
      commands.push([...args]);
      if (fake.failNext !== null) {
        const failure: Error = fake.failNext;
        fake.failNext = null;
        return Promise.reject(failure);
      }
      const [name, script, , redisKey, ...rest] = args;
      if (name === 'HMGET') {
        const found = hashes.get(script ?? '');
        return Promise.resolve([found?.r ?? null, found?.v ?? null]);
      }
      const key: string = redisKey ?? '';
      if (script?.includes('HINCRBY') === true) {
        const [value = '', check, expected, , channel = '', origin, callerKey] =
          rest;
        const current = hashes.get(key);
        if (check === '1' && current !== undefined && current.r !== expected) {
          return Promise.resolve([0, current.r]);
        }
        const revision = String(Number(current?.r ?? '0') + 1);
        hashes.set(key, { r: revision, v: value });
        publish(channel, { o: origin, k: callerKey, r: revision, v: value });
        return Promise.resolve([1, revision]);
      }
      const [channel = '', origin, callerKey] = rest;
      hashes.delete(key);
      publish(channel, { o: origin, k: callerKey, v: null });
      return Promise.resolve(1);
    },
    subscribe: (channel, onMessage) => {
      if (fake.failSubscribe !== null) {
        const failure: Error = fake.failSubscribe;
        fake.failSubscribe = null;
        return Promise.reject(failure);
      }
      const set = channels.get(channel) ?? new Set();
      set.add(onMessage);
      channels.set(channel, set);
      return Promise.resolve(() => {
        set.delete(onMessage);
      });
    },
  };
  return fake;
}

/** A client whose answers are scripted: whatever `respond` returns or throws. */
function scriptedClient(respond: () => unknown): RedisClientLike {
  return {
    command: () => {
      try {
        return Promise.resolve(respond());
      } catch (error: unknown) {
        return Promise.reject(error);
      }
    },
  };
}

/** `subscribe` is optional on the contract; every adapter here has it. */
function subscribeTo(
  adapter: StorageAdapter,
  key: string,
  onChange: (stored: StoredValue | null) => void
): () => void {
  assert.ok(adapter.subscribe, 'the adapter should support subscribe');
  return adapter.subscribe(key, onChange);
}

/** `remove` is optional on the contract; every adapter here has it. */
async function removeFrom(
  adapter: StorageAdapter,
  key: string,
  options: { readonly signal: AbortSignal }
): Promise<StoreResult<null>> {
  assert.ok(adapter.remove, 'the adapter should implement remove');
  return adapter.remove(key, options);
}

function redisError(message: string): Error {
  return new Error(message);
}

runConformance('redisAdapter on an in-memory Redis', {
  ownWrites: 'notifies',
  create: () => {
    const redis = fakeRedis();
    return {
      adapter: redisAdapter({ client: redis }),
      reopen: () => redisAdapter({ client: redis }),
    };
  },
});

void describe('redisAdapter against an in-memory Redis', () => {
  void it('keeps each key as a hash under the prefix', async () => {
    const redis = fakeRedis();
    const adapter = redisAdapter({ client: redis, prefix: 'app:' });
    expectOk(await adapter.set('theme', 'dark', { signal }));
    assert.deepEqual(redis.hashes.get('app:theme'), { r: '1', v: 'dark' });
  });

  void it('defaults the prefix to "storage:" and allows none', async () => {
    const redis = fakeRedis();
    expectOk(await redisAdapter({ client: redis }).set('a', '1', { signal }));
    expectOk(
      await redisAdapter({ client: redis, prefix: '' }).set('b', '2', {
        signal,
      })
    );
    assert.deepEqual([...redis.hashes.keys()].sort(), ['b', 'storage:a']);
  });

  void it('keeps two prefixes apart', async () => {
    const redis = fakeRedis();
    const first = redisAdapter({ client: redis, prefix: 'one:' });
    const second = redisAdapter({ client: redis, prefix: 'two:' });
    expectOk(await first.set('k', 'first', { signal }));
    assert.deepEqual(await second.get('k', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('sends the expiry with every write', async () => {
    const redis = fakeRedis();
    const adapter = redisAdapter({ client: redis, ttlSeconds: 90 });
    expectOk(await adapter.set('k', 'v', { signal }));
    // ARGV 4 of the script is the expiry.
    assert.equal(redis.commands[0]?.[7], '90');
    expectOk(await redisAdapter({ client: redis }).set('k2', 'v', { signal }));
    assert.equal(redis.commands[1]?.[7], '0');
  });

  void it('refuses a ttlSeconds that is not a whole number, before talking to Redis', async () => {
    for (const ttlSeconds of [-1, 1.5, Number.NaN]) {
      const redis = fakeRedis();
      const adapter = redisAdapter({ client: redis, ttlSeconds });
      const message = expectFailure(
        await adapter.set('k', 'v', { signal }),
        'invalid',
        'k'
      );
      assert.match(message, /ttlSeconds/);
      assert.equal(redis.commands.length, 0);
    }
  });

  void describe('revisions', () => {
    void it('reports the revision that is stored on a conflict', async () => {
      const redis = fakeRedis();
      const adapter = redisAdapter({ client: redis });
      const first = expectOk(await adapter.set('k', 'v1', { signal }));
      expectOk(
        await adapter.set('k', 'v2', {
          signal,
          ifRevision: first.revision ?? '',
        })
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
      assert.equal(redis.hashes.get('storage:k')?.v, 'v2');
    });

    void it('treats a revision that is not a number as a mismatch', async () => {
      const adapter = redisAdapter({ client: fakeRedis() });
      expectOk(await adapter.set('k', 'v', { signal }));
      expectFailure(
        await adapter.set('k', 'w', { signal, ifRevision: 'not a number' }),
        'conflict',
        'k'
      );
    });
  });

  void describe('failures', () => {
    void it('does not talk to Redis once the signal is aborted', async () => {
      const redis = fakeRedis();
      const adapter = redisAdapter({ client: redis });
      const controller = new AbortController();
      controller.abort();
      expectFailure(
        await adapter.get('k', { signal: controller.signal }),
        'unavailable',
        'k'
      );
      expectFailure(
        await adapter.set('k', 'v', { signal: controller.signal }),
        'unavailable',
        'k'
      );
      expectFailure(
        await removeFrom(adapter, 'k', { signal: controller.signal }),
        'unavailable',
        'k'
      );
      assert.equal(redis.commands.length, 0);
    });

    const cases: readonly (readonly [string, string])[] = [
      ['OOM command not allowed when used memory > maxmemory.', 'quota'],
      ['NOPERM this user has no permissions to run the command', 'forbidden'],
      ['NOAUTH Authentication required.', 'forbidden'],
      ['WRONGPASS invalid username-password pair', 'forbidden'],
      ["READONLY You can't write against a read only replica.", 'forbidden'],
      [
        'WRONGTYPE Operation against a key holding the wrong kind of value',
        'corrupt',
      ],
      ['connect ECONNREFUSED 127.0.0.1:6379', 'unavailable'],
    ];
    for (const [message, code] of cases) {
      void it(`maps "${message.slice(0, 24)}..." to ${code}`, async () => {
        const redis = fakeRedis();
        const adapter = redisAdapter({ client: redis });
        redis.failNext = redisError(message);
        expectFailure(await adapter.get('k', { signal }), code, 'k');
        redis.failNext = redisError(message);
        expectFailure(await adapter.set('k', 'v', { signal }), code, 'k');
        redis.failNext = redisError(message);
        expectFailure(await removeFrom(adapter, 'k', { signal }), code, 'k');
      });
    }

    void it('says corrupt for a hash that is not a stored entry', async () => {
      for (const reply of [['x', null], [null, 'v'], 'nonsense']) {
        const adapter = redisAdapter({ client: scriptedClient(() => reply) });
        expectFailure(await adapter.get('k', { signal }), 'corrupt', 'k');
      }
    });

    void it('says corrupt when a write is answered with no revision', async () => {
      const adapter = redisAdapter({
        client: scriptedClient(() => [1, 'abc']),
      });
      expectFailure(await adapter.set('k', 'v', { signal }), 'corrupt', 'k');
    });

    void it('accepts numeric revisions, as some clients return', async () => {
      const adapter = redisAdapter({
        client: scriptedClient(() => [1, 7]),
      });
      assert.equal(
        expectOk(await adapter.set('k', 'v', { signal })).revision,
        '7'
      );
    });

    void it('keeps notifying subscribers after a listener throws', async () => {
      const adapter = redisAdapter({ client: fakeRedis() });
      const heard: (StoredValue | null)[] = [];
      subscribeTo(adapter, 'k', () => {
        throw new Error('listener failure');
      });
      subscribeTo(adapter, 'k', (stored) => heard.push(stored));
      expectOk(await adapter.set('k', 'v', { signal }));
      assert.equal(heard.length, 1);
    });
  });

  void describe('hearing about other processes', () => {
    void it('reports a write made through another adapter on the same prefix', async () => {
      const redis = fakeRedis();
      const listening = redisAdapter({ client: redis, subscriber: redis });
      const writing = redisAdapter({ client: redis });
      const heard: (StoredValue | null)[] = [];
      subscribeTo(listening, 'k', (stored) => heard.push(stored));
      await Promise.resolve();
      expectOk(await writing.set('k', 'from elsewhere', { signal }));
      expectOk(await removeFrom(writing, 'k', { signal }));
      assert.deepEqual(heard, [
        { value: 'from elsewhere', revision: '1' },
        null,
      ]);
    });

    void it('tells the subscriber of its own writes once, not twice', async () => {
      const redis = fakeRedis();
      const adapter = redisAdapter({ client: redis, subscriber: redis });
      const heard: (StoredValue | null)[] = [];
      subscribeTo(adapter, 'k', (stored) => heard.push(stored));
      await Promise.resolve();
      expectOk(await adapter.set('k', 'mine', { signal }));
      assert.equal(heard.length, 1);
    });

    void it('only reports the key that was subscribed to', async () => {
      const redis = fakeRedis();
      const listening = redisAdapter({ client: redis, subscriber: redis });
      const writing = redisAdapter({ client: redis });
      const heard: (StoredValue | null)[] = [];
      subscribeTo(listening, 'wanted', (stored) => heard.push(stored));
      await Promise.resolve();
      expectOk(await writing.set('other', 'x', { signal }));
      assert.deepEqual(heard, []);
    });

    void it('listens once for any number of subscriptions, and stops with the last', async () => {
      const redis = fakeRedis();
      const adapter = redisAdapter({ client: redis, subscriber: redis });
      const stopFirst = subscribeTo(adapter, 'a', () => undefined);
      const stopSecond = subscribeTo(adapter, 'b', () => undefined);
      await Promise.resolve();
      assert.equal(redis.activeSubscriptions(), 1);
      stopFirst();
      stopFirst();
      await Promise.resolve();
      assert.equal(redis.activeSubscriptions(), 1);
      stopSecond();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(redis.activeSubscriptions(), 0);
    });

    void it('ignores a message that is not a change notice', async () => {
      let deliver: ((message: string) => void) | null = null;
      const subscriber: RedisSubscriberLike = {
        subscribe: (_channel, onMessage) => {
          deliver = onMessage;
          return Promise.resolve(() => undefined);
        },
      };
      const adapter = redisAdapter({ client: fakeRedis(), subscriber });
      const heard: (StoredValue | null)[] = [];
      subscribeTo(adapter, 'k', (stored) => heard.push(stored));
      await Promise.resolve();
      for (const message of ['not json', '42', '{}', '{"k":"k","v":5}']) {
        (deliver as ((message: string) => void) | null)?.(message);
      }
      assert.deepEqual(heard, []);
    });

    void it('reports a subscriber that cannot start, and keeps working', async () => {
      const redis = fakeRedis();
      redis.failSubscribe = new Error('connection closed');
      const problems: string[] = [];
      const adapter = redisAdapter({
        client: redis,
        subscriber: redis,
        onSubscriberError: (message) => problems.push(message),
      });
      const heard: (StoredValue | null)[] = [];
      subscribeTo(adapter, 'k', (stored) => heard.push(stored));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? '', /connection closed/);
      expectOk(await adapter.set('k', 'v', { signal }));
      assert.equal(heard.length, 1, 'own writes are still reported');
    });
  });
});

const redisUrl: string | undefined = process.env.TEST_REDIS_URL;

void describe('redisAdapter against a real Redis server', () => {
  if (redisUrl === undefined) {
    void it('is skipped: set TEST_REDIS_URL to run it', { skip: true }, () => {
      /* nothing to run */
    });
    return;
  }
  const url: string = redisUrl;
  const closers: (() => Promise<unknown>)[] = [];
  after(async () => {
    for (const close of closers) {
      await close();
    }
  });

  const ioredis = (): Redis => {
    const connection = new Redis(url);
    closers.push(() => connection.quit());
    return connection;
  };

  const nodeRedis = async () => {
    const connection = createClient({ url });
    await connection.connect();
    closers.push(() => connection.quit());
    return connection;
  };

  const freshPrefix = (): string => `test-${randomBytes(6).toString('hex')}:`;

  const deleteAll = async (prefix: string): Promise<void> => {
    const connection = new Redis(url);
    try {
      const keys: string[] = await connection.keys(`${prefix}*`);
      if (keys.length > 0) {
        await connection.del(...keys);
      }
    } finally {
      await connection.quit();
    }
  };

  const waitFor = async (condition: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(condition(), 'timed out waiting');
  };

  const shared: Redis = ioredis();

  runConformance('redisAdapter on a real server through ioredis', {
    ownWrites: 'notifies',
    create: () => {
      const prefix: string = freshPrefix();
      return {
        adapter: redisAdapter({
          client: redisCommandsFromIoredis(shared),
          prefix,
        }),
        reopen: () =>
          redisAdapter({ client: redisCommandsFromIoredis(shared), prefix }),
        cleanup: () => deleteAll(prefix),
      };
    },
  });

  void describe('through node-redis', () => {
    void it('passes the contract basics', async () => {
      const prefix: string = freshPrefix();
      const adapter: StorageAdapter = redisAdapter({
        client: redisCommandsFromNodeRedis(await nodeRedis()),
        prefix,
      });
      try {
        const first = expectOk(await adapter.set('k', 'v1', { signal }));
        assert.deepEqual(await adapter.get('k', { signal }), {
          ok: true,
          value: first,
        });
        expectOk(
          await adapter.set('k', 'v2', {
            signal,
            ifRevision: first.revision ?? '',
          })
        );
        expectFailure(
          await adapter.set('k', 'v3', {
            signal,
            ifRevision: first.revision ?? '',
          }),
          'conflict',
          'k'
        );
        expectOk(await removeFrom(adapter, 'k', { signal }));
        assert.deepEqual(await adapter.get('k', { signal }), {
          ok: true,
          value: null,
        });
      } finally {
        await deleteAll(prefix);
      }
    });
  });

  void describe('on the server', () => {
    void it('stores a hash with the revision and the value', async () => {
      const prefix: string = freshPrefix();
      try {
        const adapter = redisAdapter({
          client: redisCommandsFromIoredis(shared),
          prefix,
        });
        expectOk(await adapter.set('k', 'v', { signal }));
        expectOk(await adapter.set('k', 'w', { signal }));
        assert.deepEqual(await shared.hgetall(`${prefix}k`), {
          r: '2',
          v: 'w',
        });
      } finally {
        await deleteAll(prefix);
      }
    });

    void it('expires a key after ttlSeconds, and its revision starts again', async () => {
      const prefix: string = freshPrefix();
      try {
        const adapter = redisAdapter({
          client: redisCommandsFromIoredis(shared),
          prefix,
          ttlSeconds: 1,
        });
        expectOk(await adapter.set('k', 'v', { signal }));
        assert.ok((await shared.ttl(`${prefix}k`)) > 0);
        await new Promise((resolve) => setTimeout(resolve, 1300));
        assert.deepEqual(await adapter.get('k', { signal }), {
          ok: true,
          value: null,
        });
        const again = expectOk(await adapter.set('k', 'v', { signal }));
        assert.equal(again.revision, '1');
      } finally {
        await deleteAll(prefix);
      }
    });

    void it('says corrupt for a key that holds another type, and writes nothing', async () => {
      const prefix: string = freshPrefix();
      try {
        await shared.set(`${prefix}k`, 'plain string');
        const adapter = redisAdapter({
          client: redisCommandsFromIoredis(shared),
          prefix,
        });
        expectFailure(await adapter.get('k', { signal }), 'corrupt', 'k');
        expectFailure(await adapter.set('k', 'v', { signal }), 'corrupt', 'k');
        assert.equal(await shared.get(`${prefix}k`), 'plain string');
      } finally {
        await deleteAll(prefix);
      }
    });

    void it('stores values with unusual text exactly', async () => {
      const prefix: string = freshPrefix();
      try {
        const adapter = redisAdapter({
          client: redisCommandsFromIoredis(shared),
          prefix,
        });
        for (const value of [
          '',
          ' ',
          'line\nbreak',
          '日本語 😀',
          '"quoted"',
          'x'.repeat(100_000),
        ]) {
          expectOk(await adapter.set('k', value, { signal }));
          assert.equal(
            expectOk(await adapter.get('k', { signal }))?.value,
            value
          );
        }
      } finally {
        await deleteAll(prefix);
      }
    });

    void it('never loses an increment when two connections race with ifRevision', async () => {
      const prefix: string = freshPrefix();
      try {
        const first = redisAdapter({
          client: redisCommandsFromIoredis(ioredis()),
          prefix,
        });
        const second = redisAdapter({
          client: redisCommandsFromIoredis(ioredis()),
          prefix,
        });
        const add = async (adapter: StorageAdapter): Promise<void> => {
          for (let done = 0; done < 40;) {
            const read = await adapter.get('counter', { signal });
            assert.ok(read.ok, JSON.stringify(read));
            const written = await adapter.set(
              'counter',
              String(Number(read.value?.value ?? '0') + 1),
              {
                signal,
                ...(read.value?.revision === undefined
                  ? {}
                  : { ifRevision: read.value.revision }),
              }
            );
            if (written.ok) {
              done += 1;
            } else {
              assert.equal(written.code, 'conflict', JSON.stringify(written));
            }
          }
        };
        assert.ok((await first.set('counter', '0', { signal })).ok);
        await Promise.all([add(first), add(second)]);
        assert.equal(
          expectOk(await first.get('counter', { signal }))?.value,
          '80'
        );
      } finally {
        await deleteAll(prefix);
      }
    });
  });

  void describe('hearing about other processes', () => {
    void it("reports another adapter's writes through ioredis", async () => {
      const prefix: string = freshPrefix();
      try {
        const listening = redisAdapter({
          client: redisCommandsFromIoredis(shared),
          prefix,
          subscriber: redisSubscriberFromIoredis(ioredis()),
        });
        const writing = redisAdapter({
          client: redisCommandsFromIoredis(ioredis()),
          prefix,
        });
        const heard: (StoredValue | null)[] = [];
        const stop = subscribeTo(listening, 'k', (stored) =>
          heard.push(stored)
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expectOk(await writing.set('k', 'hello', { signal }));
        expectOk(await removeFrom(writing, 'k', { signal }));
        await waitFor(() => heard.length >= 2);
        assert.deepEqual(heard, [{ value: 'hello', revision: '1' }, null]);
        stop();
      } finally {
        await deleteAll(prefix);
      }
    });

    void it("reports another adapter's writes through node-redis", async () => {
      const prefix: string = freshPrefix();
      try {
        const subscriberConnection = (await nodeRedis()).duplicate();
        await subscriberConnection.connect();
        closers.push(() => subscriberConnection.quit());
        const listening = redisAdapter({
          client: redisCommandsFromIoredis(shared),
          prefix,
          subscriber: redisSubscriberFromNodeRedis(subscriberConnection),
        });
        const writing = redisAdapter({
          client: redisCommandsFromIoredis(shared),
          prefix,
        });
        const heard: (StoredValue | null)[] = [];
        const stop = subscribeTo(listening, 'k', (stored) =>
          heard.push(stored)
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expectOk(await writing.set('k', 'hello', { signal }));
        await waitFor(() => heard.length >= 1);
        assert.deepEqual(heard, [{ value: 'hello', revision: '1' }]);
        stop();
      } finally {
        await deleteAll(prefix);
      }
    });
  });
});
