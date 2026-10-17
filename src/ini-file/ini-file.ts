/**
 * A `StorageAdapter` over one INI file that holds every key. No INI parser is
 * bundled: you pass in the one you use, for example the `ini` package.
 */
import type { FileSystemLike } from '../file/file.js';
import type { FileLockOptions } from '../file/lock.js';
import { documentFileAdapter } from '../document-file/document-file.js';
import { plainLayout } from '../document-file/plain-layout.js';
import type { StorageAdapter } from '../storage.js';

/** The two functions of an INI library this adapter uses; the `ini` package fits. */
export interface IniLike {
  /** Throws when the text cannot be parsed. */
  parse(text: string): unknown;
  stringify(value: object): string;
}

export interface IniFileAdapterOptions {
  /** The file to keep everything in. Its folder is created on first write. */
  readonly path: string;
  readonly fileSystem: FileSystemLike;
  /** Your INI library, for example `import * as ini from 'ini'`. */
  readonly ini: IniLike;
  /**
   * Serve `get` from memory after the first read. Default `true`. Set `false` to
   * read the file on every `get`, so an edit made outside is seen at once.
   */
  readonly cache?: boolean;
  /**
   * Watch the file while something is subscribed, so an edit made outside is
   * noticed and reported. Default `true`. Needs a `FileSystemLike` with `watch`.
   */
  readonly watch?: boolean;
  /**
   * Take a lock file around each write, so several processes can share the file.
   * Needs a `FileSystemLike` with `writeNewFile`. Off by default.
   */
  readonly lock?: FileLockOptions;
}

/**
 * A `StorageAdapter` that keeps every key in one INI file, as `key = value` lines
 * that are easy to read and edit. Only the top of the file is used: lines under a
 * `[section]` are left alone and are not keys. The revision is worked out from the
 * value, so an edit made by hand counts as a new revision. A value is text; `true`
 * and `false` are read as that text. A list, a section or a `null` is `corrupt` for
 * that key. A key or value that INI would not read back as
 * the same text, such as the key `a=b` or the value `null`, is refused with
 * `invalid`. Otherwise it behaves like `jsonFileAdapter`: cached reads, queued
 * writes that replace the file atomically, a broken file is never overwritten, and
 * outside edits are noticed when the file system can watch. Comments and layout in
 * the file are not kept when the adapter writes it. Nothing throws: every failure
 * is a `StoreResult`.
 */
export function iniFileAdapter(options: IniFileAdapterOptions): StorageAdapter {
  const { ini } = options;
  const codec = {
    parse: (text: string): unknown => ini.parse(text),
    stringify: (document: Record<string, unknown>): string =>
      ini.stringify(document),
  };
  return documentFileAdapter({
    label: 'INI file',
    path: options.path,
    fileSystem: options.fileSystem,
    codec,
    layout: plainLayout(codec, 'INI'),
    cache: options.cache ?? true,
    watch: options.watch ?? true,
    ...(options.lock === undefined ? {} : { lock: options.lock }),
  });
}
