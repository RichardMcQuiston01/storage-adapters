import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  localStorageAdapter,
  sessionStorageAdapter,
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

  void it('returns unavailable when there is no storage at all', () =>
    // Set to undefined, not just left alone: Deno has a localStorage of its own.
    withGlobal('localStorage', { value: undefined }, async () => {
      const result = await localStorageAdapter().get('a', { signal });
      assert.ok(!result.ok && result.code === 'unavailable');
    }));

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

/** Runs `run` with a global installed on `globalThis`, then puts things back. */
async function withGlobal(
  name: 'localStorage' | 'sessionStorage',
  descriptor: PropertyDescriptor,
  run: () => Promise<void>
): Promise<void> {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    ...descriptor,
  });
  try {
    await run();
  } finally {
    Reflect.deleteProperty(globalThis, name);
  }
}

function eventTarget(): {
  events: StorageEventTarget;
  listeners: Set<(event: StorageChangeEvent) => void>;
} {
  const listeners = new Set<(event: StorageChangeEvent) => void>();
  return {
    listeners,
    events: {
      addEventListener: (_type, listener): void => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener): void => {
        listeners.delete(listener);
      },
    },
  };
}

void describe('sessionStorageAdapter', () => {
  void it('returns null for a missing key', async () => {
    const adapter = sessionStorageAdapter({ storage: fakeStorage() });
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('stores a value with an incrementing revision, in the same envelope as localStorageAdapter', async () => {
    const storage = fakeStorage();
    const adapter = sessionStorageAdapter({ storage });
    assert.deepEqual(await adapter.set('a', 'one', { signal }), {
      ok: true,
      value: { value: 'one', revision: '1' },
    });
    assert.deepEqual(await adapter.set('a', 'two', { signal }), {
      ok: true,
      value: { value: 'two', revision: '2' },
    });
    assert.equal(storage.store.get('a'), JSON.stringify({ r: '2', v: 'two' }));
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: { value: 'two', revision: '2' },
    });
  });

  void it('reads what localStorageAdapter wrote to the same storage object', async () => {
    const storage = fakeStorage();
    await localStorageAdapter({ storage }).set('a', 'shared', { signal });
    assert.deepEqual(
      await sessionStorageAdapter({ storage }).get('a', { signal }),
      { ok: true, value: { value: 'shared', revision: '1' } }
    );
  });

  void it('reports a conflict when the stored revision differs from ifRevision', async () => {
    const adapter = sessionStorageAdapter({ storage: fakeStorage() });
    await adapter.set('a', 'one', { signal });
    await adapter.set('a', 'two', { signal });
    const result = await adapter.set('a', 'three', { signal, ifRevision: '1' });
    assert.ok(!result.ok && result.code === 'conflict');
    assert.match(result.error, /^sessionStorage /);
    assert.match(result.error, /"a"/);
    assert.ok(
      (await adapter.set('a', 'three', { signal, ifRevision: '2' })).ok
    );
  });

  void it('names sessionStorage, not localStorage, in every error', async () => {
    const blocked = fakeStorage();
    blocked.getItem = (): string | null => {
      throw namedError('SecurityError');
    };
    const forbidden = await sessionStorageAdapter({ storage: blocked }).get(
      'k',
      { signal }
    );
    assert.ok(!forbidden.ok && forbidden.code === 'forbidden');
    assert.match(forbidden.error, /^sessionStorage could not be read/);
    assert.match(forbidden.error, /for key "k"$/);

    const full = fakeStorage();
    full.setItem = (): void => {
      throw namedError('QuotaExceededError');
    };
    const quota = await sessionStorageAdapter({ storage: full }).set('k', 'x', {
      signal,
    });
    assert.ok(!quota.ok && quota.code === 'quota');
    assert.match(quota.error, /^sessionStorage could not be written/);

    const bad = fakeStorage();
    bad.store.set('k', 'not json');
    const corrupt = await sessionStorageAdapter({ storage: bad }).get('k', {
      signal,
    });
    assert.ok(!corrupt.ok && corrupt.code === 'corrupt');
    assert.match(corrupt.error, /^sessionStorage /);
  });

  void it('removes a key', async () => {
    const storage = fakeStorage();
    const adapter = sessionStorageAdapter({ storage });
    await adapter.set('a', 'one', { signal });
    assert.ok((await adapter.remove?.('a', { signal }))?.ok);
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
    const result = await sessionStorageAdapter({ storage }).get('a', {
      signal: controller.signal,
    });
    assert.ok(!result.ok && result.code === 'unavailable');
    assert.equal(touched, false);
  });

  void it('returns unavailable when there is no sessionStorage, even if localStorage exists', () =>
    withGlobal('localStorage', { value: fakeStorage() }, () =>
      withGlobal('sessionStorage', { value: undefined }, async () => {
        const result = await sessionStorageAdapter().get('a', { signal });
        assert.ok(!result.ok && result.code === 'unavailable');
        assert.match(result.error, /^sessionStorage is not available/);
      })
    ));

  void it('uses the global sessionStorage when none is passed in', () => {
    const storage = fakeStorage();
    return withGlobal('sessionStorage', { value: storage }, async () => {
      const adapter = sessionStorageAdapter();
      assert.ok((await adapter.set('a', 'global', { signal })).ok);
      assert.equal(
        storage.store.get('a'),
        JSON.stringify({ r: '1', v: 'global' })
      );
    });
  });

  void it('returns unavailable when merely reading the global sessionStorage throws', () =>
    withGlobal(
      'sessionStorage',
      {
        get: (): never => {
          throw namedError('SecurityError');
        },
      },
      async () => {
        const result = await sessionStorageAdapter().get('a', { signal });
        assert.ok(!result.ok && result.code === 'unavailable');
      }
    ));

  void it('does not share data with a localStorageAdapter on its own storage', async () => {
    const session = sessionStorageAdapter({ storage: fakeStorage() });
    const local = localStorageAdapter({ storage: fakeStorage() });
    await session.set('a', 'tab only', { signal });
    assert.deepEqual(await local.get('a', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('subscribe reports changes to its key made by another document', () => {
    const { events, listeners } = eventTarget();
    const storage = fakeStorage();
    const adapter = sessionStorageAdapter({ storage, events });
    const seen: unknown[] = [];
    const unsubscribe = adapter.subscribe?.('a', (stored) => seen.push(stored));
    assert.ok(unsubscribe !== undefined);

    for (const listener of listeners) {
      listener({
        key: 'a',
        newValue: JSON.stringify({ r: '4', v: 'hi' }),
        storageArea: storage,
      });
      listener({ key: 'other', newValue: null, storageArea: storage });
      listener({ key: 'a', newValue: 'not json', storageArea: storage });
      listener({ key: 'a', newValue: null, storageArea: storage });
    }
    assert.deepEqual(seen, [{ value: 'hi', revision: '4' }, null]);

    unsubscribe();
    assert.equal(listeners.size, 0);
  });

  void it('subscribe does nothing without an event target', () => {
    const unsubscribe = sessionStorageAdapter({
      storage: fakeStorage(),
    }).subscribe?.('a', () => {});
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe?.();
  });
});

void describe('storage events from a different storage area', () => {
  const envelope: string = JSON.stringify({ r: '2', v: 'x' });

  for (const [label, create] of [
    ['localStorageAdapter', localStorageAdapter],
    ['sessionStorageAdapter', sessionStorageAdapter],
  ] as const) {
    void it(`${label} ignores a change to some other storage under the same key`, () => {
      const { events, listeners } = eventTarget();
      const own = fakeStorage();
      const other = fakeStorage();
      const adapter = create({ storage: own, events });
      const seen: unknown[] = [];
      adapter.subscribe?.('a', (stored) => seen.push(stored));

      for (const listener of listeners) {
        listener({ key: 'a', newValue: envelope, storageArea: other });
        listener({ key: 'a', newValue: envelope, storageArea: own });
        listener({ key: 'a', newValue: envelope });
      }
      // The foreign area is skipped; its own area and an event with no area are heard.
      assert.deepEqual(seen, [
        { value: 'x', revision: '2' },
        { value: 'x', revision: '2' },
      ]);
    });
  }
});
