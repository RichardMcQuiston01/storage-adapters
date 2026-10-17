/** Cross-process locking for the file adapters. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { fileAdapter } from '../src/file/file.js';
import { withFileLock, type FileLockOptions } from '../src/file/lock.js';
import { nodeFileSystem } from '../src/file/node.js';
import { jsonFileAdapter } from '../src/json-file/index.js';
import type { StoreResult } from '../src/storage.js';
import {
  errorWithCode,
  fakeFileSystem,
  withExclusiveCreate,
  type FakeFileSystem,
} from './support/fake-file-system.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T> | undefined): T {
  if (result === undefined || !result.ok) {
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

/** A lock whose waits only count, and can run something while "waiting". */
function lockWith(
  onSleep: (ms: number) => void | Promise<void> = () => undefined,
  extra: Partial<FileLockOptions> = {}
): FileLockOptions & { readonly waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
      await onSleep(ms);
    },
    ...extra,
  };
}

function lockFiles(fake: FakeFileSystem): string[] {
  return [...fake.files.keys()].filter((path) => path.endsWith('.lock'));
}

void describe('withFileLock', () => {
  const LOCK = '/d/x.lock';

  void it('takes the lock for the task and removes it afterwards', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    let during: string[] = [];
    const result = await withFileLock(fake, LOCK, lockWith(), signal, () => {
      during = lockFiles(fake);
      return Promise.resolve('done');
    });
    assert.equal(result, 'done');
    assert.deepEqual(during, [LOCK]);
    assert.deepEqual(lockFiles(fake), []);
  });

  void it('releases the lock when the task throws, and passes the error on', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    await assert.rejects(
      () =>
        withFileLock(fake, LOCK, lockWith(), signal, () =>
          Promise.reject(new Error('task failed'))
        ),
      /task failed/
    );
    assert.deepEqual(lockFiles(fake), []);
  });

  void it('waits for a lock another process holds, then takes it', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.files.set(LOCK, JSON.stringify({ token: 'other', at: Date.now() }));
    const lock = lockWith(() => {
      if (lock.waits.length === 3) fake.files.delete(LOCK); // The other process finishes.
    });
    await withFileLock(fake, LOCK, lock, signal, () => Promise.resolve());
    assert.equal(lock.waits.length, 3);
    assert.deepEqual(
      lock.waits,
      [25, 50, 100],
      'waits grow, up to four times the first'
    );
  });

  void it('gives up after the timeout and says which file to delete', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.files.set(LOCK, JSON.stringify({ token: 'other', at: Date.now() }));
    const lock = lockWith(
      () => new Promise((resolve) => setTimeout(resolve, 8)),
      {
        timeoutMs: 30,
      }
    );
    await assert.rejects(
      () => withFileLock(fake, LOCK, lock, signal, () => Promise.resolve()),
      (error: unknown) =>
        (error as { code?: string }).code === 'ELOCKED' &&
        /another process holds.*delete that file/.test(
          (error as Error).message
        ) &&
        (error as Error).message.includes(LOCK)
    );
    assert.ok(fake.files.has(LOCK), 'a lock that is not ours is left alone');
  });

  void it('breaks a lock older than staleMs, but not a fresh one', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.files.set(
      LOCK,
      JSON.stringify({ token: 'dead', at: Date.now() - 60_000 })
    );
    const lock = lockWith();
    await withFileLock(fake, LOCK, lock, signal, () => Promise.resolve());
    assert.equal(lock.waits.length, 0, 'no waiting for a stale lock');
    fake.files.set(
      LOCK,
      JSON.stringify({ token: 'busy', at: Date.now() - 5_000 })
    );
    await assert.rejects(
      () =>
        withFileLock(
          fake,
          LOCK,
          lockWith(() => undefined, { timeoutMs: 0 }),
          signal,
          () => Promise.resolve()
        ),
      /ELOCKED|timed out/
    );
  });

  void it('breaks a lock file that stays unreadable for staleMs', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.files.set(LOCK, ''); // Its owner died between creating and writing it.
    const lock = lockWith(
      () => new Promise((resolve) => setTimeout(resolve, 6)),
      {
        staleMs: 20,
        timeoutMs: 2000,
      }
    );
    await withFileLock(fake, LOCK, lock, signal, () => Promise.resolve());
    assert.ok(
      lock.waits.length >= 1,
      'it waited first, in case the owner was still writing'
    );
    assert.deepEqual(lockFiles(fake), []);
  });

  void it('does not break a lock that was replaced after it was judged stale', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    const stale = JSON.stringify({ token: 'dead', at: Date.now() - 60_000 });
    fake.files.set(LOCK, stale);
    const fresh = JSON.stringify({ token: 'new', at: Date.now() });
    const realRead = fake.readFile.bind(fake);
    let reads = 0;
    fake.readFile = async (path) => {
      reads += 1;
      const text = await realRead(path);
      if (path === LOCK && reads === 1) {
        fake.files.set(LOCK, fresh); // Another process broke it and took it, just now.
      }
      return text;
    };
    const lock = lockWith(() => {
      fake.files.delete(LOCK);
    });
    await withFileLock(fake, LOCK, lock, signal, () => Promise.resolve());
    assert.ok(
      lock.waits.length >= 1,
      'the fresh lock was waited for, not removed'
    );
  });

  void it('does not remove a lock someone else holds when it finishes', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    await withFileLock(fake, LOCK, lockWith(), signal, () => {
      // Our lock was broken as stale and another process holds it now.
      fake.files.set(
        LOCK,
        JSON.stringify({ token: 'someone-else', at: Date.now() })
      );
      return Promise.resolve();
    });
    assert.ok(fake.files.has(LOCK));
  });

  void it('stops waiting when aborted', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.files.set(LOCK, JSON.stringify({ token: 'other', at: Date.now() }));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        withFileLock(fake, LOCK, lockWith(), controller.signal, () =>
          Promise.resolve()
        ),
      (error: unknown) => (error as { code?: string }).code === 'ECANCELED'
    );
  });

  void it('needs a file system that can create exclusively', async () => {
    await assert.rejects(
      () =>
        withFileLock(fakeFileSystem(false), LOCK, lockWith(), signal, () =>
          Promise.resolve()
        ),
      (error: unknown) =>
        (error as { code?: string }).code === 'ENOTSUP' &&
        /writeNewFile/.test((error as Error).message)
    );
  });

  void it('waits out EPERM and EACCES from creating the lock, which Windows gives while a deleted lock file is still open', async () => {
    for (const code of ['EPERM', 'EACCES']) {
      const fake = withExclusiveCreate(fakeFileSystem(false));
      const create = fake.writeNewFile?.bind(fake);
      let denied = 0;
      fake.writeNewFile = (path, data) => {
        if (denied < 3) {
          denied += 1;
          return Promise.reject(errorWithCode(code));
        }
        return create?.(path, data) ?? Promise.resolve();
      };
      const lock = lockWith();
      await withFileLock(fake, LOCK, lock, signal, () => Promise.resolve());
      assert.equal(lock.waits.length, 3, code);
    }
  });

  void it('passes the error on when the lock keeps being denied for the whole timeout, as a folder that cannot be written does', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.failures.writeFile = errorWithCode('EACCES');
    const lock = lockWith(
      () => new Promise((resolve) => setTimeout(resolve, 5)),
      {
        timeoutMs: 40,
      }
    );
    await assert.rejects(
      () => withFileLock(fake, LOCK, lock, signal, () => Promise.resolve()),
      (error: unknown) => (error as { code?: string }).code === 'EACCES'
    );
    assert.ok(lock.waits.length >= 2, 'it waited before giving up');
  });

  void it('waits out EPERM when reading a lock file that is being deleted', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.files.set(LOCK, JSON.stringify({ token: 'other', at: Date.now() }));
    const realRead = fake.readFile.bind(fake);
    let denied = 0;
    fake.readFile = (path) => {
      if (path === LOCK && denied < 3) {
        denied += 1;
        return Promise.reject(errorWithCode('EPERM'));
      }
      return realRead(path);
    };
    const lock = lockWith(() => {
      if (denied === 3) fake.files.delete(LOCK); // The other process is done.
    });
    await withFileLock(fake, LOCK, lock, signal, () => Promise.resolve());
    assert.ok(lock.waits.length >= 3);
    assert.deepEqual(lockFiles(fake), []);
  });

  void it('passes the error on when reading the lock keeps being denied for the whole timeout', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.files.set(LOCK, JSON.stringify({ token: 'other', at: Date.now() }));
    fake.failures.readFile = errorWithCode('EACCES');
    const lock = lockWith(
      () => new Promise((resolve) => setTimeout(resolve, 5)),
      { timeoutMs: 40 }
    );
    await assert.rejects(
      () => withFileLock(fake, LOCK, lock, signal, () => Promise.resolve()),
      (error: unknown) => (error as { code?: string }).code === 'EACCES'
    );
  });

  void it('does not fail when breaking a stale lock is denied because someone else is deleting it', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.files.set(
      LOCK,
      JSON.stringify({ token: 'dead', at: Date.now() - 60_000 })
    );
    const realRemove = fake.remove.bind(fake);
    let denied = 0;
    fake.remove = (path) => {
      if (path === LOCK && denied < 2) {
        denied += 1;
        return Promise.reject(errorWithCode('EPERM'));
      }
      return realRemove(path);
    };
    await withFileLock(fake, LOCK, lockWith(), signal, () => Promise.resolve());
    assert.equal(denied, 2);
    assert.deepEqual(lockFiles(fake), []);
  });

  void it('passes on any other error from creating the lock at once', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.failures.writeFile = errorWithCode('ENOSPC');
    const lock = lockWith();
    await assert.rejects(
      () => withFileLock(fake, LOCK, lock, signal, () => Promise.resolve()),
      (error: unknown) => (error as { code?: string }).code === 'ENOSPC'
    );
    assert.equal(lock.waits.length, 0);
  });
});

