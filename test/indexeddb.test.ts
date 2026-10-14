import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IDBFactory } from 'fake-indexeddb';

import {
  indexedDbAdapter,
  type BroadcastChannelLike,
  type IdbDatabaseLike,
  type IdbFactoryLike,
  type IdbObjectStoreLike,
  type IdbOpenRequestLike,
  type IdbRequestLike,
  type IdbTransactionLike,
} from '../src/indexeddb/index.js';
import type { StoredValue, StoreResult } from '../src/storage.js';

const signal: AbortSignal = new AbortController().signal;

function newFactory(): IdbFactoryLike {
  return new IDBFactory() as unknown as IdbFactoryLike;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/** A BroadcastChannel stand-in: a message reaches every other channel on the hub. */
class FakeChannel implements BroadcastChannelLike {
  private readonly listeners = new Set<
    (event: { readonly data: unknown }) => void
  >();

  constructor(private readonly hub: Set<FakeChannel>) {
    hub.add(this);
  }

  postMessage(message: unknown): void {
    for (const other of this.hub) {
      if (other === this) {
        continue;
      }
      queueMicrotask(() => {
        for (const listener of other.listeners) {
          listener({ data: message });
        }
      });
    }
  }

  addEventListener(
    _type: 'message',
    listener: (event: { readonly data: unknown }) => void
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: 'message',
    listener: (event: { readonly data: unknown }) => void
  ): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.hub.delete(this);
  }
}

/** Writes `raw` straight into the object store, bypassing the adapter. */
function putRaw(
  factory: IdbFactoryLike,
  key: string,
  raw: unknown
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = factory.open('storage-adapters', 1);
    request.onsuccess = (): void => {
      const transaction = request.result.transaction('entry', 'readwrite');
      transaction.objectStore('entry').put(raw, key);
      transaction.oncomplete = (): void => {
        request.result.close();
        resolve();
      };
      transaction.onerror = (): void => {
        reject(new Error('could not write the raw value'));
      };
    };
    request.onerror = (): void => {
      reject(new Error('could not open the database'));
    };
  });
}

function stubRequest<T>(result: T): IdbRequestLike<T> {
  return { result, error: null, onsuccess: null, onerror: null };
}

/** A database whose every write is rejected the way a full disk rejects it. */
function fullDiskFactory(): IdbFactoryLike {
  const transaction: IdbTransactionLike = {
    error: namedError('QuotaExceededError'),
    oncomplete: null,
    onerror: null,
    onabort: null,
    objectStore: () => store,
    abort: () => {},
  };
  const rejectWrite = (): IdbRequestLike<unknown> => {
    queueMicrotask(() => {
      transaction.onerror?.(undefined as never);
      transaction.onabort?.(undefined as never);
    });
    return stubRequest(undefined);
  };
  const store: IdbObjectStoreLike = {
    get: () => {
      const request = stubRequest<unknown>(undefined);
      queueMicrotask(() => request.onsuccess?.(undefined as never));
      return request;
    },
    put: rejectWrite,
    delete: rejectWrite,
  };
  const database: IdbDatabaseLike = {
    objectStoreNames: { contains: () => true },
    onversionchange: null,
    createObjectStore: () => undefined,
    transaction: () => transaction,
    close: () => {},
  };
  return {
    open: () => {
      const request: IdbOpenRequestLike = {
        ...stubRequest(database),
        onupgradeneeded: null,
        onblocked: null,
      };
      queueMicrotask(() => request.onsuccess?.(undefined as never));
      return request;
    },
  };
}

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
): void {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  assert.ok(
    result.error.includes(`"${key}"`),
    `error should name the key: ${result.error}`
  );
}

/** Resolves with the next value passed to `onChange`. */
function nextChange(
  subscribe: (onChange: (stored: StoredValue | null) => void) => () => void
): { next: Promise<StoredValue | null>; unsubscribe: () => void } {
  let unsubscribe: () => void = () => {};
  const next = new Promise<StoredValue | null>((resolve) => {
    unsubscribe = subscribe(resolve);
  });
  return { next, unsubscribe };
}

