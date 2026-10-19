/**
 * The Memcached adapter, over an in-memory stand-in for a Memcached client
 * (test/support/fake-memcached.ts), so the default test run stays offline.
 * test/memcached-server.test.ts runs the same adapter against a real server.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  memcachedAdapter,
  memcachedFromMemcacheClient,
  type MemcachedAdapterOptions,
  type MemcacheClientLike,
} from '../src/memcached/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeMemcached } from './support/fake-memcached.js';

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
  assert.ok(result.error.startsWith('Memcached '), result.error);
  return result.error;
}

function adapterFor(
  memcached: FakeMemcached,
  more: Partial<MemcachedAdapterOptions> = {}
): StorageAdapter {
  return memcachedAdapter({ client: memcached, ...more });
}

const removeKey = async (
  adapter: StorageAdapter,
  key: string
): Promise<StoreResult<null>> =>
  adapter.remove?.(key, { signal }) ?? { ok: true, value: null };

runConformance('memcachedAdapter over a fake client', {
  ownWrites: 'notifies',
  create: () => {
    const memcached = new FakeMemcached();
    return {
      adapter: adapterFor(memcached),
      reopen: () => adapterFor(memcached),
    };
  },
});

void describe('memcachedAdapter: keys', () => {
  void it('stores each entry under a prefixed, escaped key', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached);
    expectOk(await adapter.set('theme', 'dark', { signal }));
    expectOk(await adapter.set('user/1 é😀', 'v', { signal }));
    assert.deepEqual([...memcached.items.keys()].sort(), [
      'storage:theme',
      'storage:user=2F1=20=C3=A9=F0=9F=98=80',
    ]);
    assert.equal(
      expectOk(await adapter.get('user/1 é😀', { signal }))?.value,
      'v'
    );
  });

  void it('keeps look-alike keys apart', async () => {
    const adapter = adapterFor(new FakeMemcached());
    for (const key of ['a', 'A', 'a ', ' a', 'a.b', 'a=b', 'a=3Db', 'café']) {
      expectOk(await adapter.set(key, `value of ${key}`, { signal }));
    }
    for (const key of ['a', 'A', 'a ', ' a', 'a.b', 'a=b', 'a=3Db', 'café']) {
      assert.equal(
        expectOk(await adapter.get(key, { signal }))?.value,
        `value of ${key}`
      );
    }
  });

  void it('uses a prefix to keep adapters apart, and refuses one it cannot use', async () => {
    const memcached = new FakeMemcached();
    const first = adapterFor(memcached, { prefix: 'a:' });
    const second = adapterFor(memcached, { prefix: 'b:' });
    expectOk(await first.set('k', '1', { signal }));
    expectOk(await second.set('k', '2', { signal }));
    assert.equal(expectOk(await first.get('k', { signal }))?.value, '1');
    const none = adapterFor(memcached, { prefix: '' });
    expectOk(await none.set('plain', 'v', { signal }));
    assert.ok(memcached.items.has('plain'));
    const bad = adapterFor(memcached, { prefix: 'has space:' });
    const message = expectFailure(
      await bad.get('k', { signal }),
      'invalid',
      'k'
    );
    assert.match(message, /cannot use prefix "has space:"/);
  });

  void it('refuses keys Memcached cannot hold, without asking it', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached);
    expectFailure(
      await adapter.set('\ud800', 'v', { signal }),
      'invalid',
      '\ud800'
    );
    const long = 'k'.repeat(300);
    const message = expectFailure(
      await adapter.get(long, { signal }),
      'invalid',
      long
    );
    assert.match(message, /1 to 250 characters/);
    assert.deepEqual(memcached.calls, []);
  });

  void it('passes the ttl on every write, and refuses one Memcached would misread', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached, { ttlSeconds: 60 });
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('k', 'two', { signal }));
    assert.deepEqual(memcached.ttls, [60, 60]);
    for (const ttlSeconds of [-1, 1.5, 2_592_001]) {
      const bad = adapterFor(memcached, { ttlSeconds });
      expectFailure(await bad.set('k', 'v', { signal }), 'invalid', 'k');
    }
    assert.equal(memcached.ttls.length, 2);
  });
});

void describe('memcachedAdapter: revisions', () => {
  void it('counts revisions per key from 1', async () => {
    const adapter = adapterFor(new FakeMemcached());
    const first = expectOk(await adapter.set('a', 'x', { signal }));
    const second = expectOk(await adapter.set('a', 'y', { signal }));
    const other = expectOk(await adapter.set('b', 'z', { signal }));
    assert.deepEqual(
      [first.revision, second.revision, other.revision],
      ['1', '2', '1']
    );
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
      value: 'y',
      revision: '2',
    });
  });

  void it('writes when the revision matches and reports a conflict when it does not', async () => {
    const adapter = adapterFor(new FakeMemcached());
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('k', 'two', { signal }));
    const message = expectFailure(
      await adapter.set('k', 'three', { signal, ifRevision: '1' }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 2, but revision 1 was expected/);
    const next = expectOk(
      await adapter.set('k', 'three', { signal, ifRevision: '2' })
    );
    assert.equal(next.revision, '3');
  });

  void it('creates a key with nothing stored, even when given a revision', async () => {
    const adapter = adapterFor(new FakeMemcached());
    expectOk(await adapter.set('k', 'v', { signal, ifRevision: '41' }));
    expectOk(await removeKey(adapter, 'k'));
    const again = expectOk(
      await adapter.set('k', 'again', { signal, ifRevision: '1' })
    );
    assert.equal(again.revision, '1');
  });

  void it('treats text that is not a revision as one that never matches', async () => {
    const adapter = adapterFor(new FakeMemcached());
    expectOk(await adapter.set('k', 'v', { signal }));
    for (const ifRevision of ['abc', '', '1.5', '01x']) {
      expectFailure(
        await adapter.set('k', 'w', { signal, ifRevision }),
        'conflict',
        'k'
      );
    }
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'v');
  });

  void it('starts a key that expired or was evicted again at revision 1', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached);
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await adapter.set('k', 'w', { signal }));
    memcached.evict('storage:k');
    assert.equal(expectOk(await adapter.get('k', { signal })), null);
    assert.equal(
      expectOk(await adapter.set('k', 'again', { signal })).revision,
      '1'
    );
  });
});

void describe('memcachedAdapter: races', () => {
  void it('reports a conflict, and writes nothing, when another process wrote between the read and the write', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached);
    expectOk(await adapter.set('k', 'one', { signal }));
    let sneaked = false;
    memcached.beforeStore = (key) => {
      if (!sneaked) {
        sneaked = true;
        memcached.overwrite(key, JSON.stringify({ r: 2, v: 'sneaked in' }));
      }
    };
    const message = expectFailure(
      await adapter.set('k', 'mine', { signal, ifRevision: '1' }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 2, but revision 1 was expected/);
    assert.equal(
      expectOk(await adapter.get('k', { signal }))?.value,
      'sneaked in'
    );
  });

  void it('writes on top of a concurrent write when no revision was asked for', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached);
    expectOk(await adapter.set('k', 'one', { signal }));
    let sneaked = false;
    memcached.beforeStore = (key) => {
      if (!sneaked) {
        sneaked = true;
        memcached.overwrite(key, JSON.stringify({ r: 2, v: 'sneaked in' }));
      }
    };
    const stored = expectOk(await adapter.set('k', 'mine', { signal }));
    assert.equal(stored.revision, '3');
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'mine');
  });

  void it('creates the key when it expired between the read and the write of a checked update', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached);
    expectOk(await adapter.set('k', 'one', { signal }));
    let expired = false;
    memcached.beforeStore = (key) => {
      if (!expired) {
        expired = true;
        memcached.evict(key);
      }
    };
    const stored = expectOk(
      await adapter.set('k', 'two', { signal, ifRevision: '1' })
    );
    assert.equal(stored.revision, '1');
  });

  void it('gives up on a write that always meets a newer version', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached);
    expectOk(await adapter.set('k', 'one', { signal }));
    let revision = 1;
    memcached.beforeStore = (key) => {
      revision += 1;
      memcached.overwrite(key, JSON.stringify({ r: revision, v: 'again' }));
    };
    const message = expectFailure(
      await adapter.set('k', 'mine', { signal }),
      'conflict',
      'k'
    );
    assert.match(message, /kept changing.*gave up after 12 tries/);
  });
});

void describe('memcachedAdapter: failures', () => {
  void it('reads a value that is not an entry as corrupt, and lets a remove clear it', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached);
    memcached.overwrite('storage:k', 'plain text from something else');
    const message = expectFailure(
      await adapter.get('k', { signal }),
      'corrupt',
      'k'
    );
    assert.match(message, /remove the key to start again/);
    expectFailure(await adapter.set('k', 'v', { signal }), 'corrupt', 'k');
    memcached.overwrite('storage:k', JSON.stringify({ r: 0, v: 'x' }));
    expectFailure(await adapter.get('k', { signal }), 'corrupt', 'k');
    expectOk(await removeKey(adapter, 'k'));
    expectOk(await adapter.set('k', 'v', { signal }));
  });

  const cases: readonly [string, string][] = [
    ['SERVER_ERROR object too large for cache', 'invalid'],
    ['SERVER_ERROR out of memory storing object', 'quota'],
    ['CLIENT_ERROR bad command line format', 'invalid'],
    ['connect ECONNREFUSED 127.0.0.1:11211', 'unavailable'],
    ['socket timeout', 'unavailable'],
  ];
  for (const [message, code] of cases) {
    void it(`maps "${message}" to ${code}, naming the key`, async () => {
      const memcached = new FakeMemcached();
      const adapter = adapterFor(memcached);
      memcached.failures.push(new Error(message));
      const error = expectFailure(
        await adapter.get('k', { signal }),
        code,
        'k'
      );
      assert.ok(error.includes(message), error);
      expectOk(await adapter.set('k', 'v', { signal }));
      memcached.failures.push(new Error(message));
      expectFailure(await removeKey(adapter, 'k'), code, 'k');
    });
  }

  void it('reports a failed write, not a conflict, when the store itself errors', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached);
    memcached.beforeStore = () => {
      throw new Error('SERVER_ERROR object too large for cache');
    };
    const message = expectFailure(
      await adapter.set('k', 'v', { signal }),
      'invalid',
      'k'
    );
    assert.match(message, /item size limit/);
  });

  void it('does not touch the client when the request was aborted', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached);
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
      (await adapter.remove?.('k', { signal: controller.signal })) ?? {
        ok: true,
        value: null,
      },
      'unavailable',
      'k'
    );
    assert.deepEqual(memcached.calls, []);
  });

  void it('does not offer list, which Memcached cannot do', () => {
    const adapter = adapterFor(new FakeMemcached());
    assert.equal(adapter.list, undefined);
  });
});

void describe('memcachedAdapter: subscribe', () => {
  void it('reports writes and removals made through the same adapter, once each', async () => {
    const adapter = adapterFor(new FakeMemcached());
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
      (() => undefined);
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('other', 'x', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    stop();
    expectOk(await adapter.set('k', 'two', { signal }));
    assert.deepEqual(seen, [{ value: 'one', revision: '1' }, null]);
  });

  void it('reports a write that needed a retry once, with the revision it ended with', async () => {
    const memcached = new FakeMemcached();
    const adapter = adapterFor(memcached);
    expectOk(await adapter.set('k', 'one', { signal }));
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
      (() => undefined);
    let sneaked = false;
    memcached.beforeStore = (key) => {
      if (!sneaked) {
        sneaked = true;
        memcached.overwrite(key, JSON.stringify({ r: 2, v: 'sneaked in' }));
      }
    };
    expectOk(await adapter.set('k', 'mine', { signal }));
    stop();
    assert.deepEqual(seen, [{ value: 'mine', revision: '3' }]);
  });

  void it('does not report a write that lost a conflict', async () => {
    const adapter = adapterFor(new FakeMemcached());
    expectOk(await adapter.set('k', 'one', { signal }));
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
      (() => undefined);
    expectFailure(
      await adapter.set('k', 'two', { signal, ifRevision: '9' }),
      'conflict',
      'k'
    );
    stop();
    assert.equal(seen.length, 0);
  });
});

/** A client that answers the way `memcache-client` does. */
class FakeMemcacheClient implements MemcacheClientLike {
  readonly calls: string[] = [];
  reply: unknown = undefined;
  rejectWith: Error | null = null;
  gets(key: string): Promise<unknown> {
    this.calls.push(`gets ${key}`);
    return Promise.resolve(this.reply);
  }
  add(
    key: string,
    value: string,
    options: { lifetime: number }
  ): Promise<unknown> {
    this.calls.push(`add ${key} ${value} ${String(options.lifetime)}`);
    return this.rejectWith === null
      ? Promise.resolve(['STORED'])
      : Promise.reject(this.rejectWith);
  }
  cas(
    key: string,
    value: string,
    options: { casUniq: string; lifetime: number }
  ): Promise<unknown> {
    this.calls.push(
      `cas ${key} ${value} ${options.casUniq} ${String(options.lifetime)}`
    );
    return this.rejectWith === null
      ? Promise.resolve(['STORED'])
      : Promise.reject(this.rejectWith);
  }
  delete(key: string): Promise<unknown> {
    this.calls.push(`delete ${key}`);
    return this.rejectWith === null
      ? Promise.resolve(['DELETED'])
      : Promise.reject(this.rejectWith);
  }
}