void describe('fileAdapter with a lock', () => {
  void it('writes and removes while holding a per-key lock, and leaves none behind', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    const seen: string[][] = [];
    const realRename = fake.rename.bind(fake);
    fake.rename = (from, to) => {
      seen.push(lockFiles(fake));
      return realRename(from, to);
    };
    const adapter = fileAdapter({
      directory: '/d',
      fileSystem: fake,
      lock: lockWith(),
    });
    expectOk(await adapter.set('Key', 'v', { signal }));
    assert.deepEqual(seen, [['/d/_key.json.lock']]);
    expectOk(await adapter.remove?.('Key', { signal }));
    assert.deepEqual(lockFiles(fake), []);
  });

  void it('does not list lock files as keys', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.files.set('/d/stray.json.lock', '{}');
    const adapter = fileAdapter({
      directory: '/d',
      fileSystem: fake,
      lock: lockWith(),
    });
    expectOk(await adapter.set('a', 'v', { signal }));
    assert.deepEqual(expectOk(await adapter.list?.('', { signal })), ['a']);
  });

  void it('reports a lock it cannot get as unavailable, naming the key, and writes nothing', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.files.set(
      '/d/a.json.lock',
      JSON.stringify({ token: 'other', at: Date.now() })
    );
    const adapter = fileAdapter({
      directory: '/d',
      fileSystem: fake,
      lock: lockWith(undefined, { timeoutMs: 0 }),
    });
    const message = expectFailure(
      await adapter.set('a', 'v', { signal }),
      'unavailable'
    );
    assert.match(message, /^File storage could not be written \(timed out/);
    assert.match(message, /for key "a"$/);
    assert.equal(fake.files.has('/d/a.json'), false);
    const removal = expectFailure(
      (await adapter.remove?.('a', { signal })) as StoreResult<null>,
      'unavailable'
    );
    assert.match(removal, /could not be removed/);
  });

  void it('reports a file system that cannot lock as unavailable, saying what is missing', async () => {
    const adapter = fileAdapter({
      directory: '/d',
      fileSystem: fakeFileSystem(false),
      lock: lockWith(),
    });
    assert.match(
      expectFailure(await adapter.set('a', 'v', { signal }), 'unavailable'),
      /writeNewFile/
    );
  });

  void it('behaves as before without a lock', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    const adapter = fileAdapter({ directory: '/d', fileSystem: fake });
    expectOk(await adapter.set('a', 'v', { signal }));
    assert.ok(!fake.calls.some((call) => call.includes('.lock')));
  });
});

