import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { act, createElement, type ReactElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import {
  useStoredValue,
  type UseStoredValueResult,
} from '../src/react/index.js';
import {
  memoryAdapter,
  type StorageAdapter,
  type StoredValue,
  type StoreResult,
} from '../src/storage.js';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const signal: AbortSignal = new AbortController().signal;

// react-test-renderer prints a deprecation notice on every render; the notice is for
// people choosing a renderer, and it would bury the test results.
for (const method of ['warn', 'error'] as const) {
  const original = console[method];
  console[method] = (...args: unknown[]): void => {
    if (!String(args[0]).includes('react-test-renderer is deprecated')) {
      original(...args);
    }
  };
}

/** Renders the hook and keeps what it returned on the latest render. */
class Probe {
  latest: UseStoredValueResult | null = null;
  renders = 0;
  private renderer: ReactTestRenderer | null = null;

  async mount(adapter: StorageAdapter, key: string): Promise<void> {
    await act(async () => {
      this.renderer = create(this.element(adapter, key));
    });
  }

  async update(adapter: StorageAdapter, key: string): Promise<void> {
    await act(async () => {
      this.renderer?.update(this.element(adapter, key));
    });
  }

  async unmount(): Promise<void> {
    await act(async () => {
      this.renderer?.unmount();
    });
  }

  get current(): UseStoredValueResult {
    assert.ok(this.latest !== null, 'nothing rendered yet');
    return this.latest;
  }

  /** One component for the probe's whole life, so changing props re-renders it in place. */
  private readonly Component = (props: {
    adapter: StorageAdapter;
    storedKey: string;
  }): null => {
    this.latest = useStoredValue(props.adapter, props.storedKey);
    this.renders += 1;
    return null;
  };

  private element(adapter: StorageAdapter, key: string): ReactElement {
    return createElement(this.Component, { adapter, storedKey: key });
  }
}

/** Wraps an adapter so a test can hold a read back, count listeners and see signals. */
function instrumented(inner: StorageAdapter): {
  adapter: StorageAdapter;
  listeners: { count: number };
  signals: AbortSignal[];
  hold: { release: (() => void) | null; next: boolean };
} {
  const listeners = { count: 0 };
  const signals: AbortSignal[] = [];
  const hold: { release: (() => void) | null; next: boolean } = {
    release: null,
    next: false,
  };
  const adapter: StorageAdapter = {
    ...inner,
    get: async (key, options) => {
      signals.push(options.signal);
      // Read first, so a held read answers with what was stored when it started.
      const result = await inner.get(key, options);
      if (hold.next) {
        hold.next = false;
        await new Promise<void>((resolve) => {
          hold.release = resolve;
        });
      }
      return result;
    },
    subscribe: (key, onChange) => {
      listeners.count += 1;
      const stop = inner.subscribe?.(key, onChange) ?? ((): void => undefined);
      return () => {
        listeners.count -= 1;
        stop();
      };
    },
  };
  return { adapter, listeners, signals, hold };
}

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

void describe('useStoredValue', () => {
  void it('is loading, then ready with the stored value and its revision', async () => {
    const adapter = memoryAdapter({ theme: 'dark' });
    const probe = new Probe();
    await probe.mount(adapter, 'theme');
    assert.equal(probe.current.status, 'ready');
    assert.equal(probe.current.value, 'dark');
    assert.equal(
      probe.current.revision,
      expectOk(await adapter.get('theme', { signal }))?.revision
    );
    assert.equal(probe.current.error, null);
    await probe.unmount();
  });

  void it('reports loading before the first read finishes', async () => {
    const { adapter, hold } = instrumented(memoryAdapter({ theme: 'dark' }));
    hold.next = true;
    const probe = new Probe();
    await probe.mount(adapter, 'theme');
    assert.equal(probe.current.status, 'loading');
    assert.equal(probe.current.value, null);
    await act(async () => {
      hold.release?.();
    });
    assert.equal(probe.current.status, 'ready');
    assert.equal(probe.current.value, 'dark');
    await probe.unmount();
  });

  void it('is ready with a null value when nothing is stored', async () => {
    const probe = new Probe();
    await probe.mount(memoryAdapter(), 'absent');
    assert.equal(probe.current.status, 'ready');
    assert.equal(probe.current.value, null);
    assert.equal(probe.current.revision, undefined);
    await probe.unmount();
  });

  void it('follows a change made elsewhere, and a removal', async () => {
    const adapter = memoryAdapter({ theme: 'dark' });
    const probe = new Probe();
    await probe.mount(adapter, 'theme');
    await act(async () => {
      expectOk(await adapter.set('theme', 'light', { signal }));
    });
    assert.equal(probe.current.value, 'light');
    await act(async () => {
      await adapter.remove?.('theme', { signal });
    });
    assert.equal(probe.current.status, 'ready');
    assert.equal(probe.current.value, null);
    await probe.unmount();
  });

  void it('stops listening and cancels the read when it unmounts', async () => {
    const { adapter, listeners, signals } = instrumented(
      memoryAdapter({ k: 'v' })
    );
    const probe = new Probe();
    await probe.mount(adapter, 'k');
    assert.equal(listeners.count, 1);
    await probe.unmount();
    assert.equal(listeners.count, 0);
    assert.ok(signals.every((each) => each.aborted));
  });

  void it('works with an adapter that cannot subscribe', async () => {
    const { subscribe: _subscribe, ...plain } = memoryAdapter({ k: 'v' });
    const probe = new Probe();
    await probe.mount(plain, 'k');
    assert.equal(probe.current.value, 'v');
    await probe.unmount();
  });

  void it('set writes, updates the state and returns the result', async () => {
    const adapter = memoryAdapter();
    const probe = new Probe();
    await probe.mount(adapter, 'k');
    let result: StoreResult<StoredValue> | null = null;
    await act(async () => {
      result = await probe.current.set('one');
    });
    assert.equal(
      expectOk(result as unknown as StoreResult<StoredValue>).value,
      'one'
    );
    assert.equal(probe.current.value, 'one');
    assert.equal(
      probe.current.revision,
      expectOk(await adapter.get('k', { signal }))?.revision
    );
    await probe.unmount();
  });

  void it('set with a stale revision returns the conflict and keeps the value', async () => {
    const adapter = memoryAdapter({ k: 'one' });
    const probe = new Probe();
    await probe.mount(adapter, 'k');
    const stale = probe.current.revision;
    await act(async () => {
      expectOk(await adapter.set('k', 'two', { signal }));
    });
    let result: StoreResult<StoredValue> | null = null;
    await act(async () => {
      result = await probe.current.set('mine', {
        ...(stale === undefined ? {} : { ifRevision: stale }),
      });
    });
    const failed = result as unknown as StoreResult<StoredValue>;
    assert.equal(failed.ok, false);
    assert.equal(!failed.ok && failed.code, 'conflict');
    assert.equal(probe.current.value, 'two');
    assert.equal(probe.current.status, 'ready');
    assert.equal(probe.current.error?.code, 'conflict');
    assert.ok(probe.current.error?.message.includes('"k"'));
    // The next success clears the error.
    await act(async () => {
      await probe.current.set('three');
    });
    assert.equal(probe.current.error, null);
    await probe.unmount();
  });

  void it('remove removes the key; an adapter that cannot remove says so', async () => {
    const adapter = memoryAdapter({ k: 'v' });
    const probe = new Probe();
    await probe.mount(adapter, 'k');
    await act(async () => {
      expectOk(await probe.current.remove());
    });
    assert.equal(probe.current.value, null);
    assert.deepEqual(await adapter.get('k', { signal }), {
      ok: true,
      value: null,
    });
    await probe.unmount();

    const { remove: _remove, ...cannot } = memoryAdapter({ k: 'v' });
    const second = new Probe();
    await second.mount(cannot, 'k');
    let result: StoreResult<null> | null = null;
    await act(async () => {
      result = await second.current.remove();
    });
    const failed = result as unknown as StoreResult<null>;
    assert.equal(!failed.ok && failed.code, 'unavailable');
    assert.ok(!failed.ok && failed.error.includes('"k"'));
    assert.equal(second.current.value, 'v');
    await second.unmount();
  });

  void it('shows a failed read as an error, and refresh recovers', async () => {
    const inner = memoryAdapter({ k: 'v' });
    let failing = true;
    const adapter: StorageAdapter = {
      ...inner,
      get: (key, options) =>
        failing
          ? Promise.resolve({
              ok: false,
              code: 'forbidden',
              error: `denied for key "${key}"`,
            })
          : inner.get(key, options),
    };
    const probe = new Probe();
    await probe.mount(adapter, 'k');
    assert.equal(probe.current.status, 'error');
    assert.equal(probe.current.error?.code, 'forbidden');
    assert.equal(probe.current.value, null);
    failing = false;
    await act(async () => {
      expectOk(await probe.current.refresh());
    });
    assert.equal(probe.current.status, 'ready');
    assert.equal(probe.current.value, 'v');
    assert.equal(probe.current.error, null);
    await probe.unmount();
  });

  void it('turns an adapter that throws into an unavailable error instead of crashing', async () => {
    const adapter: StorageAdapter = {
      get: () => Promise.reject(new Error('socket hang up')),
      set: () => Promise.reject(new Error('socket hang up')),
    };
    const probe = new Probe();
    await probe.mount(adapter, 'k');
    assert.equal(probe.current.status, 'error');
    assert.equal(probe.current.error?.code, 'unavailable');
    assert.ok(probe.current.error?.message.includes('socket hang up'));
    let result: StoreResult<StoredValue> | null = null;
    await act(async () => {
      result = await probe.current.set('v');
    });
    assert.equal((result as unknown as StoreResult<StoredValue>).ok, false);
    await probe.unmount();
  });

  void it('reads the new key when the key changes, and ignores the old read', async () => {
    const { adapter, hold } = instrumented(
      memoryAdapter({ a: 'first', b: 'second' })
    );
    const probe = new Probe();
    hold.next = true; // The read of "a" is held back.
    await probe.mount(adapter, 'a');
    assert.equal(probe.current.status, 'loading');
    await probe.update(adapter, 'b');
    assert.equal(probe.current.value, 'second');
    await act(async () => {
      hold.release?.();
    });
    assert.equal(probe.current.value, 'second');
    await probe.unmount();
  });

  void it('prefers a change heard during the first read over that read', async () => {
    const inner = memoryAdapter({ k: 'old' });
    const { adapter, hold } = instrumented(inner);
    hold.next = true; // The first read has already seen "old" when it is held.
    const probe = new Probe();
    await probe.mount(adapter, 'k');
    await act(async () => {
      expectOk(await inner.set('k', 'new', { signal }));
    });
    assert.equal(probe.current.value, 'new');
    await act(async () => {
      hold.release?.();
    });
    assert.equal(probe.current.value, 'new');
    await probe.unmount();
  });

  void it('ignores the answer to a write made for a key it no longer shows', async () => {
    const inner = memoryAdapter({ a: 'first', b: 'second' });
    let release: (() => void) | null = null;
    const adapter: StorageAdapter = {
      ...inner,
      set: async (key, value, options) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return inner.set(key, value, options);
      },
    };
    const probe = new Probe();
    await probe.mount(adapter, 'a');
    let pending: Promise<StoreResult<StoredValue>> | null = null;
    await act(async () => {
      pending = probe.current.set('late');
    });
    await probe.update(adapter, 'b');
    assert.equal(probe.current.value, 'second');
    await act(async () => {
      (release as (() => void) | null)?.();
      await pending;
    });
    // The write went through for "a", but the screen is showing "b".
    assert.equal(probe.current.value, 'second');
    assert.equal(expectOk(await inner.get('a', { signal }))?.value, 'late');
    await probe.unmount();
  });

  void it('does not update after it has unmounted', async () => {
    const adapter = memoryAdapter({ k: 'v' });
    const probe = new Probe();
    await probe.mount(adapter, 'k');
    const { set } = probe.current;
    await probe.unmount();
    const rendersBefore = probe.renders;
    await act(async () => {
      expectOk(await set('after'));
    });
    assert.equal(probe.renders, rendersBefore);
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'after');
  });

  void it('keeps set, remove and refresh the same between renders', async () => {
    const adapter = memoryAdapter({ k: 'v' });
    const probe = new Probe();
    await probe.mount(adapter, 'k');
    const { set, remove, refresh } = probe.current;
    await act(async () => {
      await adapter.set('k', 'w', { signal });
    });
    assert.equal(probe.current.set, set);
    assert.equal(probe.current.remove, remove);
    assert.equal(probe.current.refresh, refresh);
    await probe.unmount();
  });
});
