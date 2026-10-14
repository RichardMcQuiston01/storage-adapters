import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { FileSystemLike } from '../src/file/index.js';
import { nodeFileSystem } from '../src/file/node.js';
import { jsonFileAdapter } from '../src/json-file/index.js';
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

async function withDirectory(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory: string = mkdtempSync(join(tmpdir(), 'json-file-adapter-'));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function errorWithCode(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/** Polls until `check` is true, or fails after `milliseconds`. */
async function waitFor(
  check: () => boolean,
  description: string,
  milliseconds = 3000
): Promise<void> {
  const deadline: number = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** An in-memory file system that can fail on demand and fire its watchers. */
interface FakeFileSystem extends FileSystemLike {
  readonly files: Map<string, string>;
  readonly calls: string[];
  readonly watchers: Set<{ path: string; onChange: () => void }>;
  failures: Partial<
    Record<'readFile' | 'writeFile' | 'rename' | 'remove' | 'mkdir', Error>
  >;
  fire(path: string): void;
}

function fakeFileSystem(withWatch = true): FakeFileSystem {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const watchers = new Set<{ path: string; onChange: () => void }>();
  const fake: FakeFileSystem = {
    files,
    calls,
    watchers,
    failures: {},
    fire: (path) => {
      for (const watcher of [...watchers]) {
        if (watcher.path === path) {
          watcher.onChange();
        }
      }
    },
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
  if (withWatch) {
    fake.watch = (path, onChange) => {
      calls.push(`watch ${path}`);
      const watcher = { path, onChange };
      watchers.add(watcher);
      return () => {
        calls.push(`unwatch ${path}`);
        watchers.delete(watcher);
      };
    };
  }
  return fake;
}

function realAdapter(
  path: string,
  extra: { cache?: boolean; watch?: boolean } = {}
): ReturnType<typeof jsonFileAdapter> {
  return jsonFileAdapter({ path, fileSystem: nodeFileSystem(), ...extra });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

void describe('jsonFileAdapter on a real file', () => {
  void it('returns null for a missing key and does not create the file', () =>
    withDirectory(async (directory) => {
      const path = join(directory, 'sub', 'settings.json');
      const adapter = realAdapter(path);
      assert.deepEqual(await adapter.get('a', { signal }), {
        ok: true,
        value: null,
      });
      assert.deepEqual(readdirSync(directory), []);
    }));

  void it('creates the folder and file on the first write, as readable sorted JSON', () =>
    withDirectory(async (directory) => {
      const path = join(directory, 'nested', 'deeper', 'settings.json');
      const adapter = realAdapter(path);
      expectOk(await adapter.set('zebra', 'last', { signal }));
      expectOk(await adapter.set('apple', 'first', { signal }));
      assert.equal(
        readFileSync(path, 'utf8'),
        '{\n' +
          '  "apple": {\n    "r": "1",\n    "v": "first"\n  },\n' +
          '  "zebra": {\n    "r": "1",\n    "v": "last"\n  }\n' +
          '}\n'
      );
    }));

  void it('stores a value with an incrementing revision', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(join(directory, 's.json'));
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
    }));

  void it('keeps data between adapters and between runs', () =>
    withDirectory(async (directory) => {
      const path = join(directory, 's.json');
      expectOk(await realAdapter(path).set('a', 'kept', { signal }));
      assert.deepEqual(expectOk(await realAdapter(path).get('a', { signal })), {
        value: 'kept',
        revision: '1',
      });
    }));

  void it('keeps every key when several are written at the same time', () =>
    withDirectory(async (directory) => {
      const path = join(directory, 's.json');
      const adapter = realAdapter(path);
      const keys = Array.from({ length: 30 }, (_, index) => `key-${index}`);
      const results = await Promise.all(
        keys.map((key) => adapter.set(key, `value of ${key}`, { signal }))
      );
      assert.ok(results.every((result) => result.ok));
      for (const key of keys) {
        assert.equal(
          expectOk(await adapter.get(key, { signal }))?.value,
          `value of ${key}`
        );
      }
      assert.equal(Object.keys(readJson(path) as object).length, 30);
    }));

  void it('keeps every key when two adapters on the same file write at the same time', () =>
    withDirectory(async (directory) => {
      const path = join(directory, 's.json');
      const first = realAdapter(path);
      const second = realAdapter(path);
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 === 0 ? first : second).set(`k${index}`, `v${index}`, {
            signal,
          })
        )
      );
      assert.equal(Object.keys(readJson(path) as object).length, 20);
    }));

  void it('round-trips unicode, quotes, newlines and large values unchanged', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(join(directory, 's.json'));
      const value = `{"name":"Zoë","note":"it's 日本語 😀 \\ ' \\" \n line two\t"}`;
      expectOk(await adapter.set('k', value, { signal }));
      assert.equal(expectOk(await adapter.get('k', { signal }))?.value, value);
      const large = 'x'.repeat(2 * 1024 * 1024);
      expectOk(await adapter.set('big', large, { signal }));
      assert.equal(
        expectOk(await adapter.get('big', { signal }))?.value.length,
        large.length
      );
    }));

  void it('accepts any string as a key, including ones that are special in JavaScript', () =>
    withDirectory(async (directory) => {
      const path = join(directory, 's.json');
      const adapter = realAdapter(path);
      const keys = [
        '',
        '__proto__',
        'constructor',
        'toString',
        'a.b/c',
        '日本',
        '\ud800',
        'hasOwnProperty',
      ];
      for (const key of keys) {
        expectOk(await adapter.set(key, `value of ${key}`, { signal }));
      }
      for (const key of keys) {
        assert.equal(
          expectOk(await adapter.get(key, { signal }))?.value,
          `value of ${key}`,
          `key ${JSON.stringify(key)}`
        );
      }
      // A fresh adapter reads them back from the file too.
      const fresh = realAdapter(path);
      for (const key of keys) {
        assert.equal(
          expectOk(await fresh.get(key, { signal }))?.value,
          `value of ${key}`
        );
      }
      assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    }));

  void it('reports a conflict for a stale ifRevision and keeps the value', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(join(directory, 's.json'));
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
      const adapter = realAdapter(join(directory, 's.json'));
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

  void it('queues racing writers, so exactly one with the same ifRevision wins', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(join(directory, 's.json'));
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

  void it('numbers parallel plain writes to one key 1 to N with none lost', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(join(directory, 's.json'));
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
    }));

  void it('removes a key and keeps the others; removing a missing key writes nothing', () =>
    withDirectory(async (directory) => {
      const path = join(directory, 's.json');
      const adapter = realAdapter(path);
      expectOk(await adapter.set('a', 'one', { signal }));
      expectOk(await adapter.set('b', 'two', { signal }));
      assert.deepEqual(await adapter.remove?.('a', { signal }), {
        ok: true,
        value: null,
      });
      assert.deepEqual(await adapter.get('a', { signal }), {
        ok: true,
        value: null,
      });
      assert.equal(expectOk(await adapter.get('b', { signal }))?.value, 'two');
      const before = readFileSync(path, 'utf8');
      assert.deepEqual(await adapter.remove?.('never', { signal }), {
        ok: true,
        value: null,
      });
      assert.equal(readFileSync(path, 'utf8'), before);
      await adapter.remove?.('b', { signal });
      assert.deepEqual(readJson(path), {});
      assert.equal(
        expectOk(await adapter.set('a', 'again', { signal })).revision,
        '1'
      );
    }));

  void it('removing from a file that does not exist succeeds and creates nothing', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(join(directory, 'none.json'));
      assert.deepEqual(await adapter.remove?.('a', { signal }), {
        ok: true,
        value: null,
      });
      assert.deepEqual(readdirSync(directory), []);
    }));

  void it('leaves no temporary files behind', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(join(directory, 's.json'));
      for (let index = 0; index < 20; index += 1) {
        expectOk(await adapter.set('a', `v${index}`, { signal }));
      }
      await adapter.remove?.('a', { signal });
      assert.deepEqual(readdirSync(directory), ['s.json']);
    }));

  void it('treats an empty or whitespace-only file as an empty document', () =>
    withDirectory(async (directory) => {
      const path = join(directory, 's.json');
      writeFileSync(path, '  \n');
      const adapter = realAdapter(path);
      assert.deepEqual(await adapter.get('a', { signal }), {
        ok: true,
        value: null,
      });
      assert.equal(
        expectOk(await adapter.set('a', 'v', { signal })).revision,
        '1'
      );
    }));
});

