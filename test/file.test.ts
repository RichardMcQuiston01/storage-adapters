import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { encodeKey } from '../src/file/file.js';
import { fileAdapter, type FileSystemLike } from '../src/file/index.js';
import { nodeFileSystem } from '../src/file/node.js';
import type { StoredValue, StoreResult } from '../src/storage.js';

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

/** Runs `run` with a fresh temporary directory and removes it afterwards. */
async function withDirectory(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory: string = mkdtempSync(join(tmpdir(), 'file-adapter-'));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function realAdapter(directory: string): ReturnType<typeof fileAdapter> {
  return fileAdapter({ directory, fileSystem: nodeFileSystem() });
}

function errorWithCode(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/** An in-memory file system whose operations can be made to fail. */
interface FakeFileSystem extends FileSystemLike {
  readonly files: Map<string, string>;
  readonly calls: string[];
  failures: Partial<Record<keyof FileSystemLike, Error>>;
}

function fakeFileSystem(): FakeFileSystem {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const fake: FakeFileSystem = {
    files,
    calls,
    failures: {},
    readFile: (path) => {
      calls.push(`readFile ${path}`);
      if (fake.failures.readFile !== undefined) {
        return Promise.reject(fake.failures.readFile);
      }
      const text = files.get(path);
      return text === undefined
        ? Promise.reject(errorWithCode('ENOENT'))
        : Promise.resolve(text);
    },
    writeFile: (path, data) => {
      calls.push(`writeFile ${path}`);
      if (fake.failures.writeFile !== undefined) {
        return Promise.reject(fake.failures.writeFile);
      }
      files.set(path, data);
      return Promise.resolve();
    },
    rename: (fromPath, toPath) => {
      calls.push(`rename ${fromPath}`);
      if (fake.failures.rename !== undefined) {
        return Promise.reject(fake.failures.rename);
      }
      const text = files.get(fromPath);
      if (text === undefined) {
        return Promise.reject(errorWithCode('ENOENT'));
      }
      files.delete(fromPath);
      files.set(toPath, text);
      return Promise.resolve();
    },
    remove: (path) => {
      calls.push(`remove ${path}`);
      if (fake.failures.remove !== undefined) {
        return Promise.reject(fake.failures.remove);
      }
      files.delete(path);
      return Promise.resolve();
    },
    mkdir: (path) => {
      calls.push(`mkdir ${path}`);
      return fake.failures.mkdir !== undefined
        ? Promise.reject(fake.failures.mkdir)
        : Promise.resolve();
    },
  };
  return fake;
}

void describe('encodeKey', () => {
  void it('keeps lowercase letters, digits and hyphens as they are', () => {
    assert.equal(encodeKey('layout-1'), 'layout-1');
  });

  void it('turns an uppercase letter into an underscore and its lowercase form', () => {
    assert.equal(encodeKey('MyKey'), '_my_key');
  });

  void it('escapes every other byte of the UTF-8 as ~ and two hex digits', () => {
    assert.equal(encodeKey('a b'), 'a~20b');
    assert.equal(encodeKey('a/b'), 'a~2fb');
    assert.equal(encodeKey('a\\b'), 'a~5cb');
    assert.equal(encodeKey('a:b'), 'a~3ab');
    assert.equal(encodeKey('é'), '~c3~a9');
    assert.equal(encodeKey('日'), '~e6~97~a5');
    assert.equal(encodeKey('😀'), '~f0~9f~98~80');
    assert.equal(encodeKey('a\u0000b'), 'a~00b');
  });

  void it('escapes dots, underscores and tildes so names cannot be . or .. or hidden', () => {
    assert.equal(encodeKey('.'), '~2e');
    assert.equal(encodeKey('..'), '~2e~2e');
    assert.equal(encodeKey('.hidden'), '~2ehidden');
    assert.equal(encodeKey('trailing.'), 'trailing~2e');
    assert.equal(encodeKey('a_b'), 'a~5fb');
    assert.equal(encodeKey('a~b'), 'a~7eb');
  });

  void it('only ever produces characters that are safe in a file name', () => {
    const awkward = [
      '../../etc/passwd',
      'CON',
      'nul',
      'a*b?c"d<e>f|g',
      'é/日\u0001',
    ];
    for (const key of awkward) {
      assert.match(encodeKey(key) ?? '', /^[a-z0-9_~-]+$/);
    }
  });

  void it('never maps two different keys to the same name, even ignoring case', () => {
    const alphabet = ['a', 'A', 'b', '_', '~', '.', '-', '1', '/', 'é', '😀'];
    const seen = new Map<string, string>();
    const visit = (prefix: string, depth: number): void => {
      if (prefix !== '') {
        const stem = encodeKey(prefix);
        assert.ok(
          stem !== undefined,
          `${JSON.stringify(prefix)} should encode`
        );
        const folded = stem.toLowerCase();
        const earlier = seen.get(folded);
        assert.ok(
          earlier === undefined || earlier === prefix,
          `${JSON.stringify(prefix)} and ${JSON.stringify(earlier)} share ${stem}`
        );
        seen.set(folded, prefix);
      }
      if (depth > 0) {
        for (const char of alphabet) {
          visit(prefix + char, depth - 1);
        }
      }
    };
    visit('', 4);
    assert.ok(seen.size > 10000);
  });

  void it('refuses an empty key, a lone surrogate, and a key that encodes too long', () => {
    assert.equal(encodeKey(''), undefined);
    assert.equal(encodeKey('\ud800'), undefined);
    assert.equal(encodeKey('ok\udc00'), undefined);
    assert.equal(encodeKey('a'.repeat(200)), 'a'.repeat(200));
    assert.equal(encodeKey('a'.repeat(201)), undefined);
    assert.equal(encodeKey('/'.repeat(67)), undefined);
  });
});

void describe('nodeFileSystem', () => {
  void it('reads, writes, renames over an existing file, and removes', () =>
    withDirectory(async (directory) => {
      const fileSystem = nodeFileSystem();
      const nested = join(directory, 'a', 'b');
      await fileSystem.mkdir(nested);
      await fileSystem.mkdir(nested); // an existing directory is fine
      await fileSystem.writeFile(join(nested, 'one'), 'héllo');
      assert.equal(await fileSystem.readFile(join(nested, 'one')), 'héllo');
      await fileSystem.writeFile(join(nested, 'two'), 'new');
      await fileSystem.rename(join(nested, 'two'), join(nested, 'one'));
      assert.equal(await fileSystem.readFile(join(nested, 'one')), 'new');
      await fileSystem.remove(join(nested, 'one'));
      await fileSystem.remove(join(nested, 'one')); // already gone is fine
      await assert.rejects(fileSystem.readFile(join(nested, 'one')), {
        code: 'ENOENT',
      });
    }));
});

void describe('fileAdapter on a real directory', () => {
  void it('returns null for a missing key, without creating the directory', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(join(directory, 'store'));
      assert.deepEqual(await adapter.get('a', { signal }), {
        ok: true,
        value: null,
      });
      assert.deepEqual(readdirSync(directory), []);
    }));

  void it('stores a value with an incrementing revision, in one file per key', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(join(directory, 'nested', 'store'));
      assert.deepEqual(expectOk(await adapter.set('Key', 'one', { signal })), {
        value: 'one',
        revision: '1',
      });
      assert.deepEqual(expectOk(await adapter.set('Key', 'two', { signal })), {
        value: 'two',
        revision: '2',
      });
      assert.deepEqual(expectOk(await adapter.get('Key', { signal })), {
        value: 'two',
        revision: '2',
      });
      const store = join(directory, 'nested', 'store');
      assert.deepEqual(readdirSync(store), ['_key.json']);
      assert.deepEqual(
        JSON.parse(readFileSync(join(store, '_key.json'), 'utf8')),
        { r: '2', v: 'two' }
      );
    }));

  void it('treats a directory with a trailing slash as the same directory', () =>
    withDirectory(async (directory) => {
      expectOk(await realAdapter(`${directory}/`).set('a', 'x', { signal }));
      assert.equal(
        expectOk(await realAdapter(directory).get('a', { signal }))?.value,
        'x'
      );
      assert.deepEqual(readdirSync(directory), ['a.json']);
    }));

  void it('keeps data between adapters, and between uses of the same directory', () =>
    withDirectory(async (directory) => {
      expectOk(await realAdapter(directory).set('a', 'kept', { signal }));
      assert.deepEqual(
        expectOk(await realAdapter(directory).get('a', { signal })),
        { value: 'kept', revision: '1' }
      );
    }));

  void it('round-trips unicode, quotes and large values unchanged', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      const value = `{"name":"Zoë","note":"it's 日本語 😀 \\ ' \\" \n line two"}`;
      expectOk(await adapter.set('k', value, { signal }));
      assert.equal(expectOk(await adapter.get('k', { signal }))?.value, value);
      const large = 'x'.repeat(5 * 1024 * 1024);
      expectOk(await adapter.set('big', large, { signal }));
      assert.equal(
        expectOk(await adapter.get('big', { signal }))?.value.length,
        large.length
      );
    }));

  void it('reports a conflict for a stale ifRevision and keeps the value', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      expectOk(await adapter.set('a', 'one', { signal }));
      const result = await adapter.set('a', 'two', { signal, ifRevision: '9' });
      expectFailure(result, 'conflict', 'a');
      assert.ok(
        !result.ok &&
          /holds revision 1, but revision 9 was expected/.test(result.error)
      );
      assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
        value: 'one',
        revision: '1',
      });
    }));

  void it('writes when ifRevision matches, or when nothing is stored', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
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
    }));

  void it('removes a key, and removing a missing key succeeds', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      expectOk(await adapter.set('a', 'one', { signal }));
      assert.deepEqual(await adapter.remove?.('a', { signal }), {
        ok: true,
        value: null,
      });
      assert.deepEqual(await adapter.get('a', { signal }), {
        ok: true,
        value: null,
      });
      assert.deepEqual(readdirSync(directory), []);
      assert.deepEqual(await adapter.remove?.('never', { signal }), {
        ok: true,
        value: null,
      });
      assert.equal(
        expectOk(await adapter.set('a', 'again', { signal })).revision,
        '1'
      );
    }));

  void it('reports a file that is not an entry as corrupt, and replaces it on write', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      expectOk(await adapter.set('seed', 'x', { signal }));
      const fileSystem = nodeFileSystem();
      await fileSystem.writeFile(join(directory, 'bad.json'), 'not json');
      await fileSystem.writeFile(join(directory, 'half.json'), '{"r":"3"}');
      await fileSystem.writeFile(join(directory, 'null.json'), 'null');
      expectFailure(await adapter.get('bad', { signal }), 'corrupt', 'bad');
      expectFailure(await adapter.get('half', { signal }), 'corrupt', 'half');
      expectFailure(await adapter.get('null', { signal }), 'corrupt', 'null');
      assert.deepEqual(
        expectOk(await adapter.set('bad', 'fixed', { signal })),
        { value: 'fixed', revision: '1' }
      );
    }));

  void it('keeps awkward keys inside the directory', () =>
    withDirectory(async (directory) => {
      const store = join(directory, 'store');
      const adapter = realAdapter(store);
      const keys = [
        '../escape',
        'a/b',
        'C:\\x\\y',
        '.',
        '..',
        'CON',
        'a\u0000b',
      ];
      for (const key of keys) {
        expectOk(await adapter.set(key, `value of ${key}`, { signal }));
      }
      for (const key of keys) {
        assert.equal(
          expectOk(await adapter.get(key, { signal }))?.value,
          `value of ${key}`
        );
      }
      assert.deepEqual(readdirSync(directory), ['store']);
      assert.equal(readdirSync(store).length, keys.length);
    }));

  void it('keeps keys that differ only in case apart, even on a case-insensitive disk', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      expectOk(await adapter.set('Key', 'upper', { signal }));
      expectOk(await adapter.set('key', 'lower', { signal }));
      assert.equal(
        expectOk(await adapter.get('Key', { signal }))?.value,
        'upper'
      );
      assert.equal(
        expectOk(await adapter.get('key', { signal }))?.value,
        'lower'
      );
      const names = readdirSync(directory).map((name) => name.toLowerCase());
      assert.equal(new Set(names).size, 2);
    }));

  void it('refuses keys it cannot store, naming the key, without touching the disk', () =>
    withDirectory(async (directory) => {
      const store = join(directory, 'store');
      const adapter = realAdapter(store);
      for (const key of ['', '\ud800', 'x'.repeat(201)]) {
        expectFailure(await adapter.get(key, { signal }), 'invalid', key);
        expectFailure(await adapter.set(key, 'v', { signal }), 'invalid', key);
        expectFailure(
          (await adapter.remove?.(key, { signal })) as StoreResult<null>,
          'invalid',
          key
        );
      }
      assert.deepEqual(readdirSync(directory), []);
    }));

  void it('leaves no temporary files behind', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      for (let index = 0; index < 20; index += 1) {
        expectOk(await adapter.set('a', `v${index}`, { signal }));
      }
      assert.deepEqual(readdirSync(directory), ['a.json']);
    }));

  void it('queues racing writers, so exactly one with the same ifRevision wins', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      expectOk(await adapter.set('a', 'start', { signal }));
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          adapter.set('a', `writer ${index}`, { signal, ifRevision: '1' })
        )
      );
      assert.equal(results.filter((result) => result.ok).length, 1);
      for (const result of results.filter((entry) => !entry.ok)) {
        expectFailure(result, 'conflict', 'a');
      }
      assert.equal(expectOk(await adapter.get('a', { signal }))?.revision, '2');
    }));

  void it('numbers parallel plain writes 1 to N with none lost', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          adapter.set('a', `v${index}`, { signal })
        )
      );
      const revisions = results.map((result) =>
        Number(expectOk(result).revision)
      );
      assert.deepEqual(
        [...revisions].sort((left, right) => left - right),
        Array.from({ length: 50 }, (_, index) => index + 1)
      );
      assert.equal(
        expectOk(await adapter.get('a', { signal }))?.revision,
        '50'
      );
    }));

  void it('shares its queue between adapters on the same directory in one process', () =>
    withDirectory(async (directory) => {
      const first = realAdapter(directory);
      const second = realAdapter(directory);
      expectOk(await first.set('a', 'start', { signal }));
      const results = await Promise.all([
        first.set('a', 'from first', { signal, ifRevision: '1' }),
        second.set('a', 'from second', { signal, ifRevision: '1' }),
      ]);
      assert.equal(results.filter((result) => result.ok).length, 1);
    }));

  void it('does not hold up writes to different keys', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      const results = await Promise.all([
        adapter.set('a', '1', { signal }),
        adapter.set('b', '2', { signal }),
        adapter.set('c', '3', { signal }),
      ]);
      assert.ok(results.every((result) => result.ok));
    }));

  void it('lets a reader see the old value or the new one, never half of a write', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      const first = 'a'.repeat(1024 * 1024);
      const second = 'b'.repeat(1024 * 1024);
      expectOk(await adapter.set('k', first, { signal }));
      const writes = Array.from({ length: 10 }, (_, index) =>
        adapter.set('k', index % 2 === 0 ? second : first, { signal })
      );
      const reads = Array.from({ length: 40 }, () =>
        adapter.get('k', { signal })
      );
      for (const read of await Promise.all(reads)) {
        const stored = expectOk(read);
        assert.ok(stored !== null);
        assert.ok(stored.value === first || stored.value === second);
      }
      await Promise.all(writes);
    }));

  void it('tells subscribers about writes and removals made through adapters in this process', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      const seen: (StoredValue | null)[] = [];
      const unsubscribe: () => void =
        adapter.subscribe?.('a', (stored) => seen.push(stored)) ?? (() => {});
      expectOk(await adapter.set('other', 'x', { signal }));
      expectOk(await adapter.set('a', 'one', { signal }));
      await adapter.remove?.('a', { signal });
      assert.deepEqual(seen, [{ value: 'one', revision: '1' }, null]);
      unsubscribe();
      expectOk(await adapter.set('a', 'two', { signal }));
      assert.equal(seen.length, 2);
    }));

  void it('keeps a successful write successful when a subscriber throws, and does not notify a conflict', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(directory);
      adapter.subscribe?.('a', () => {
        throw new Error('bad listener');
      });
      assert.equal(
        expectOk(await adapter.set('a', 'one', { signal })).revision,
        '1'
      );
      const seen: unknown[] = [];
      adapter.subscribe?.('a', (stored) => seen.push(stored));
      await adapter.set('a', 'two', { signal, ifRevision: '9' });
      assert.equal(seen.length, 0);
    }));
});

