import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  localStorageAdapter,
  type StorageChangeEvent,
  type StorageEventTarget,
  type WebStorageLike,
} from '../src/browser/index.js';
import type { StoredValue } from '../src/index.js';

const signal: AbortSignal = new AbortController().signal;

function makeStorage(): WebStorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

function failing(name: string): Error {
  return Object.assign(new Error(name), { name });
}

void describe('localStorageAdapter', () => {
  void it('returns null for a missing key', async () => {
    const adapter = localStorageAdapter({ storage: makeStorage() });
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('stores a value with an incrementing revision', async () => {
    const storage = makeStorage();
    const adapter = localStorageAdapter({ storage });
    const first = await adapter.set('a', 'one', { signal });
    const second = await adapter.set('a', 'two', { signal });
    assert.deepEqual(first, {
      ok: true,
      value: { value: 'one', revision: '1' },
    });
    assert.deepEqual(second, {
      ok: true,
      value: { value: 'two', revision: '2' },
    });
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: { value: 'two', revision: '2' },
    });
    assert.deepEqual(JSON.parse(storage.store.get('a') ?? ''), {
      r: '2',
      v: 'two',
    });
  });

  void it('reports a conflict when the stored revision differs from ifRevision', async () => {
    const adapter = localStorageAdapter({ storage: makeStorage() });
    await adapter.set('a', 'one', { signal });
    await adapter.set('a', 'two', { signal });
    const result = await adapter.set('a', 'three', { signal, ifRevision: '1' });
    assert.ok(!result.ok && result.code === 'conflict');
    assert.match(
      result.error,
      /localStorage holds revision 2, but revision 1 was expected for key "a"/
    );
  });

  void it('accepts a write whose ifRevision matches, and an ifRevision on a missing key', async () => {
    const adapter = localStorageAdapter({ storage: makeStorage() });
    const fresh = await adapter.set('a', 'one', { signal, ifRevision: '9' });
    assert.ok(fresh.ok);
    const matching = await adapter.set('a', 'two', { signal, ifRevision: '1' });
    assert.ok(matching.ok);
  });

  void it('maps a full store to the quota code, in both spellings', async () => {
    for (const name of ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']) {
      const storage = makeStorage();
      storage.setItem = () => {
        throw failing(name);
      };
      const result = await localStorageAdapter({ storage }).set('a', 'x', {
        signal,
      });
      assert.ok(!result.ok && result.code === 'quota', name);
      assert.match(result.error, /could not be written .* for key "a"/);
    }
  });

  void it('maps blocked storage to forbidden and other errors to unavailable', async () => {
    const blocked = makeStorage();
    blocked.getItem = () => {
      throw failing('SecurityError');
    };
    const denied = await localStorageAdapter({ storage: blocked }).get('a', {
      signal,
    });
    assert.ok(!denied.ok && denied.code === 'forbidden');

    const broken = makeStorage();
    broken.removeItem = () => {
      throw new Error('disk on fire');
    };
    const removed = await localStorageAdapter({ storage: broken }).remove?.(
      'a',
      { signal }
    );
    assert.ok(removed !== undefined && !removed.ok);
    assert.equal(removed.code, 'unavailable');
    assert.match(removed.error, /could not be removed .*disk on fire.* "a"/);
  });

  void it('reports a stored value that is not an envelope as corrupt on read, and replaces it on write', async () => {
    const storage = makeStorage();
    const adapter = localStorageAdapter({ storage });
    for (const bad of ['not json', 'null', '"text"', '{"r":1,"v":"x"}']) {
      storage.store.set('a', bad);
      const read = await adapter.get('a', { signal });
      assert.ok(!read.ok && read.code === 'corrupt', bad);
    }
    const written = await adapter.set('a', 'fresh', { signal });
    assert.ok(written.ok);
    assert.equal(written.value.revision, '1');
  });

  void it('removes a key', async () => {
    const storage = makeStorage();
    const adapter = localStorageAdapter({ storage });
    await adapter.set('a', 'one', { signal });
    const removed = await adapter.remove?.('a', { signal });
    assert.ok(removed?.ok);
    assert.equal(storage.store.has('a'), false);
  });

  void it('does nothing when the request was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const storage = makeStorage();
    const adapter = localStorageAdapter({ storage });
    const options = { signal: controller.signal };
    for (const result of [
      await adapter.get('a', options),
      await adapter.set('a', 'x', options),
      await adapter.remove?.('a', options),
    ]) {
      assert.ok(result !== undefined && !result.ok);
      assert.equal(result.code, 'unavailable');
      assert.match(result.error, /aborted for key "a"/);
    }
    assert.equal(storage.store.size, 0);
  });

  void it('is unavailable, not a throw, when localStorage is missing or blocked', async () => {
    const adapter = localStorageAdapter();
    const result = await adapter.get('a', { signal });
    assert.ok(!result.ok && result.code === 'unavailable');
    assert.match(result.error, /is not available for key "a"/);

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw failing('SecurityError');
      },
    });
    try {
      const blocked = await localStorageAdapter().set('a', 'x', { signal });
      assert.ok(!blocked.ok && blocked.code === 'unavailable');
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  void it('uses globalThis.localStorage when no storage is given', async () => {
    const storage = makeStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
    try {
      const saved = await localStorageAdapter().set('a', 'x', { signal });
      assert.ok(saved.ok);
      assert.ok(storage.store.has('a'));
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});

void describe('localStorageAdapter subscribe', () => {
  function makeEvents(): {
    events: StorageEventTarget;
    listeners: Set<(event: StorageChangeEvent) => void>;
  } {
    const listeners = new Set<(event: StorageChangeEvent) => void>();
    return {
      listeners,
      events: {
        addEventListener: (_type, listener) => {
          listeners.add(listener);
        },
        removeEventListener: (_type, listener) => {
          listeners.delete(listener);
        },
      },
    };
  }

  void it('reports changes to its key made in another tab', () => {
    const { events, listeners } = makeEvents();
    const adapter = localStorageAdapter({ storage: makeStorage(), events });
    const seen: (StoredValue | null)[] = [];
    const unsubscribe = adapter.subscribe?.('a', (stored) => seen.push(stored));
    assert.ok(unsubscribe !== undefined);

    for (const listener of listeners) {
      listener({ key: 'a', newValue: JSON.stringify({ r: '4', v: 'hi' }) });
      listener({ key: 'other', newValue: JSON.stringify({ r: '1', v: 'x' }) });
      listener({ key: 'a', newValue: 'not an envelope' });
      listener({ key: 'a', newValue: null });
    }
    assert.deepEqual(seen, [{ value: 'hi', revision: '4' }, null]);

    unsubscribe();
    assert.equal(listeners.size, 0);
  });

  void it('does nothing without an event target', () => {
    const adapter = localStorageAdapter({ storage: makeStorage() });
    const unsubscribe = adapter.subscribe?.('a', () => undefined);
    assert.ok(unsubscribe !== undefined);
    assert.doesNotThrow(unsubscribe);
  });

  void it('uses globalThis.window when no event target is given', () => {
    const { events, listeners } = makeEvents();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: events,
    });
    try {
      const adapter = localStorageAdapter({ storage: makeStorage() });
      const unsubscribe = adapter.subscribe?.('a', () => undefined);
      assert.equal(listeners.size, 1);
      unsubscribe?.();
      assert.equal(listeners.size, 0);
    } finally {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