void describe('jsonFileAdapter and a file that is not a usable document', () => {
  for (const [name, content] of [
    ['invalid JSON', '{ "a": '],
    ['a JSON array', '[1, 2]'],
    ['JSON null', 'null'],
    ['a JSON number', '42'],
    ['a JSON string', '"text"'],
  ] as const) {
    void it(`reports ${name} as corrupt and never overwrites it`, () =>
      withDirectory(async (directory) => {
        const path = join(directory, 's.json');
        writeFileSync(path, content);
        const adapter = realAdapter(path);
        const read = await adapter.get('a', { signal });
        expectFailure(read, 'corrupt', 'a');
        assert.ok(!read.ok && read.error.includes(path));
        expectFailure(await adapter.set('a', 'v', { signal }), 'corrupt', 'a');
        expectFailure(
          (await adapter.remove?.('a', { signal })) as StoreResult<null>,
          'corrupt',
          'a'
        );
        assert.equal(readFileSync(path, 'utf8'), content);
        assert.deepEqual(readdirSync(directory), ['s.json']);
      }));
  }

  void it('works again as soon as the file is fixed, without a restart', () =>
    withDirectory(async (directory) => {
      const path = join(directory, 's.json');
      writeFileSync(path, '{ broken');
      const adapter = realAdapter(path);
      expectFailure(await adapter.get('a', { signal }), 'corrupt', 'a');
      writeFileSync(path, '{ "a": { "r": "3", "v": "fixed" } }');
      assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
        value: 'fixed',
        revision: '3',
      });
    }));

  void it('reports one invalid entry as corrupt, replaces only that entry, and keeps the rest', () =>
    withDirectory(async (directory) => {
      const path = join(directory, 's.json');
      writeFileSync(
        path,
        JSON.stringify({
          bad: 'just a string',
          half: { r: 1, v: 'number revision' },
          good: { r: '4', v: 'fine' },
          extra: { note: 'something a person added' },
        })
      );
      const adapter = realAdapter(path);
      expectFailure(await adapter.get('bad', { signal }), 'corrupt', 'bad');
      expectFailure(await adapter.get('half', { signal }), 'corrupt', 'half');
      assert.equal(
        expectOk(await adapter.get('good', { signal }))?.value,
        'fine'
      );
      assert.deepEqual(
        expectOk(await adapter.set('bad', 'fixed', { signal })),
        {
          value: 'fixed',
          revision: '1',
        }
      );
      const written = readJson(path) as Record<string, unknown>;
      assert.deepEqual(written['bad'], { r: '1', v: 'fixed' });
      assert.deepEqual(written['half'], { r: 1, v: 'number revision' });
      assert.deepEqual(written['good'], { r: '4', v: 'fine' });
      assert.deepEqual(written['extra'], { note: 'something a person added' });
    }));
});