void describe('document file adapters with a lock', () => {
  void it('lock the file around a write and a removal, and leave none behind', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    const seen: string[][] = [];
    const realRename = fake.rename.bind(fake);
    fake.rename = (from, to) => {
      seen.push(lockFiles(fake));
      return realRename(from, to);
    };
    const adapter = jsonFileAdapter({
      path: '/d/s.json',
      fileSystem: fake,
      lock: lockWith(),
      watch: false,
    });
    expectOk(await adapter.set('a', 'v', { signal }));
    expectOk(await adapter.remove?.('a', { signal }));
    assert.deepEqual(seen, [['/d/s.json.lock'], ['/d/s.json.lock']]);
    assert.deepEqual(lockFiles(fake), []);
  });

  void it('report a lock they cannot get without touching the file', async () => {
    const fake = withExclusiveCreate(fakeFileSystem(false));
    fake.files.set('/d/s.json', '{}');
    fake.files.set(
      '/d/s.json.lock',
      JSON.stringify({ token: 'other', at: Date.now() })
    );
    const adapter = jsonFileAdapter({
      path: '/d/s.json',
      fileSystem: fake,
      lock: lockWith(undefined, { timeoutMs: 0 }),
      watch: false,
    });
    const message = expectFailure(
      await adapter.set('a', 'v', { signal }),
      'unavailable'
    );
    assert.match(message, /^JSON file could not be written \(timed out/);
    assert.equal(fake.files.get('/d/s.json'), '{}');
  });
});

