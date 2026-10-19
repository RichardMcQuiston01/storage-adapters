import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { realtimeDatabaseAdapter } from '../src/firebase/realtime.js';
import {
  keyFromRealtimeNodeKey,
  realtimeNodeKey,
} from '../src/firebase/realtime-keys.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { fakeRealtime, realtimeError } from './support/fake-realtime.js';

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
  assert.ok(result.error.startsWith('Realtime Database '), result.error);
  assert.ok(result.error.includes(`"${subject}"`), result.error);
  return result.error;
}

async function listKeys(
  adapter: StorageAdapter,
  prefix: string
): Promise<StoreResult<string[]>> {
  if (adapter.list === undefined) {
    assert.fail('the adapter should list');
  }
  return adapter.list(prefix, { signal });
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
};

runConformance('realtimeDatabaseAdapter on an in-memory node', {
  ownWrites: 'notifies',
  create: () => {
    const store = fakeRealtime();
    return {
      adapter: realtimeDatabaseAdapter({ store }),
      reopen: () => realtimeDatabaseAdapter({ store }),
    };
  },
});

void describe('realtimeNodeKey', () => {
  void it('starts with k and escapes what the database refuses in a name', () => {
    assert.equal(realtimeNodeKey('abc'), 'kabc');
    assert.equal(realtimeNodeKey('a/b'), 'ka%2Fb');
    assert.equal(realtimeNodeKey('a.b$c#d[e]f'), 'ka%2Eb%24c%23d%5Be%5Df');
    assert.equal(realtimeNodeKey('50%'), 'k50%25');
    assert.equal(realtimeNodeKey('a\nb'), 'ka%0Ab');
    assert.equal(realtimeNodeKey('é'), 'ké');
  });

  void it('never looks like an integer, so the database keeps it a map', () => {
    assert.equal(realtimeNodeKey('0'), 'k0');
    assert.equal(realtimeNodeKey('123'), 'k123');
  });

  void it('is reversible and gives different names to different keys', () => {
    const keys: string[] = ['a.b', 'a%2Eb', 'a/b', '', '😀', 'x\u007fy', '0'];
    const names = new Set<string>();
    for (const key of keys) {
      const name: string = realtimeNodeKey(key) ?? '';
      assert.ok(!/[.$#[\]/]/.test(name), name);
      assert.equal(keyFromRealtimeNodeKey(name), key);
      names.add(name);
    }
    assert.equal(names.size, keys.length);
  });

  void it('refuses a lone surrogate and a name over 768 bytes', () => {
    assert.equal(realtimeNodeKey('\ud800'), null);
    assert.equal(realtimeNodeKey('a'.repeat(767)) === null, false);
    assert.equal(realtimeNodeKey('a'.repeat(768)), null);
    assert.equal(keyFromRealtimeNodeKey('nope'), null);
  });
});

void describe('realtimeDatabaseAdapter', () => {
  void it('stores each key in its own node with the documented fields', async () => {
    const store = fakeRealtime();
    const adapter = realtimeDatabaseAdapter({
      store,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });
    expectOk(await adapter.set('a/b', 'v', { signal }));
    assert.deepEqual(store.nodes.get('ka%2Fb'), {
      entry_key: 'a/b',
      entry_value: 'v',
      revision: 1,
      created_at: '2026-01-02T03:04:05.000Z',
      updated_at: '2026-01-02T03:04:05.000Z',
    });
  });

  void it('reports conflict with the key and both revisions', async () => {
    const adapter = realtimeDatabaseAdapter({ store: fakeRealtime() });
    expectOk(await adapter.set('k', 'v', { signal }));
    const error = expectFailure(
      await adapter.set('k', 'w', { signal, ifRevision: '9' }),
      'conflict',
      'k'
    );
    assert.ok(error.includes('revision 1') && error.includes('9'), error);
  });

  void it('runs the decision again when the database retries the transaction', async () => {
    const store = fakeRealtime();
    store.rerunTransactions = 3;
    const adapter = realtimeDatabaseAdapter({ store });
    const first = expectOk(await adapter.set('k', 'v', { signal }));
    const second = expectOk(
      await adapter.set('k', 'w', { signal, ifRevision: first?.revision ?? '' })
    );
    assert.equal(second.revision, '2');
  });

  void it('reports a node that is not an entry as corrupt', async () => {
    const store = fakeRealtime();
    store.nodes.set('kbad', { entry_value: 5 });
    const adapter = realtimeDatabaseAdapter({ store });
    expectFailure(await adapter.get('bad', { signal }), 'corrupt', 'bad');
    expectFailure(
      await adapter.set('bad', 'v', { signal, ifRevision: '1' }),
      'corrupt',
      'bad'
    );
    expectOk(await adapter.set('bad', 'v', { signal }));
  });

  void it('maps SDK errors to codes and names the key', async () => {
    const store = fakeRealtime();
    const adapter = realtimeDatabaseAdapter({ store });
    store.failNext.get = realtimeError('Permission denied');
    expectFailure(await adapter.get('k', { signal }), 'forbidden', 'k');
    store.failNext.transact = realtimeError(
      'Index or value is greater than 10485760 UTF8 bytes'
    );
    expectFailure(await adapter.set('k', 'v', { signal }), 'invalid', 'k');
    store.failNext.transact = realtimeError('quota exceeded');
    expectFailure(await adapter.set('k', 'v', { signal }), 'quota', 'k');
    store.failNext.list = realtimeError('socket closed');
    const listed = await adapter.list?.('', { signal });
    assert.equal(listed?.ok, false);
    if (listed !== undefined && !listed.ok) {
      assert.equal(listed.code, 'unavailable');
    }
  });

  void it('refuses keys and values the database cannot hold, without calling it', async () => {
    const store = fakeRealtime();
    const adapter = realtimeDatabaseAdapter({ store });
    expectFailure(
      await adapter.set('\ud800', 'v', { signal }),
      'invalid',
      '\ud800'
    );
    expectFailure(
      await adapter.set('big', 'x'.repeat(10_000_001), { signal }),
      'invalid',
      'big'
    );
    assert.deepEqual(store.calls, []);
  });

  void it('does not touch the store when aborted', async () => {
    const store = fakeRealtime();
    const adapter = realtimeDatabaseAdapter({ store });
    const aborted: AbortSignal = AbortSignal.abort();
    expectFailure(
      await adapter.get('k', { signal: aborted }),
      'unavailable',
      'k'
    );
    assert.deepEqual(store.calls, []);
  });

  void it('lists keys with a prefix, decoded and sorted', async () => {
    const store = fakeRealtime();
    const adapter = realtimeDatabaseAdapter({ store });
    for (const key of ['a/2', 'a/1', 'a.x', 'b', 'a']) {
      expectOk(await adapter.set(key, 'v', { signal }));
    }
    assert.deepEqual(expectOk(await listKeys(adapter, 'a/')), ['a/1', 'a/2']);
    assert.deepEqual(expectOk(await listKeys(adapter, 'a')), [
      'a',
      'a.x',
      'a/1',
      'a/2',
    ]);
  });

  void it('tells subscribers once per change and not about the starting value', async () => {
    const store = fakeRealtime();
    const adapter = realtimeDatabaseAdapter({ store });
    expectOk(await adapter.set('k', 'v', { signal }));
    const seen: (StoredValue | null)[] = [];
    const stop = adapter.subscribe?.('k', (stored) => seen.push(stored));
    await settle();
    assert.deepEqual(seen, []);
    expectOk(await adapter.set('k', 'w', { signal }));
    await settle();
    store.push('kk'); // A repeat of what was reported.
    await settle();
    assert.deepEqual(seen, [{ value: 'w', revision: '2' }]);
    stop?.();
    assert.equal(store.watchers.get('kk'), 0);
  });

  void it('calls onWatchError when a listener fails', async () => {
    const store = fakeRealtime();
    const problems: string[] = [];
    const adapter = realtimeDatabaseAdapter({
      store,
      onWatchError: (key, message) => problems.push(`${key}: ${message}`),
    });
    adapter.subscribe?.('k', () => undefined);
    await settle();
    store.failWatchers(realtimeError('Permission denied'));
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('"k"'), problems[0]);
  });
});