void describe('jsonFileAdapter caching and outside edits', () => {
  void it('reads the file once and serves later gets from memory', async () => {
    const fileSystem = fakeFileSystem(false);
    fileSystem.files.set('/data/s.json', '{ "a": { "r": "1", "v": "x" } }');
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    for (let index = 0; index < 5; index += 1) {
      assert.equal(expectOk(await adapter.get('a', { signal }))?.value, 'x');
    }
    assert.equal(
      fileSystem.calls.filter((call) => call.startsWith('readFile')).length,
      1
    );
  });

  void it('reads the file on every get when cache is false, and sees outside edits', async () => {
    const fileSystem = fakeFileSystem(false);
    fileSystem.files.set('/data/s.json', '{ "a": { "r": "1", "v": "x" } }');
    const adapter = jsonFileAdapter({
      path: '/data/s.json',
      fileSystem,
      cache: false,
    });
    assert.equal(expectOk(await adapter.get('a', { signal }))?.value, 'x');
    fileSystem.files.set(
      '/data/s.json',
      '{ "a": { "r": "2", "v": "edited" } }'
    );
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
      value: 'edited',
      revision: '2',
    });
  });

  void it('shares one read between gets that start together', async () => {
    const fileSystem = fakeFileSystem(false);
    fileSystem.files.set('/data/s.json', '{ "a": { "r": "1", "v": "x" } }');
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    await Promise.all(
      Array.from({ length: 10 }, () => adapter.get('a', { signal }))
    );
    assert.equal(
      fileSystem.calls.filter((call) => call.startsWith('readFile')).length,
      1
    );
  });

  void it('starts every write from the file, so an outside edit to another key is kept', async () => {
    const fileSystem = fakeFileSystem(false);
    fileSystem.files.set('/data/s.json', '{ "a": { "r": "1", "v": "x" } }');
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    expectOk(await adapter.get('a', { signal })); // cached
    fileSystem.files.set(
      '/data/s.json',
      '{ "a": { "r": "1", "v": "x" }, "outside": { "r": "7", "v": "added by hand" } }'
    );
    expectOk(await adapter.set('b', 'new', { signal }));
    const written = JSON.parse(
      fileSystem.files.get('/data/s.json') ?? ''
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(written).sort(), ['a', 'b', 'outside']);
  });

  void it('checks ifRevision against the file, not a stale cache', async () => {
    const fileSystem = fakeFileSystem(false);
    fileSystem.files.set('/data/s.json', '{ "a": { "r": "1", "v": "x" } }');
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    assert.equal(expectOk(await adapter.get('a', { signal }))?.revision, '1');
    fileSystem.files.set(
      '/data/s.json',
      '{ "a": { "r": "5", "v": "edited elsewhere" } }'
    );
    expectFailure(
      await adapter.set('a', 'mine', { signal, ifRevision: '1' }),
      'conflict',
      'a'
    );
  });

  void it('is up to date after its own write, with no further read', async () => {
    const fileSystem = fakeFileSystem(false);
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    expectOk(await adapter.set('a', 'one', { signal }));
    const reads = fileSystem.calls.filter((call) =>
      call.startsWith('readFile')
    ).length;
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
      value: 'one',
      revision: '1',
    });
    assert.equal(
      fileSystem.calls.filter((call) => call.startsWith('readFile')).length,
      reads
    );
  });
});

