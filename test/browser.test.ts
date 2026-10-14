import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  localStorageAdapter,
  type StorageChangeEvent,
  type StorageEventTarget,
  type WebStorageLike,
} from '../src/browser/index.js';

const signal: AbortSignal = new AbortController().signal;

interface FakeStorage extends WebStorageLike {
  readonly store: Map<string, string>;
}

function fakeStorage(): FakeStorage {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
  };
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

void describe('localStorageAdapter', () => {
  void it('returns null for a missing key', async () => {
    const adapter = localStorageAdapter({ storage: fakeStorage() });
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('stores a value with an incrementing revision', async () => {
    const adapter = localStorageAdapter({ storage: fakeStorage() });
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
  });

  void it('reports a conflict when the stored revision differs from ifRevision', async () => {
    const adapter = localStorageAdapter({ storage: fakeStorage() });
    await adapter.set('a', 'one', { signal });
    await adapter.set('a', 'two', { signal });
    const result = await adapter.set('a', 'three', { signal, ifRevision: '1' });
    assert.ok(!result.ok && result.code === 'conflict');
    assert.match(result.error, /"a"/);
  });

  void it('accepts a write whose ifRevision matches, and creates a missing key', async () => {
    const adapter = localStorageAdapter({ storage: fakeStorage() });
    assert.ok((await adapter.set('new', 'x', { signal, ifRevision: '7' })).ok);
    await adapter.set('a', 'one', { signal });
    assert.ok((await adapter.set('a', 'two', { signal, ifRevision: '1' })).ok);
  });

  void it('maps a full store to quota and blocked storage to forbidden', async () => {
    const full = fakeStorage();
    full.setItem = (): void => {
      throw namedError('QuotaExceededError');
    };
    const quota = await localStorageAdapter({ storage: full }).set('a', 'x', {
      signal,
    });
    assert.ok(!quota.ok && quota.code === 'quota');

    const blocked = fakeStorage();
    blocked.getItem = (): string | null => {
      throw namedError('SecurityError');
    };
    const forbidden = await localStorageAdapter({ storage: blocked }).get('a', {
      signal,
    });
    assert.ok(!forbidden.ok && forbidden.code === 'forbidden');
  });

  void it('maps any other storage error to unavailable', async () => {
    const broken = fakeStorage();
    broken.removeItem = (): void => {
      throw new Error('boom');
    };
    const result = await localStorageAdapter({ storage: broken }).remove?.(
      'a',
      {
        signal,
      }
    );
    assert.ok(
      result !== undefined && !result.ok && result.code === 'unavailable'
    );
  });

  void it('reports a value that is not an envelope as corrupt, and replaces it on write', async () => {
    const storage = fakeStorage();
    storage.store.set('a', 'not json');
    storage.store.set('b', 'null');
    const adapter = localStorageAdapter({ storage });
    const read = await adapter.get('a', { signal });
    assert.ok(!read.ok && read.code === 'corrupt');
    const readNull = await adapter.get('b', { signal });
    assert.ok(!readNull.ok && readNull.code === 'corrupt');
    assert.ok((await adapter.set('a', 'fresh', { signal })).ok);
  });

  void it('removes a key', async () => {
    const storage = fakeStorage();
    const adapter = localStorageAdapter({ storage });
    await adapter.set('a', 'one', { signal });
    const removed = await adapter.remove?.('a', { signal });
    assert.ok(removed?.ok);
    assert.equal(storage.store.has('a'), false);
  });

  void it('returns unavailable without touching storage when already aborted', async () => {
    const storage = fakeStorage();
    let touched = false;
    storage.getItem = (): string | null => {
      touched = true;
      return null;
    };
    const controller = new AbortController();
    controller.abort();
    const result = await localStorageAdapter({ storage }).get('a', {
      signal: controller.signal,
    });
    assert.ok(!result.ok && result.code === 'unavailable');
    assert.equal(touched, false);
  });

  void it('returns unavailable when there is no storage at all', async () => {
    const adapter = localStorageAdapter();
    const result = await adapter.get('a', { signal });
    assert.ok(!result.ok && result.code === 'unavailable');
  });

  void it('subscribe reports changes to its key made in another tab', () => {
    const listeners = new Set<(event: StorageChangeEvent) => void>();
    const events: StorageEventTarget = {
      addEventListener: (_type, listener): void => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener): void => {
        listeners.delete(listener);
      },
    };
    const adapter = localStorageAdapter({ storage: fakeStorage(), events });
    const seen: unknown[] = [];
    const unsubscribe = adapter.subscribe?.('a', (stored) => seen.push(stored));
    assert.ok(unsubscribe !== undefined);

    for (const listener of listeners) {
      listener({ key: 'a', newValue: JSON.stringify({ r: '4', v: 'hi' }) });
      listener({ key: 'other', newValue: JSON.stringify({ r: '1', v: 'x' }) });
      listener({ key: 'a', newValue: 'not json' });
      listener({ key: 'a', newValue: null });
    }
    assert.deepEqual(seen, [{ value: 'hi', revision: '4' }, null]);

    unsubscribe();
    assert.equal(listeners.size, 0);
  });

  void it('subscribe does nothing without an event target', () => {
    const adapter = localStorageAdapter({ storage: fakeStorage() });
    const unsubscribe = adapter.subscribe?.('a', () => {});
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe?.();
  });
});