void describe('memcachedFromMemcacheClient', () => {
  void it('turns the status words memcache-client rejects with into outcomes', async () => {
    const fake = new FakeMemcacheClient();
    const client = memcachedFromMemcacheClient(fake);
    assert.equal(await client.add('k', 'v', { ttlSeconds: 5 }), 'stored');
    assert.equal(await client.cas('k', 'v', '7', { ttlSeconds: 5 }), 'stored');
    fake.rejectWith = new Error('NOT_STORED');
    assert.equal(await client.add('k', 'v', { ttlSeconds: 0 }), 'not_stored');
    fake.rejectWith = new Error('EXISTS');
    assert.equal(await client.cas('k', 'v', '7', { ttlSeconds: 0 }), 'exists');
    fake.rejectWith = new Error('NOT_FOUND');
    assert.equal(
      await client.cas('k', 'v', '7', { ttlSeconds: 0 }),
      'not_found'
    );
    await client.delete('k'); // deleting nothing is fine
    assert.deepEqual(fake.calls.slice(0, 2), ['add k v 5', 'cas k v 7 5']);
  });

  void it('lets every other error through', async () => {
    const fake = new FakeMemcacheClient();
    const client = memcachedFromMemcacheClient(fake);
    fake.rejectWith = new Error('SERVER_ERROR object too large for cache');
    await assert.rejects(client.add('k', 'v', { ttlSeconds: 0 }), /too large/);
    await assert.rejects(
      client.cas('k', 'v', '1', { ttlSeconds: 0 }),
      /too large/
    );
    await assert.rejects(client.delete('k'), /too large/);
    fake.rejectWith = new Error('connect ECONNREFUSED');
    await assert.rejects(client.delete('k'), /ECONNREFUSED/);
  });

  void it('reads a miss as null, a hit as text and a token, and anything else as not ours', async () => {
    const fake = new FakeMemcacheClient();
    const client = memcachedFromMemcacheClient(fake);
    assert.equal(await client.gets('k'), null);
    fake.reply = { tokens: [], casUniq: '12', value: '{"r":1,"v":"x"}' };
    assert.deepEqual(await client.gets('k'), {
      value: '{"r":1,"v":"x"}',
      casUniq: '12',
    });
    fake.reply = { tokens: [], casUniq: 13, value: 'text' };
    assert.deepEqual(await client.gets('k'), { value: 'text', casUniq: '13' });
    fake.reply = { tokens: [], casUniq: '14', value: Buffer.from('bytes') };
    assert.deepEqual(await client.gets('k'), { value: '', casUniq: '14' });
  });

  void it('works end to end with the adapter', async () => {
    const fake = new FakeMemcacheClient();
    const adapter = memcachedAdapter({
      client: memcachedFromMemcacheClient(fake),
      ttlSeconds: 30,
    });
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.equal(fake.calls[1], 'add storage:k {"r":1,"v":"v"} 30');
    fake.reply = { tokens: [], casUniq: '99', value: '{"r":4,"v":"old"}' };
    expectOk(await adapter.set('k', 'new', { signal }));
    assert.equal(fake.calls.at(-1), 'cas storage:k {"r":5,"v":"new"} 99 30');
  });
});
