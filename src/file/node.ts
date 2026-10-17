/// <reference types="node" />
/**
 * A `FileSystemLike` over `node:fs/promises`, which Node, Bun and Deno all provide.
 * This is the only file in `src/` that imports a file system module, so it ships as
 * its own entry point (`/file/node`) and the rest of the package stays runtime-neutral.
 */
import { watch } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';

import type { FileSystemLike } from './file.js';

const RENAME_RETRY_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EACCES',
  'EBUSY',
]);
const RENAME_ATTEMPTS = 10;
const RENAME_WAIT_MS = 10;

/**
 * Renames over `toPath`. On Windows a rename fails with EPERM, EACCES or EBUSY while
 * another process has the target open (a reader, a virus scanner), so those are
 * retried for a short while before the last error is thrown.
 */
async function renameWithRetry(
  fromPath: string,
  toPath: string
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(fromPath, toPath);
      return;
    } catch (error: unknown) {
      const code: unknown = (error as { code?: unknown }).code;
      if (
        attempt >= RENAME_ATTEMPTS ||
        typeof code !== 'string' ||
        !RENAME_RETRY_CODES.has(code)
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, RENAME_WAIT_MS * attempt);
      });
    }
  }
}

export function nodeFileSystem(): FileSystemLike {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, data) => writeFile(path, data, 'utf8'),
    // 'wx' is O_CREAT | O_EXCL: it fails if anything is there, a symbolic link included.
    writeNewFile: (path, data) =>
      writeFile(path, data, { encoding: 'utf8', flag: 'wx' }),
    rename: renameWithRetry,
    remove: (path) => rm(path, { force: true }),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    listFiles: async (directory) => {
      try {
        return await readdir(directory);
      } catch (error: unknown) {
        if ((error as { code?: unknown }).code === 'ENOENT') {
          return []; // Nothing has been written yet.
        }
        throw error;
      }
    },
    watchDirectory: (directory, onChange) => {
      const watcher = watch(directory, (_event, filename) => {
        onChange(filename === null ? null : String(filename));
      });
      watcher.on('error', () => {});
      watcher.unref(); // A watcher alone should not keep the program running.
      return () => {
        watcher.close();
      };
    },
    watch: (path, onChange) => {
      // Watch the folder, not the file: a file replaced by a rename (ours, or an
      // editor's) is a new file, and a watcher on the old one would go quiet.
      const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      const directory =
        slash === -1 ? '.' : slash === 0 ? '/' : path.slice(0, slash);
      const name = path.slice(slash + 1);
      const watcher = watch(directory, (_event, filename) => {
        if (filename === null || filename === name) {
          onChange();
        }
      });
      watcher.on('error', () => {});
      watcher.unref(); // A watcher alone should not keep the program running.
      return () => {
        watcher.close();
      };
    },
  };
}