/** Runs the worker script in its own process; resolves what it printed. */
function runWorker(
  kind: string,
  path: string,
  count: number
): Promise<{ done: number; conflicts: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, 'support', 'lock-worker.ts'),
        kind,
        path,
        String(count),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`worker exited with ${code}: ${err}`));
        return;
      }
      resolve(JSON.parse(out) as { done: number; conflicts: number });
    });
  });
}

// Real processes need a runtime that runs TypeScript itself; Node and Deno here do not.
const canSpawnWorkers: boolean =
  typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

void describe('several real processes sharing one place', () => {
  for (const kind of ['file', 'json'] as const) {
    void it(
      `lose no update through the ${kind} adapter when they lock`,
      { skip: !canSpawnWorkers, timeout: 120_000 },
      async () => {
        const folder = mkdtempSync(join(tmpdir(), `lock-${kind}-`));
        try {
          const workers = 4;
          const each = 25;
          // Start from a stored value: with nothing stored there is no revision to
          // check, so each worker's first write would be a plain overwrite.
          const seed =
            kind === 'json'
              ? jsonFileAdapter({
                  path: join(folder, 'settings.json'),
                  fileSystem: nodeFileSystem(),
                  watch: false,
                })
              : fileAdapter({
                  directory: folder,
                  fileSystem: nodeFileSystem(),
                });
          expectOk(await seed.set('counter', '0', { signal }));
          const results = await Promise.all(
            Array.from({ length: workers }, () => runWorker(kind, folder, each))
          );
          assert.ok(results.every((result) => result.done === each));
          const adapter =
            kind === 'json'
              ? jsonFileAdapter({
                  path: join(folder, 'settings.json'),
                  fileSystem: nodeFileSystem(),
                  watch: false,
                  cache: false,
                })
              : fileAdapter({
                  directory: folder,
                  fileSystem: nodeFileSystem(),
                });
          const final = expectOk(await adapter.get('counter', { signal }));
          assert.equal(final?.value, String(workers * each));
          assert.equal(final?.revision, String(workers * each + 1)); // plus the seed
          assert.deepEqual(
            readdirSync(folder).filter(
              (name) => name.endsWith('.lock') || name.endsWith('.tmp')
            ),
            [],
            'no lock or temporary file is left behind'
          );
          assert.equal(
            JSON.parse(
              readFileSync(
                join(
                  folder,
                  kind === 'json' ? 'settings.json' : 'counter.json'
                ),
                'utf8'
              )
            ) !== null,
            true
          );
        } finally {
          rmSync(folder, { recursive: true, force: true });
        }
      }
    );
  }
});
