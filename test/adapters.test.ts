import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  memoryAdapter,
  readOnly,
  utf8Length,
  withEncoding,
  withFallback,
  withLogging,
  withPrefix,
  withReadCache,
  withRetry,
  type StorageAdapter,
  type StorageLogEvent,
  type StoreResult,
} from '../src/index.js';

const signal: AbortSignal = new AbortController().signal;

/** Fails the first `failures` calls of every method with `code`. */
function flaky(
  inner: StorageAdapter,
  failures: number,
  code: 'unavailable' | 'quota'
): StorageAdapter & { calls: number } {
  const state = { calls: 0 };
  const guard = <T>(
    run: () => Promise<StoreResult<T>>
  ): Promise<StoreResult<T>> => {
    state.calls += 1;
    if (state.calls <= failures) {
      return Promise.resolve({ ok: false, code, error: `down ${state.calls}` });
    }
    return run();
  };
  return {
    get calls(): number {
      return state.calls;
    },
    get: (key, o) => guard(() => inner.get(key, o)),
    set: (key, value, o) => guard(() => inner.set(key, value, o)),
  };
}

void describe('adapter wrappers', () => {
  void it('memoryAdapter checks revisions', async () => {
    const adapter = memoryAdapter();
    const first = await adapter.set('k', 'one', { signal });
    assert.ok(first.ok);
    const stale = await adapter.set('k', 'two', { signal, ifRevision: '99' });
    assert.ok(!stale.ok && stale.code === 'conflict');
    assert.match(stale.error, /"k"/);
  });

  void it('withPrefix namespaces keys', async () => {
    const inner = memoryAdapter();
    const adapter = withPrefix(inner, 'app1:');
    await adapter.set('k', 'v', { signal });
    const direct = await inner.get('app1:k', { signal });
    assert.ok(direct.ok && direct.value?.value === 'v');
  });

  void it('withFallback reads in order and writes to both', async () => {
    const primary = memoryAdapter();
    const secondary = memoryAdapter({ k: 'local' });
    const adapter = withFallback(primary, secondary);
    const read = await adapter.get('k', { signal });
    assert.ok(read.ok && read.value?.value === 'local');
    await adapter.set('k', 'new', { signal });
    for (const side of [primary, secondary]) {
      const got = await side.get('k', { signal });
      assert.ok(got.ok && got.value?.value === 'new');
    }
  });

  void it('withFallback counts a secondary write as saved when primary is down, but passes conflicts through', async () => {
    const down = flaky(memoryAdapter(), 99, 'unavailable');
    const secondary = memoryAdapter();
    const adapter = withFallback(down, secondary);
    const saved = await adapter.set('k', 'v', { signal });
    assert.ok(saved.ok);
    const conflicted = withFallback(memoryAdapter(), secondary);
    const result = await conflicted.set('k', 'v', { signal, ifRevision: '7' });
    assert.ok(!result.ok && result.code === 'conflict');
  });

  void it('withReadCache reads the store once', async () => {
    let reads = 0;
    const inner = memoryAdapter({ k: 'v' });
    const adapter = withReadCache({
      ...inner,
      get: (key, o) => (reads++, inner.get(key, o)),
    });
    await adapter.get('k', { signal });
    await adapter.get('k', { signal });
    assert.equal(reads, 1);
    await adapter.set('k', 'w', { signal });
    const after = await adapter.get('k', { signal });
    assert.ok(after.ok && after.value?.value === 'w');
    assert.equal(reads, 1);
  });

  void it('readOnly rejects writes with forbidden', async () => {
    const adapter = readOnly(memoryAdapter({ k: 'v' }));
    const read = await adapter.get('k', { signal });
    assert.ok(read.ok);
    const write = await adapter.set('k', 'x', { signal });
    assert.ok(!write.ok && write.code === 'forbidden');
    assert.match(write.error, /read-only/);
  });

  void it('withRetry retries unavailable with doubling waits, and nothing else', async () => {
    const waits: number[] = [];
    const sleeper = (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    };
    const recovers = flaky(memoryAdapter({ k: 'v' }), 2, 'unavailable');
    const adapter = withRetry(recovers, { attempts: 3, sleep: sleeper });
    const read = await adapter.get('k', { signal });
    assert.ok(read.ok);
    assert.deepEqual(waits, [200, 400]);
    const full = flaky(memoryAdapter(), 5, 'quota');
    const quota = await withRetry(full, { sleep: sleeper }).set('k', 'v', {
      signal,
    });
    assert.ok(!quota.ok && quota.code === 'quota');
    assert.equal(full.calls, 1);
  });

  void it('withEncoding round trips and reports a bad decode as corrupt', async () => {
    const inner = memoryAdapter();
    const adapter = withEncoding(inner, {
      encode: (v) => `x${[...v].reverse().join('')}`,
      decode: (v) => {
        if (!v.startsWith('x')) throw new Error('missing marker');
        return [...v.slice(1)].reverse().join('');
      },
    });
    await adapter.set('k', 'hello', { signal });
    const raw = await inner.get('k', { signal });
    assert.ok(raw.ok && raw.value?.value === 'xolleh');
    const back = await adapter.get('k', { signal });
    assert.ok(back.ok && back.value?.value === 'hello');
    await inner.set('bad', 'nope', { signal });
    const bad = await adapter.get('bad', { signal });
    assert.ok(!bad.ok && bad.code === 'corrupt');
    assert.match(bad.error, /"bad".*missing marker/);
  });

  void it('withLogging reports keys and codes, never values', async () => {
    const events: StorageLogEvent[] = [];
    const adapter = withLogging(readOnly(memoryAdapter()), (e) => {
      events.push(e);
    });
    await adapter.set('k', 'secret-value', { signal });
    await adapter.get('k', { signal });
    assert.deepEqual(events, [
      { operation: 'set', key: 'k', ok: false, code: 'forbidden' },
      { operation: 'get', key: 'k', ok: true },
    ]);
    assert.doesNotMatch(JSON.stringify(events), /secret-value/);
  });
});

void describe('utf8Length', () => {
  void it('counts bytes, not characters', () => {
    assert.equal(utf8Length('abc'), 3);
    assert.equal(utf8Length('é'), 2);
    assert.equal(utf8Length('€'), 3);
    assert.equal(utf8Length('😀'), 4);
  });
});