void describe('jsonFileAdapter subscribe', () => {
  void it('tells subscribers about writes and removals made through the adapter', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(join(directory, 's.json'), { watch: false });
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

  void it('does not notify for a conflict, and a throwing subscriber cannot fail a write', () =>
    withDirectory(async (directory) => {
      const adapter = realAdapter(join(directory, 's.json'), { watch: false });
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

  void it('reports an outside edit when the file system can watch', async () => {
    const fileSystem = fakeFileSystem();
    fileSystem.files.set(
      '/data/s.json',
      '{ "a": { "r": "1", "v": "x" }, "b": { "r": "1", "v": "y" } }'
    );
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    const seen: (StoredValue | null)[] = [];
    adapter.subscribe?.('a', (stored) => seen.push(stored));
    await waitFor(() => fileSystem.watchers.size === 1, 'the watcher to start');

    // Another key changes: not reported to a subscriber of "a".
    fileSystem.files.set(
      '/data/s.json',
      '{ "a": { "r": "1", "v": "x" }, "b": { "r": "2", "v": "z" } }'
    );
    fileSystem.fire('/data/s.json');
    await pause(30);
    assert.equal(seen.length, 0);

    // The subscribed key changes by hand.
    fileSystem.files.set(
      '/data/s.json',
      '{ "a": { "r": "2", "v": "edited" }, "b": { "r": "2", "v": "z" } }'
    );
    fileSystem.fire('/data/s.json');
    await waitFor(() => seen.length === 1, 'the edit to be reported');
    assert.deepEqual(seen, [{ value: 'edited', revision: '2' }]);

    // The key is deleted by hand.
    fileSystem.files.set('/data/s.json', '{ "b": { "r": "2", "v": "z" } }');
    fileSystem.fire('/data/s.json');
    await waitFor(() => seen.length === 2, 'the removal to be reported');
    assert.equal(seen[1], null);
    // And the adapter now serves the new contents.
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('does not report the same change twice, or report its own writes again', async () => {
    const fileSystem = fakeFileSystem();
    fileSystem.files.set('/data/s.json', '{}');
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    const seen: (StoredValue | null)[] = [];
    adapter.subscribe?.('a', (stored) => seen.push(stored));
    await waitFor(() => fileSystem.watchers.size === 1, 'the watcher to start');

    expectOk(await adapter.set('a', 'mine', { signal }));
    fileSystem.fire('/data/s.json'); // the event our own write causes
    await pause(40);
    assert.equal(seen.length, 1);

    fileSystem.files.set(
      '/data/s.json',
      '{ "a": { "r": "9", "v": "theirs" } }'
    );
    fileSystem.fire('/data/s.json');
    fileSystem.fire('/data/s.json');
    fileSystem.fire('/data/s.json');
    await waitFor(() => seen.length === 2, 'the edit to be reported');
    await pause(40);
    assert.equal(seen.length, 2);
  });

  void it('ignores a half-saved file and reports the edit once it is valid', async () => {
    const fileSystem = fakeFileSystem();
    fileSystem.files.set('/data/s.json', '{ "a": { "r": "1", "v": "x" } }');
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    const seen: (StoredValue | null)[] = [];
    adapter.subscribe?.('a', (stored) => seen.push(stored));
    await waitFor(() => fileSystem.watchers.size === 1, 'the watcher to start');

    fileSystem.files.set('/data/s.json', '{ "a": { "r": "2", "v": "half');
    fileSystem.fire('/data/s.json');
    await pause(40);
    assert.equal(seen.length, 0);

    fileSystem.files.set(
      '/data/s.json',
      '{ "a": { "r": "2", "v": "finished" } }'
    );
    fileSystem.fire('/data/s.json');
    await waitFor(() => seen.length === 1, 'the finished edit to be reported');
    assert.deepEqual(seen, [{ value: 'finished', revision: '2' }]);
  });

  void it('also reports a change made by another adapter on the same file', async () => {
    const fileSystem = fakeFileSystem();
    fileSystem.files.set('/data/s.json', '{}');
    const watcher = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    const writer = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    const seen: (StoredValue | null)[] = [];
    watcher.subscribe?.('a', (stored) => seen.push(stored));
    await waitFor(() => fileSystem.watchers.size === 1, 'the watcher to start');
    expectOk(await writer.set('a', 'from the other adapter', { signal }));
    fileSystem.fire('/data/s.json');
    await waitFor(() => seen.length === 1, 'the change to be reported');
    assert.deepEqual(seen, [
      { value: 'from the other adapter', revision: '1' },
    ]);
  });

  void it('watches only while something is subscribed', async () => {
    const fileSystem = fakeFileSystem();
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    assert.equal(fileSystem.watchers.size, 0);
    const first = adapter.subscribe?.('a', () => {}) ?? (() => {});
    const second = adapter.subscribe?.('b', () => {}) ?? (() => {});
    await waitFor(() => fileSystem.watchers.size === 1, 'the watcher to start');
    first();
    assert.equal(fileSystem.watchers.size, 1);
    second();
    assert.equal(fileSystem.watchers.size, 0);
    assert.equal(
      fileSystem.calls.filter((call) => call.startsWith('watch')).length,
      1
    );
  });

  void it('does not leave a watcher running if everyone unsubscribed while it was starting', async () => {
    const fileSystem = fakeFileSystem();
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    const unsubscribe = adapter.subscribe?.('a', () => {}) ?? (() => {});
    unsubscribe();
    await pause(40);
    assert.equal(fileSystem.watchers.size, 0);
  });

  void it('does not watch when watch is false, or when the file system cannot', async () => {
    const off = fakeFileSystem();
    jsonFileAdapter({
      path: '/data/s.json',
      fileSystem: off,
      watch: false,
    }).subscribe?.('a', () => {});
    await pause(40);
    assert.equal(off.watchers.size, 0);

    const without = fakeFileSystem(false);
    const adapter = jsonFileAdapter({
      path: '/data/s.json',
      fileSystem: without,
    });
    const seen: unknown[] = [];
    adapter.subscribe?.('a', (stored) => seen.push(stored));
    expectOk(await adapter.set('a', 'v', { signal }));
    assert.equal(seen.length, 1); // in-process notification still works
  });

  void it('works without watching if starting the watcher fails', async () => {
    const fileSystem = fakeFileSystem();
    fileSystem.watch = () => {
      throw errorWithCode('ENOSPC', 'no more watchers');
    };
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    const seen: unknown[] = [];
    adapter.subscribe?.('a', (stored) => seen.push(stored));
    await pause(40);
    expectOk(await adapter.set('a', 'v', { signal }));
    assert.equal(seen.length, 1);
  });

  void it('sees real outside edits through fs.watch, including an editor-style replace', () =>
    withDirectory(async (directory) => {
      const path = join(directory, 's.json');
      const adapter = realAdapter(path);
      expectOk(await adapter.set('a', 'one', { signal }));
      const seen: (StoredValue | null)[] = [];
      const unsubscribe: () => void =
        adapter.subscribe?.('a', (stored) => seen.push(stored)) ?? (() => {});
      await pause(150); // let the real watcher start

      // 1. A plain in-place write by another program.
      writeFileSync(
        path,
        JSON.stringify({ a: { r: '2', v: 'edited in place' } })
      );
      await waitFor(() => seen.length >= 1, 'the in-place edit');
      assert.deepEqual(seen[0], { value: 'edited in place', revision: '2' });

      // 2. Write a temp file and rename it over, as most editors do.
      writeFileSync(
        join(directory, 's.json.swp'),
        JSON.stringify({ a: { r: '3', v: 'replaced by rename' } })
      );
      renameSync(join(directory, 's.json.swp'), path);
      await waitFor(() => seen.length >= 2, 'the replaced file');
      assert.deepEqual(seen.at(-1), {
        value: 'replaced by rename',
        revision: '3',
      });

      // 3. And it keeps working after our own atomic write replaced the file.
      expectOk(await adapter.set('other', 'x', { signal }));
      writeFileSync(
        path,
        JSON.stringify({
          a: { r: '4', v: 'after our write' },
          other: { r: '1', v: 'x' },
        })
      );
      await waitFor(
        () => seen.at(-1)?.value === 'after our write',
        'an edit after our own write'
      );
      unsubscribe();
    }));
});

void describe('jsonFileAdapter error handling', () => {
  void it('does not touch the file system when the request is already aborted', async () => {
    const fileSystem = fakeFileSystem();
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
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

  void it('maps a full disk to quota, removes the temporary file and keeps the old file', async () => {
    const fileSystem = fakeFileSystem();
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    expectOk(await adapter.set('a', 'one', { signal }));
    const before = fileSystem.files.get('/data/s.json');
    fileSystem.failures.writeFile = errorWithCode(
      'ENOSPC',
      'ENOSPC: no space left on device'
    );
    const result = await adapter.set('a', 'two', { signal });
    expectFailure(result, 'quota', 'a');
    assert.ok(!result.ok && result.error.includes('no space left'));
    assert.deepEqual([...fileSystem.files.keys()], ['/data/s.json']);
    assert.equal(fileSystem.files.get('/data/s.json'), before);
    fileSystem.failures = {};
    assert.equal(expectOk(await adapter.get('a', { signal }))?.value, 'one');
  });

  void it('does not keep a failed write in memory', async () => {
    const fileSystem = fakeFileSystem();
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    expectOk(await adapter.set('a', 'one', { signal }));
    fileSystem.failures.rename = errorWithCode('EACCES');
    expectFailure(await adapter.set('a', 'two', { signal }), 'forbidden', 'a');
    fileSystem.failures = {};
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
      value: 'one',
      revision: '1',
    });
    assert.equal(
      expectOk(await adapter.set('a', 'three', { signal })).revision,
      '2'
    );
  });

  void it('maps permission errors to forbidden, and anything else to unavailable', async () => {
    const fileSystem = fakeFileSystem();
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    expectOk(await adapter.set('a', 'one', { signal }));
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      fileSystem.failures = { rename: errorWithCode(code) };
      expectFailure(
        await adapter.set('a', 'two', { signal }),
        'forbidden',
        'a'
      );
    }
    fileSystem.failures = { readFile: errorWithCode('EIO', 'EIO: i/o error') };
    expectFailure(
      await adapter.set('a', 'two', { signal }),
      'unavailable',
      'a'
    );
    expectFailure(
      (await adapter.remove?.('a', { signal })) as StoreResult<null>,
      'unavailable',
      'a'
    );
    const fresh = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    expectFailure(await fresh.get('a', { signal }), 'unavailable', 'a');
    fileSystem.failures = { writeFile: new Error('plain error, no code') };
    fileSystem.failures.readFile = undefined as never;
    delete fileSystem.failures.readFile;
    expectFailure(
      await adapter.set('a', 'two', { signal }),
      'unavailable',
      'a'
    );
  });

  void it('does not remember a failed read, so the next get tries again', async () => {
    const fileSystem = fakeFileSystem();
    fileSystem.files.set('/data/s.json', '{ "a": { "r": "1", "v": "x" } }');
    fileSystem.failures.readFile = errorWithCode('EIO');
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    expectFailure(await adapter.get('a', { signal }), 'unavailable', 'a');
    fileSystem.failures = {};
    assert.equal(expectOk(await adapter.get('a', { signal }))?.value, 'x');
  });

  void it('does not remember a failed folder setup, so the next write tries again', async () => {
    const fileSystem = fakeFileSystem();
    fileSystem.failures.mkdir = errorWithCode('EROFS');
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    expectFailure(await adapter.set('a', 'v', { signal }), 'forbidden', 'a');
    fileSystem.failures = {};
    assert.equal(
      expectOk(await adapter.set('a', 'v', { signal })).revision,
      '1'
    );
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
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
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
    const adapter = jsonFileAdapter({ path: '/data/s.json', fileSystem });
    expectFailure(await adapter.set('a', 'v', { signal }), 'quota', 'a');
  });

  void it('works with a path that has no folder part, and with a Windows-style path', async () => {
    const plain = fakeFileSystem();
    expectOk(
      await jsonFileAdapter({ path: 'settings.json', fileSystem: plain }).set(
        'a',
        'v',
        { signal }
      )
    );
    assert.ok(plain.files.has('settings.json'));
    assert.ok(!plain.calls.some((call) => call.startsWith('mkdir')));

    const windows = fakeFileSystem();
    expectOk(
      await jsonFileAdapter({
        path: 'C:\\data\\app\\settings.json',
        fileSystem: windows,
      }).set('a', 'v', { signal })
    );
    assert.ok(windows.calls.includes('mkdir C:\\data\\app'));
  });
});