void describe('fileAdapter error handling', () => {
  void it('does not touch the file system when the request is already aborted', async () => {
    const fileSystem = fakeFileSystem();
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    const controller = new AbortController();
    controller.abort();
    const stoppedOptions = { signal: controller.signal };
    expectFailure(await adapter.get('a', stoppedOptions), 'unavailable', 'a');
    expectFailure(
      await adapter.set('a', 'v', stoppedOptions),
      'unavailable',
      'a'
    );
    expectFailure(
      (await adapter.remove?.('a', stoppedOptions)) as StoreResult<null>,
      'unavailable',
      'a'
    );
    assert.deepEqual(fileSystem.calls, []);
  });

  void it('maps a full disk to quota, removes the temporary file and keeps the old value', async () => {
    const fileSystem = fakeFileSystem();
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    expectOk(await adapter.set('a', 'one', { signal }));
    fileSystem.failures.writeFile = errorWithCode(
      'ENOSPC',
      'ENOSPC: no space left on device'
    );
    const result = await adapter.set('a', 'two', { signal });
    expectFailure(result, 'quota', 'a');
    assert.ok(!result.ok && result.error.includes('no space left'));
    assert.deepEqual([...fileSystem.files.keys()], ['/data/a.json']);
    fileSystem.failures = {};
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
      value: 'one',
      revision: '1',
    });
  });

  void it('maps permission errors to forbidden and cleans up when the rename fails', async () => {
    const fileSystem = fakeFileSystem();
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    expectOk(await adapter.set('a', 'one', { signal }));
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      fileSystem.failures = { rename: errorWithCode(code) };
      expectFailure(
        await adapter.set('a', 'two', { signal }),
        'forbidden',
        'a'
      );
      assert.deepEqual([...fileSystem.files.keys()], ['/data/a.json']);
    }
    fileSystem.failures = { remove: errorWithCode('EPERM') };
    expectFailure(
      (await adapter.remove?.('a', { signal })) as StoreResult<null>,
      'forbidden',
      'a'
    );
  });

  void it('maps a quota error from the disk-quota code too', async () => {
    const fileSystem = fakeFileSystem();
    fileSystem.failures.writeFile = errorWithCode('EDQUOT');
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    expectFailure(await adapter.set('a', 'v', { signal }), 'quota', 'a');
  });

  void it('maps any other error to unavailable, and an ENOENT on read to a missing key', async () => {
    const fileSystem = fakeFileSystem();
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    fileSystem.failures.readFile = errorWithCode('EIO', 'EIO: i/o error');
    expectFailure(await adapter.get('a', { signal }), 'unavailable', 'a');
    expectFailure(await adapter.set('a', 'v', { signal }), 'unavailable', 'a');
    fileSystem.failures.readFile = errorWithCode('ENOENT');
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
    fileSystem.failures = { writeFile: new Error('plain error, no code') };
    expectFailure(await adapter.set('a', 'v', { signal }), 'unavailable', 'a');
  });

  void it('does not remember a failed directory setup, so the next call tries again', async () => {
    const fileSystem = fakeFileSystem();
    fileSystem.failures.mkdir = errorWithCode('EROFS');
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    expectFailure(await adapter.set('a', 'v', { signal }), 'forbidden', 'a');
    fileSystem.failures = {};
    assert.equal(
      expectOk(await adapter.set('a', 'v', { signal })).revision,
      '1'
    );
    await adapter.set('a', 'w', { signal });
    assert.equal(
      fileSystem.calls.filter((call) => call.startsWith('mkdir')).length,
      2
    );
  });

  void it('releases the queue after a failure, so a write queued behind it still goes through', async () => {
    const fileSystem = fakeFileSystem();
    const writeFile = fileSystem.writeFile;
    let failNextWrite = true;
    fileSystem.writeFile = (path, data) => {
      if (failNextWrite) {
        failNextWrite = false;
        return Promise.reject(errorWithCode('ENOSPC'));
      }
      return writeFile(path, data);
    };
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    const [failed, next] = await Promise.all([
      adapter.set('a', 'one', { signal }),
      adapter.set('a', 'two', { signal }),
    ]);
    expectFailure(failed, 'quota', 'a');
    assert.deepEqual(expectOk(next), { value: 'two', revision: '1' });
  });

  void it('reports the original error even when the temporary file cannot be removed', async () => {
    const fileSystem = fakeFileSystem();
    fileSystem.failures = {
      writeFile: errorWithCode('ENOSPC'),
      remove: errorWithCode('EIO'),
    };
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    expectFailure(await adapter.set('a', 'v', { signal }), 'quota', 'a');
  });

  void it('only ever writes under the directory it was given', async () => {
    const fileSystem = fakeFileSystem();
    const adapter = fileAdapter({ directory: '/data/store/', fileSystem });
    for (const key of ['../x', 'a/b', '..', '/etc/passwd']) {
      expectOk(await adapter.set(key, 'v', { signal }));
    }
    for (const path of fileSystem.files.keys()) {
      assert.match(path, /^\/data\/store\/[a-z0-9_~-]+\.json$/);
    }
    for (const call of fileSystem.calls) {
      assert.ok(call.split(' ')[1]?.startsWith('/data/store'), call);
    }
  });
});
