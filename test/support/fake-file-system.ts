import assert from 'node:assert/strict';

import type { FileSystemLike } from '../../src/file/index.js';

export function errorWithCode(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/** Polls until `check` is true, or fails after `milliseconds`. */
export async function waitFor(
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

export function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** An in-memory file system that can fail on demand and fire its watchers. */
export interface FakeFileSystem extends FileSystemLike {
  readonly files: Map<string, string>;
  readonly calls: string[];
  readonly watchers: Set<{ path: string; onChange: () => void }>;
  failures: Partial<
    Record<'readFile' | 'writeFile' | 'rename' | 'remove' | 'mkdir', Error>
  >;
  fire(path: string): void;
}

export function fakeFileSystem(withWatch = true): FakeFileSystem {
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
