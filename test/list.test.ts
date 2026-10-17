/** `list()` beyond the shared contract: wrappers, adapters that cannot list, and odd cases. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { localStorageAdapter } from '../src/browser/index.js';
import { decodeKey, encodeKey, fileAdapter } from '../src/file/file.js';
import { nodeFileSystem } from '../src/file/node.js';
import {
  compareKeys,
  keysWithPrefix,
  memoryAdapter,
  readOnly,
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
import { jsonFileAdapter } from '../src/json-file/index.js';
import { redisAdapter, type RedisClientLike } from '../src/redis/index.js';
import { s3Adapter } from '../src/s3/index.js';
import { failure } from '../src/storage.js';
import { sqliteAdapter } from '../src/sqlite/index.js';
import { fakeFileSystem } from './support/fake-file-system.js';
import { fakeObjectStore } from './support/fake-object-store.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T> | undefined): T {
  if (result === undefined || !result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

function expectFailure<T>(
  result: StoreResult<T> | undefined,
  code: string
): string {
  if (result === undefined || result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  return result.error;
}

async function fill(adapter: StorageAdapter, keys: string[]): Promise<void> {
  for (const key of keys) {
    expectOk(await adapter.set(key, key, { signal }));
  }
}

void describe('key helpers', () => {
  void it('sorts by code unit and filters by prefix', () => {
    assert.deepEqual(keysWithPrefix(['b', 'B', 'a', 'ab'], 'a'), ['a', 'ab']);
    assert.deepEqual(keysWithPrefix(new Set(['b', 'B', 'a']), ''), [
      'B',
      'a',
      'b',
    ]);
    assert.equal(compareKeys('a', 'b'), -1);
    assert.equal(compareKeys('b', 'a'), 1);
    assert.equal(compareKeys('a', 'a'), 0);
  });

  void it('decodeKey reverses encodeKey, and refuses a name encodeKey could not make', () => {
    for (const key of [
      'a',
      'Settings',
      'dir/one',
      'with space',
      'Élan',
      'emoji-😀',
      'a.b',
      'A-b_c',
    ]) {
      const stem = encodeKey(key);
      assert.ok(stem !== undefined);
      assert.equal(decodeKey(stem), key, key);
    }
    for (const stray of [
      'UPPER',
      'a.b',
      '~zz',
      '~e9',
      '_',
      '_1',
      'a~c3',
      '~c0~80',
      '~ed~a0~80',
      '',
    ]) {
      assert.equal(decodeKey(stray), undefined, JSON.stringify(stray));
    }
  });
});

void describe('wrappers and list', () => {
  void it('withPrefix lists inside its namespace and strips the prefix', async () => {
    const inner = memoryAdapter();
    await fill(inner, ['app:a', 'app:b', 'other:c']);
    const adapter = withPrefix(inner, 'app:');
    assert.deepEqual(expectOk(await adapter.list?.('', { signal })), [
      'a',
      'b',
    ]);
    assert.deepEqual(expectOk(await adapter.list?.('b', { signal })), ['b']);
  });

  void it('withFallback merges both stores, and survives one failing', async () => {
    const primary = memoryAdapter();
    const secondary = memoryAdapter();
    await fill(primary, ['a', 'b']);
    await fill(secondary, ['b', 'c']);
    const merged = withFallback(primary, secondary);
    assert.deepEqual(expectOk(await merged.list?.('', { signal })), [
      'a',
      'b',
      'c',
    ]);
    const broken: StorageAdapter = {
      ...primary,
      list: () => Promise.resolve(failure('unavailable', 'down')),
    };
    assert.deepEqual(
      expectOk(await withFallback(broken, secondary).list?.('', { signal })),
      ['b', 'c']
    );
    const bothBroken = withFallback(broken, broken);
    expectFailure(await bothBroken.list?.('', { signal }), 'unavailable');
  });

  void it('withFallback has no list when neither store has one', () => {
    const bare: StorageAdapter = {
      get: memoryAdapter().get,
      set: memoryAdapter().set,
    };
    assert.equal(withFallback(bare, bare).list, undefined);
    assert.equal(withPrefix(bare, 'x').list, undefined);
  });

  void it('the other wrappers pass list through', async () => {
    const inner = memoryAdapter();
    await fill(inner, ['a', 'b']);
    const events: StorageLogEvent[] = [];
    const wrapped: StorageAdapter[] = [
      readOnly(inner),
      withReadCache(inner),
      withEncoding(inner, { encode: (v) => v, decode: (v) => v }),
      withLogging(inner, (event) => events.push(event)),
    ];
    for (const adapter of wrapped) {
      assert.deepEqual(expectOk(await adapter.list?.('', { signal })), [
        'a',
        'b',
      ]);
    }
    assert.deepEqual(events, [{ operation: 'list', key: '', ok: true }]);
  });

  void it('withLogging reports a failed listing with its code, and the prefix as the key', async () => {
    const events: StorageLogEvent[] = [];
    const adapter = withLogging(
      {
        ...memoryAdapter(),
        list: () => Promise.resolve(failure('forbidden', 'no')),
      },
      (event) => events.push(event)
    );
    await adapter.list?.('p', { signal });
    assert.deepEqual(events, [
      { operation: 'list', key: 'p', ok: false, code: 'forbidden' },
    ]);
  });

  void it('withRetry retries a listing that is unavailable', async () => {
    let calls = 0;
    const flaky: StorageAdapter = {
      ...memoryAdapter(),
      list: () => {
        calls += 1;
        return Promise.resolve(
          calls < 3
            ? failure('unavailable', 'down')
            : { ok: true as const, value: ['k'] }
        );
      },
    };
    const adapter = withRetry(flaky, { sleep: () => Promise.resolve() });
    assert.deepEqual(expectOk(await adapter.list?.('', { signal })), ['k']);
    assert.equal(calls, 3);
  });
});

void describe('adapters that cannot list say so', () => {
  void it('a file system without listFiles', async () => {
    const fileSystem = fakeFileSystem(false);
    delete (fileSystem as { listFiles?: unknown }).listFiles;
    const message = expectFailure(
      await fileAdapter({ directory: '/d', fileSystem }).list?.('p', {
        signal,
      }),
      'invalid'
    );
    assert.match(message, /listFiles/);
    assert.match(message, /for prefix "p"$/);
  });

  void it('SQLite without all()', async () => {
    const statements = new Map<string, unknown>();
    const adapter = sqliteAdapter({
      database: {
        exec: () => undefined,
        prepare: () => {
          const statement = { run: () => undefined, get: () => undefined };
          statements.set('s', statement);
          return statement;
        },
      },
    });
    assert.match(
      expectFailure(await adapter.list?.('p', { signal }), 'invalid'),
      /no all\(\) method/
    );
  });

  void it('a web storage without length and key()', async () => {
    const adapter = localStorageAdapter({
      storage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
    assert.match(
      expectFailure(await adapter.list?.('p', { signal }), 'invalid'),
      /no length and key\(\)/
    );
  });

  void it('an object store without listKeys', async () => {
    const store = fakeObjectStore();
    delete (store as { listKeys?: unknown }).listKeys;
    assert.match(
      expectFailure(
        await s3Adapter({ store }).list?.('p', { signal }),
        'invalid'
      ),
      /no listKeys/
    );
  });
});

void describe('list in particular adapters', () => {
  void it('the web storage adapter lists only its own envelopes, not other keys on the page', async () => {
    const map = new Map<string, string>([
      ['foreign', 'plain text'],
      ['foreign-json', '{"not":"ours"}'],
    ]);
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      get length() {
        return map.size;
      },
      key: (index: number) => [...map.keys()][index] ?? null,
    };
    const adapter = localStorageAdapter({ storage });
    await fill(adapter, ['mine']);
    assert.deepEqual(expectOk(await adapter.list?.('', { signal })), ['mine']);
  });

  void it('the S3 adapter strips its prefix, hides its check objects and other prefixes', async () => {
    const store = fakeObjectStore();
    const adapter = s3Adapter({ store, prefix: 'app/' });
    await fill(adapter, ['a', 'b']);
    store.objects.set('app/.storage-adapters-probe-123', 'x');
    store.objects.set('other/c', 'x');
    store.objects.set('app2/d', 'x');
    assert.deepEqual(expectOk(await adapter.list?.('', { signal })), [
      'a',
      'b',
    ]);
    assert.ok(store.calls.includes('list app/'));
  });

  void it('the S3 adapter reports a failing listing with the store name and prefix', async () => {
    const store = fakeObjectStore();
    store.listKeys = () =>
      Promise.reject(
        Object.assign(new Error('denied'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        })
      );
    const message = expectFailure(
      await s3Adapter({ store, name: 'Spaces' }).list?.('p', { signal }),
      'forbidden'
    );
    assert.match(
      message,
      /^Spaces could not list keys \(denied\) for prefix "p"$/
    );
  });

  void it('the Redis adapter follows SCAN pages, escapes glob characters and drops duplicates', async () => {
    const asked: string[][] = [];
    const pages: Record<string, [string, string[]]> = {
      '0': ['7', ['p:a1', 'p:a2']],
      '7': ['0', ['p:a2', 'p:a3', 'q:zzz']],
    };
    const client: RedisClientLike = {
      command: (args) => {
        asked.push([...args]);
        return Promise.resolve(pages[args[1] ?? '0']);
      },
    };
    const adapter = redisAdapter({ client, prefix: 'p:' });
    assert.deepEqual(expectOk(await adapter.list?.('a', { signal })), [
      'a1',
      'a2',
      'a3',
    ]);
    assert.deepEqual(asked[0]?.slice(2, 4), ['MATCH', 'p:a*']);
    await adapter.list?.('x*y[z]?\\', { signal });
    assert.equal(asked.at(-1)?.[3], 'p:x\\*y\\[z\\]\\?\\\\*');
  });

  void it('the Redis adapter says corrupt for a reply that is not a SCAN page', async () => {
    const adapter = redisAdapter({
      client: { command: () => Promise.resolve('nonsense') },
    });
    expectFailure(await adapter.list?.('p', { signal }), 'corrupt');
  });

  void it('the file adapter lists a folder that does not exist yet as empty, and skips stray files', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'list-'));
    try {
      const adapter = fileAdapter({
        directory: join(folder, 'later'),
        fileSystem: nodeFileSystem(),
      });
      assert.deepEqual(expectOk(await adapter.list?.('', { signal })), []);
      await fill(adapter, ['Key', 'dir/x']);
      writeFileSync(join(folder, 'later', 'notes.txt'), 'x');
      writeFileSync(join(folder, 'later', 'Weird Name.json'), '{}');
      writeFileSync(join(folder, 'later', 'key.json.abc.tmp'), '{}');
      assert.deepEqual(expectOk(await adapter.list?.('', { signal })), [
        'Key',
        'dir/x',
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  void it('a document adapter leaves out an entry that is not valid, and refuses a corrupt file', async () => {
    const fileSystem = fakeFileSystem(false);
    fileSystem.files.set(
      '/s.json',
      JSON.stringify({ good: { r: '1', v: 'x' }, bad: 5 })
    );
    const adapter = jsonFileAdapter({
      path: '/s.json',
      fileSystem,
      watch: false,
    });
    assert.deepEqual(expectOk(await adapter.list?.('', { signal })), ['good']);
    fileSystem.files.set('/s.json', '{broken');
    const broken = jsonFileAdapter({
      path: '/s.json',
      fileSystem,
      watch: false,
    });
    const message = expectFailure(
      await broken.list?.('', { signal }),
      'corrupt'
    );
    assert.match(message, /for prefix ""$/);
  });
});
