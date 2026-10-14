/// <reference types="node" />
/**
 * A `FileSystemLike` over `node:fs/promises`, which Node, Bun and Deno all provide.
 * This is the only file in `src/` that imports a file system module, so it ships as
 * its own entry point (`/file/node`) and the rest of the package stays runtime-neutral.
 */
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
  };
}