void describe('indexedDbAdapter', () => {
  void it('returns null for a missing key', async () => {
    const adapter = indexedDbAdapter({
      factory: newFactory(),
      channel: new FakeChannel(new Set()),
    });
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('stores a value and counts revisions up', async () => {
    const adapter = indexedDbAdapter({
      factory: newFactory(),
      channel: new FakeChannel(new Set()),
    });
    assert.deepEqual(expectOk(await adapter.set('a', 'one', { signal })), {
      value: 'one',
      revision: '1',
    });
    assert.deepEqual(expectOk(await adapter.set('a', 'two', { signal })), {
      value: 'two',
      revision: '2',
    });
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
      value: 'two',
      revision: '2',
    });
  });

  void it('keeps data between adapters on the same database', async () => {
    const factory = newFactory();
    const writer = indexedDbAdapter({
      factory,
      channel: new FakeChannel(new Set()),
    });
    expectOk(await writer.set('a', 'kept', { signal }));
    const reader = indexedDbAdapter({
      factory,
      channel: new FakeChannel(new Set()),
    });
    assert.deepEqual(expectOk(await reader.get('a', { signal })), {
      value: 'kept',
      revision: '1',
    });
  });

  void it('stores large values', async () => {
    const adapter = indexedDbAdapter({
      factory: newFactory(),
      channel: new FakeChannel(new Set()),
    });
    const large: string = 'x'.repeat(6 * 1024 * 1024);
    expectOk(await adapter.set('big', large, { signal }));
    const read = expectOk(await adapter.get('big', { signal }));
    assert.equal(read?.value.length, large.length);
  });

  void it('reports a conflict for a stale ifRevision and keeps the value', async () => {
    const adapter = indexedDbAdapter({
      factory: newFactory(),
      channel: new FakeChannel(new Set()),
    });
    expectOk(await adapter.set('a', 'one', { signal }));
    expectFailure(
      await adapter.set('a', 'two', { signal, ifRevision: '9' }),
      'conflict',
      'a'
    );
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
      value: 'one',
      revision: '1',
    });
  });

  void it('writes when ifRevision matches, or when nothing is stored', async () => {
    const adapter = indexedDbAdapter({
      factory: newFactory(),
      channel: new FakeChannel(new Set()),
    });
    assert.equal(
      expectOk(await adapter.set('a', 'one', { signal, ifRevision: '5' }))
        .revision,
      '1'
    );
    assert.equal(
      expectOk(await adapter.set('a', 'two', { signal, ifRevision: '1' }))
        .revision,
      '2'
    );
  });

  void it('lets exactly one of two racing writers win', async () => {
    const factory = newFactory();
    const first = indexedDbAdapter({
      factory,
      channel: new FakeChannel(new Set()),
    });
    const second = indexedDbAdapter({
      factory,
      channel: new FakeChannel(new Set()),
    });
    expectOk(await first.set('a', 'start', { signal }));
    const results = await Promise.all([
      first.set('a', 'from first', { signal, ifRevision: '1' }),
      second.set('a', 'from second', { signal, ifRevision: '1' }),
    ]);
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    expectFailure(losers[0] as StoreResult<StoredValue>, 'conflict', 'a');
    assert.equal(expectOk(await first.get('a', { signal }))?.revision, '2');
  });

  void it('removes a key, and removing a missing key succeeds', async () => {
    const adapter = indexedDbAdapter({
      factory: newFactory(),
      channel: new FakeChannel(new Set()),
    });
    expectOk(await adapter.set('a', 'one', { signal }));
    assert.deepEqual(await adapter.remove?.('a', { signal }), {
      ok: true,
      value: null,
    });
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
    assert.deepEqual(await adapter.remove?.('never', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('reports a stored value that is not a record as corrupt, and replaces it', async () => {
    const factory = newFactory();
    const adapter = indexedDbAdapter({
      factory,
      channel: new FakeChannel(new Set()),
    });
    expectOk(await adapter.set('seed', 'x', { signal }));
    await putRaw(factory, 'bad', 'not a record');
    await putRaw(factory, 'half', { r: '3' });
    expectFailure(await adapter.get('bad', { signal }), 'corrupt', 'bad');
    expectFailure(await adapter.get('half', { signal }), 'corrupt', 'half');
    assert.deepEqual(expectOk(await adapter.set('bad', 'fixed', { signal })), {
      value: 'fixed',
      revision: '1',
    });
  });

  void it('does not touch the database when the request is already aborted', async () => {
    let opens = 0;
    const factory: IdbFactoryLike = {
      open: () => {
        opens += 1;
        throw new Error('should not be called');
      },
    };
    const adapter = indexedDbAdapter({
      factory,
      channel: new FakeChannel(new Set()),
    });
    const controller = new AbortController();
    controller.abort();
    const stopped = { signal: controller.signal };
    expectFailure(await adapter.get('a', stopped), 'unavailable', 'a');
    expectFailure(await adapter.set('a', 'v', stopped), 'unavailable', 'a');
    expectFailure(
      (await adapter.remove?.('a', stopped)) as StoreResult<null>,
      'unavailable',
      'a'
    );
    assert.equal(opens, 0);
  });

  void it('maps a blocked database to forbidden', async () => {
    const adapter = indexedDbAdapter({
      factory: {
        open: () => {
          throw namedError('SecurityError');
        },
      },
      channel: new FakeChannel(new Set()),
    });
    expectFailure(await adapter.get('a', { signal }), 'forbidden', 'a');
  });

  void it('maps any other open failure to unavailable and tries again next time', async () => {
    const real = newFactory();
    let attempts = 0;
    const adapter = indexedDbAdapter({
      factory: {
        open: (name, version) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('disk on fire');
          }
          return real.open(name, version);
        },
      },
      channel: new FakeChannel(new Set()),
    });
    const failed = await adapter.get('a', { signal });
    expectFailure(failed, 'unavailable', 'a');
    assert.ok(!failed.ok && failed.error.includes('disk on fire'));
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('maps a full disk to quota', async () => {
    const adapter = indexedDbAdapter({
      factory: fullDiskFactory(),
      channel: new FakeChannel(new Set()),
    });
    expectFailure(await adapter.set('a', 'v', { signal }), 'quota', 'a');
    expectFailure(
      (await adapter.remove?.('a', { signal })) as StoreResult<null>,
      'quota',
      'a'
    );
  });

  void it('tells other adapters about writes and removals', async () => {
    const factory = newFactory();
    const hub = new Set<FakeChannel>();
    const writer = indexedDbAdapter({ factory, channel: new FakeChannel(hub) });
    const watcher = indexedDbAdapter({
      factory,
      channel: new FakeChannel(hub),
    });

    const written = nextChange(
      (onChange) => watcher.subscribe?.('a', onChange) ?? (() => {})
    );
    expectOk(await writer.set('a', 'hello', { signal }));
    assert.deepEqual(await written.next, { value: 'hello', revision: '1' });
    written.unsubscribe();

    const removed = nextChange(
      (onChange) => watcher.subscribe?.('a', onChange) ?? (() => {})
    );
    await writer.remove?.('a', { signal });
    assert.equal(await removed.next, null);
    removed.unsubscribe();
  });

  void it('ignores other keys and stops after unsubscribe', async () => {
    const factory = newFactory();
    const hub = new Set<FakeChannel>();
    const writer = indexedDbAdapter({ factory, channel: new FakeChannel(hub) });
    const watcher = indexedDbAdapter({
      factory,
      channel: new FakeChannel(hub),
    });
    const seen: (StoredValue | null)[] = [];
    const unsubscribe: () => void =
      watcher.subscribe?.('a', (stored) => seen.push(stored)) ?? (() => {});

    expectOk(await writer.set('other', 'x', { signal }));
    expectOk(await writer.set('a', 'one', { signal }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, [{ value: 'one', revision: '1' }]);

    unsubscribe();
    expectOk(await writer.set('a', 'two', { signal }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(seen.length, 1);
  });

  void it('does not notify the adapter that made the write', async () => {
    const adapter = indexedDbAdapter({
      factory: newFactory(),
      channel: new FakeChannel(new Set()),
    });
    const seen: (StoredValue | null)[] = [];
    adapter.subscribe?.('a', (stored) => seen.push(stored));
    expectOk(await adapter.set('a', 'one', { signal }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(seen.length, 0);
  });
});
