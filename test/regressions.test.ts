/**
 * Regression tests for bugs found in review, one `describe` per bug. Each one
 * failed before its fix.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  localStorageAdapter,
  type WebStorageLike,
} from '../src/browser/index.js';
import { nodeFileSystem } from '../src/file/node.js';
import { jsonFileAdapter } from '../src/json-file/index.js';
import {
  createPersistence,
  memoryAdapter,
  withEncoding,
  withFallback,
  withReadCache,
  withRetry,
  type StorageAdapter,
  type StoredValue,
  type StoreResult,
} from '../src/index.js';
import { failure } from '../src/storage.js';
import { writeTemporaryFile } from '../src/file/shared.js';
import {
  errorWithCode,
  fakeFileSystem,
  withExclusiveCreate,
} from './support/fake-file-system.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

function expectFailure<T>(result: StoreResult<T>, code: string): string {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  return result.error;
}

/** A promise you settle by hand. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((done) => setImmediate(done));

void describe('memoryAdapter with a subscriber that throws', () => {
  void it('keeps a write that happened a success', async () => {
    const adapter = memoryAdapter();
    const heard: (StoredValue | null)[] = [];
    adapter.subscribe?.('k', () => {
      throw new Error('listener bug');
    });
    adapter.subscribe?.('k', (stored) => heard.push(stored));
    assert.deepEqual(expectOk(await adapter.set('k', 'v', { signal })), {
      value: 'v',
      revision: '1',
    });
    expectOk(
      (await adapter.remove?.('k', { signal })) ?? failure('invalid', 'x')
    );
    assert.equal(heard.length, 2, 'the other subscriber still hears both');
  });
});

void describe('withRetry when the wait itself fails', () => {
  const down: StorageAdapter = {
    get: () => Promise.resolve(failure('unavailable', 'down')),
    set: () => Promise.resolve(failure('unavailable', 'down')),
    remove: () => Promise.resolve(failure('unavailable', 'down')),
  };

  void it('returns an unavailable result that names the key, instead of rejecting', async () => {
    const adapter = withRetry(down, {
      sleep: () => Promise.reject(new Error('sleep failed')),
    });
    const message = expectFailure(
      await adapter.get('the-key', { signal }),
      'unavailable'
    );
    assert.match(message, /"the-key"/);
    assert.match(message, /sleep failed/);
    expectFailure(await adapter.set('the-key', 'v', { signal }), 'unavailable');
    expectFailure(
      (await adapter.remove?.('the-key', { signal })) ??
        failure('invalid', 'x'),
      'unavailable'
    );
  });

  void it('does not start another attempt when aborted during the wait', async () => {
    const controller = new AbortController();
    let calls = 0;
    const counting: StorageAdapter = {
      ...down,
      get: () => {
        calls += 1;
        return Promise.resolve(failure('unavailable', 'down'));
      },
    };
    const adapter = withRetry(counting, {
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    expectFailure(
      await adapter.get('k', { signal: controller.signal }),
      'unavailable'
    );
    assert.equal(calls, 1);
  });
});

void describe('withFallback and ifRevision', () => {
  const down: StorageAdapter = {
    get: () => Promise.resolve(failure('unavailable', 'down')),
    set: () => Promise.resolve(failure('unavailable', 'down')),
  };

  void it('checks the revision on the secondary when the primary is down', async () => {
    const secondary = memoryAdapter({ k: 'old' });
    const adapter = withFallback(down, secondary);
    expectFailure(
      await adapter.set('k', 'next', { signal, ifRevision: '99' }),
      'conflict'
    );
    assert.deepEqual(await secondary.get('k', { signal }), {
      ok: true,
      value: { value: 'old', revision: '1' },
    });
    expectOk(await adapter.set('k', 'next', { signal, ifRevision: '1' }));
  });

  void it('still mirrors to the secondary without the primary revision when the primary works', async () => {
    const primary = memoryAdapter({ k: 'a' });
    const secondary = memoryAdapter({ k: 'b' });
    const adapter = withFallback(primary, secondary);
    expectOk(await adapter.set('k', 'c', { signal, ifRevision: '1' }));
    assert.equal(
      expectOk(await secondary.get('k', { signal }))?.value,
      'c',
      'the secondary has its own revisions and is simply kept in step'
    );
  });
});

void describe('withReadCache and reads that finish late', () => {
  /** An adapter whose `get` reads now but answers when `release` is called. */
  function slowReads(inner: StorageAdapter): {
    adapter: StorageAdapter;
    release: () => void;
  } {
    const gate = deferred();
    return {
      release: () => gate.resolve(),
      adapter: {
        ...inner,
        get: async (key, options) => {
          const result = await inner.get(key, options);
          await gate.promise;
          return result;
        },
      },
    };
  }

  void it('does not bring a removed value back', async () => {
    const inner = memoryAdapter({ k: 'old' });
    const { adapter: slow, release } = slowReads(inner);
    const cached = withReadCache(slow);
    const reading = cached.get('k', { signal });
    await tick();
    expectOk(
      (await cached.remove?.('k', { signal })) ?? failure('invalid', 'x')
    );
    release();
    assert.equal(expectOk(await reading)?.value, 'old');
    assert.deepEqual(await cached.get('k', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('does not let an older write overwrite a newer one in the cache', async () => {
    const first = deferred();
    const inner = memoryAdapter();
    let calls = 0;
    const slowFirst: StorageAdapter = {
      ...inner,
      set: async (key, value, options) => {
        calls += 1;
        if (calls === 1) {
          const result = await inner.set(key, value, options);
          await first.promise;
          return result;
        }
        return inner.set(key, value, options);
      },
    };
    const cached = withReadCache(slowFirst);
    const older = cached.set('k', 'older', { signal });
    await tick();
    expectOk(await cached.set('k', 'newer', { signal }));
    first.resolve();
    expectOk(await older);
    const read = expectOk(await cached.get('k', { signal }));
    const stored = expectOk(await inner.get('k', { signal }));
    assert.equal(read?.value, stored?.value, 'the cache agrees with the store');
  });

  void it('does not cache a read that a change notice overtook', async () => {
    const inner = memoryAdapter({ k: 'old' });
    const { adapter: slow, release } = slowReads(inner);
    const cached = withReadCache(slow);
    cached.subscribe?.('k', () => undefined);
    const reading = cached.get('k', { signal });
    await tick();
    await inner.set('k', 'new', { signal }); // The notice reaches the cache.
    release();
    await reading;
    assert.equal(expectOk(await cached.get('k', { signal }))?.value, 'new');
  });
});

void describe('withEncoding and subscribe', () => {
  void it('reports a value that cannot be decoded instead of dropping it', async () => {
    const inner = memoryAdapter();
    const problems: string[] = [];
    const adapter = withEncoding(inner, {
      encode: (value) => value,
      decode: () => {
        throw new Error('bad cipher');
      },
      onSubscribeError: (key, message) => problems.push(`${key}: ${message}`),
    });
    const heard: (StoredValue | null)[] = [];
    adapter.subscribe?.('k', (stored) => heard.push(stored));
    expectOk(await inner.set('k', 'x', { signal }));
    await tick();
    assert.deepEqual(heard, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^k: .*"k".*bad cipher/);
  });

  void it('does not deliver a slow decode after a newer change', async () => {
    const inner = memoryAdapter();
    const slow = deferred();
    const adapter = withEncoding(inner, {
      encode: (value) => value,
      decode: async (value) => {
        if (value === 'first') {
          await slow.promise;
        }
        return value.toUpperCase();
      },
    });
    const heard: string[] = [];
    adapter.subscribe?.('k', (stored) => heard.push(stored?.value ?? 'null'));
    await inner.set('k', 'first', { signal });
    await inner.set('k', 'second', { signal });
    await tick();
    slow.resolve();
    await tick();
    assert.deepEqual(heard, ['SECOND']);
  });
});

void describe('createPersistence field names', () => {
  void it('refuses fields that hold the envelope version and timestamp', () => {
    for (const field of ['v', 'savedAt']) {
      assert.throws(
        () =>
          createPersistence<string>(memoryAdapter(), {
            parse: String,
            field,
          }),
        new RegExp(`"${field}"`)
      );
    }
  });

  void it('round-trips with any other field name', async () => {
    const store = createPersistence<string>(memoryAdapter(), {
      parse: String,
      field: 'payload',
    });
    expectOk(await store.save('k', 'hello'));
    assert.equal(expectOk(await store.load('k')).value, 'hello');
  });
});

void describe('createPersistence conflicts', () => {
  const parse = (raw: unknown): string => String(raw);

  void it('merges once, however often the merged save conflicts', async () => {
    const inner = memoryAdapter();
    let merges = 0;
    let sets = 0;
    let bump = 0;
    const adapter: StorageAdapter = {
      ...inner,
      set: async (key, value, options) => {
        sets += 1;
        // Another writer gets in before every write.
        bump += 1;
        await inner.set(key, JSON.stringify({ v: 1, value: `theirs${bump}` }), {
          signal,
        });
        return inner.set(key, value, options);
      },
    };
    const store = createPersistence<string>(adapter, {
      parse,
      onConflict: (mine, theirs) => {
        merges += 1;
        return `${mine}+${theirs}`;
      },
    });
    expectOk(
      await adapter.set('k', JSON.stringify({ v: 1, value: 'start' }), {
        signal,
      })
    );
    await store.load('k');
    sets = 0;
    const saved = expectOk(await store.save('k', 'mine'));
    assert.equal(saved.outcome, 'conflict');
    assert.equal(merges, 1);
    assert.equal(sets, 2, 'the save and one merged save, nothing more');
    // A later save is not stuck behind the first.
    assert.ok((await store.save('k', 'again')).ok);
  });

  void it('a queued forced save does not make the save that replaced it forced', async () => {
    const inner = memoryAdapter();
    const gate = deferred();
    let calls = 0;
    const adapter: StorageAdapter = {
      ...inner,
      set: async (key, value, options) => {
        calls += 1;
        if (calls !== 2) {
          return inner.set(key, value, options);
        }
        // The in-flight save: hold it, let it finish, then another writer changes
        // the row before the queued save gets to run.
        await gate.promise;
        const result = await inner.set(key, value, options);
        await inner.set(key, JSON.stringify({ v: 1, value: 'external' }), {
          signal,
        });
        return result;
      },
    };
    const store = createPersistence<string>(adapter, { parse });
    expectOk(await store.save('k', 'start')); // calls === 1
    const inFlight = store.save('k', 'one');
    await tick();
    const forced = store.save('k', 'forced', { force: true });
    const plain = store.save('k', 'plain');
    gate.resolve();
    await inFlight;
    for (const result of await Promise.all([forced, plain])) {
      assert.equal(expectOk(result).outcome, 'conflict');
    }
    assert.match(
      expectOk(await inner.get('k', { signal }))?.value ?? '',
      /external/
    );
  });

  void it('keeps the tracked revision when remove fails', async () => {
    const inner = memoryAdapter();
    let failRemove = true;
    const adapter: StorageAdapter = {
      ...inner,
      remove: (key, options) =>
        failRemove
          ? Promise.resolve(failure('unavailable', 'remove failed'))
          : (inner.remove?.(key, options) ??
            Promise.resolve(failure('invalid', 'x'))),
    };
    const store = createPersistence<string>(adapter, { parse });
    expectOk(await store.save('k', 'mine'));
    expectFailure(await store.remove('k'), 'unavailable');
    const external = JSON.stringify({ v: 1, value: 'external' });
    expectOk(await inner.set('k', external, { signal }));
    assert.equal(expectOk(await store.save('k', 'next')).outcome, 'conflict');
    assert.equal(expectOk(await inner.get('k', { signal }))?.value, external);
    failRemove = false;
    expectOk(await store.remove('k'));
  });

  void it('remembers what it wrote only when the write worked', async () => {
    const inner = memoryAdapter();
    let failNext = false;
    const adapter: StorageAdapter = {
      ...inner,
      set: (key, value, options) =>
        failNext
          ? Promise.resolve(failure('unavailable', 'down'))
          : inner.set(key, value, options),
    };
    const store = createPersistence<string>(adapter, { parse, now: () => 0 });
    const heard: string[] = [];
    store.watch('k', (loaded) => heard.push(String(loaded.value)));
    failNext = true;
    expectFailure(await store.save('k', 'never stored'), 'unavailable');
    failNext = false;
    // Someone else now stores exactly the text that failed to save here. It is a
    // change from elsewhere, not an echo of a save, so it must be reported.
    await inner.set(
      'k',
      JSON.stringify({
        v: 1,
        savedAt: new Date(0).toISOString(),
        value: 'never stored',
      }),
      { signal }
    );
    assert.deepEqual(heard, ['never stored']);
  });
});

void describe('documentFileAdapter without a cache', () => {
  void it('does not report the document as it was before a write that already finished', async () => {
    const fileSystem = fakeFileSystem(false);
    const adapter = jsonFileAdapter({
      path: '/data/s.json',
      fileSystem,
      cache: false,
      watch: false,
    });
    expectOk(await adapter.set('k', 'v1', { signal }));
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'v1');
    const heard: string[] = [];
    adapter.subscribe?.('k', (stored) => heard.push(stored?.value ?? 'null'));

    // Make the next read take the file as it is now, but finish only when told.
    const gate = deferred();
    const realRead = fileSystem.readFile.bind(fileSystem);
    let held = false;
    fileSystem.readFile = async (path) => {
      const text = await realRead(path);
      if (!held) {
        held = true;
        await gate.promise;
      }
      return text;
    };
    const reading = adapter.get('k', { signal });
    await tick();
    const writing = adapter.set('k', 'v2', { signal });
    await tick();
    gate.resolve();
    await Promise.all([reading, writing]);
    await tick();
    assert.equal(heard.at(-1), 'v2', `subscribers heard ${heard.join(', ')}`);
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'v2');
  });
});

