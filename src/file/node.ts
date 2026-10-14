/// <reference types="node" />
/**
 * A `FileSystemLike` over `node:fs/promises`, which Node, Bun and Deno all provide.
 * This is the only file in `src/` that imports a file system module, so it ships as
 * its own entry point (`/file/node`) and the rest of the package stays runtime-neutral.
 */
import { watch } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

import type { FileSystemLike } from './file.js';

export function nodeFileSystem(): FileSystemLike {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, data) => writeFile(path, data, 'utf8'),
    rename: (fromPath, toPath) => rename(fromPath, toPath),
    remove: (path) => rm(path, { force: true }),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
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