void describe('temporary files', () => {
  void it('skips a name that is taken and never writes through it', async () => {
    const fileSystem = fakeFileSystem(false);
    const taken: string[] = [];
    fileSystem.writeNewFile = (path, data) => {
      if (taken.length < 2) {
        taken.push(path);
        return Promise.reject(errorWithCode('EEXIST'));
      }
      fileSystem.files.set(path, data);
      return Promise.resolve();
    };
    const made = await writeTemporaryFile(fileSystem, '/d/file', 'data');
    assert.equal(fileSystem.files.get(made), 'data');
    assert.ok(!taken.includes(made));
    for (const path of taken) {
      assert.equal(fileSystem.files.has(path), false);
    }
    assert.match(made, /^\/d\/file\.[0-9a-f]{16}\.tmp$/);
  });

  void it('gives up after trying several names, and says why', async () => {
    const fileSystem = fakeFileSystem(false);
    fileSystem.writeNewFile = () => Promise.reject(errorWithCode('EEXIST'));
    await assert.rejects(
      () => writeTemporaryFile(fileSystem, '/d/file', 'data'),
      /unused temporary file name/
    );
  });

  void it('does not delete a file it did not create when the rename fails', async () => {
    const fileSystem = withExclusiveCreate(fakeFileSystem(false));
    fileSystem.failures.rename = errorWithCode('EACCES');
    const adapter = jsonFileAdapter({
      path: '/d/s.json',
      fileSystem,
      watch: false,
    });
    const result = await adapter.set('k', 'v', { signal });
    assert.equal(expectFailure(result, 'forbidden').includes('"k"'), true);
    const removed = fileSystem.calls.filter((call) =>
      call.startsWith('remove ')
    );
    const created = fileSystem.calls.filter((call) =>
      call.startsWith('writeNewFile ')
    );
    assert.equal(created.length, 1);
    assert.deepEqual(
      removed.map((call) => call.replace('remove ', '')),
      created.map((call) => call.replace('writeNewFile ', ''))
    );
  });

  void it('node: creates exclusively and refuses a name that exists, a symbolic link too', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'exclusive-'));
    try {
      const fileSystem = nodeFileSystem();
      assert.ok(fileSystem.writeNewFile, 'node supports exclusive create');
      const target = join(folder, 'target.txt');
      await fileSystem.writeFile(target, 'precious');
      const link = join(folder, 'link.tmp');
      symlinkSync(target, link);
      await assert.rejects(
        () =>
          fileSystem.writeNewFile?.(link, 'attacker data') ?? Promise.resolve(),
        (error: unknown) => (error as { code?: string }).code === 'EEXIST'
      );
      assert.equal(readFileSync(target, 'utf8'), 'precious');
      const fresh = join(folder, 'fresh.tmp');
      await fileSystem.writeNewFile?.(fresh, 'ok');
      assert.equal(readFileSync(fresh, 'utf8'), 'ok');
      await assert.rejects(
        () => fileSystem.writeNewFile?.(fresh, 'again') ?? Promise.resolve(),
        (error: unknown) => (error as { code?: string }).code === 'EEXIST'
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe('localStorageAdapter when another tab wrote in between', () => {
  void it('reports conflict when the key holds another write after ours', async () => {
    const store = new Map<string, string>();
    let intrude = false;
    const storage: WebStorageLike = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
        if (intrude) {
          // Another tab's write lands right after ours.
          intrude = false;
          store.set(key, JSON.stringify({ r: '2', v: 'from the other tab' }));
        }
      },
      removeItem: (key) => {
        store.delete(key);
      },
    };
    const adapter = localStorageAdapter({ storage });
    expectOk(await adapter.set('k', 'v1', { signal }));
    intrude = true;
    const message = expectFailure(
      await adapter.set('k', 'mine', { signal, ifRevision: '1' }),
      'conflict'
    );
    assert.match(message, /another tab/);
    assert.match(message, /"k"/);
    assert.deepEqual(await adapter.get('k', { signal }), {
      ok: true,
      value: { value: 'from the other tab', revision: '2' },
    });
  });
});
