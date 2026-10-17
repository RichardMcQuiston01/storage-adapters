/**
 * A `StorageAdapter` over one YAML file that holds every key. No YAML parser is
 * bundled: you pass in the one you use, for example the `yaml` package.
 */
import type { FileSystemLike } from '../file/file.js';
import type { FileLockOptions } from '../file/lock.js';
import { documentFileAdapter } from '../document-file/document-file.js';
import { plainLayout } from '../document-file/plain-layout.js';
import type { StorageAdapter } from '../storage.js';

/** The two functions of a YAML library this adapter uses; `yaml`'s default export fits. */
export interface YamlLike {
  /** Throws when the text is not valid YAML. Use a parser that does not run code. */
  parse(text: string): unknown;
  stringify(value: unknown): string;
}

export interface YamlFileAdapterOptions {
  /** The file to keep everything in. Its folder is created on first write. */
  readonly path: string;
  readonly fileSystem: FileSystemLike;
  /** Your YAML library, for example `import YAML from 'yaml'`. */
  readonly yaml: YamlLike;
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
 * A `StorageAdapter` that keeps every key in one YAML file, as `key: value` lines
 * that are easy to read and edit. The revision is worked out from the value, so an
 * edit made by hand counts as a new revision. A value is text: a quoted or plain
 * string, `true` or `false`, or a whole number. A decimal, a list, a nested block or
 * an empty value is `corrupt` for that key; write it as a quoted string. A key or
 * value that YAML would not read back as the same text is refused with `invalid`.
 * Otherwise it behaves like `jsonFileAdapter`: cached reads, queued writes that
 * replace the file atomically, a broken file is never overwritten, and outside edits
 * are noticed when the file system can watch. Comments and layout in the file are
 * not kept when the adapter writes it. Nothing throws: every failure is a `StoreResult`.
 */
export function yamlFileAdapter(
  options: YamlFileAdapterOptions
): StorageAdapter {
  const { yaml } = options;
  const codec = {
    parse: (text: string): unknown => yaml.parse(text),
    stringify: (document: Record<string, unknown>): string =>
      yaml.stringify(document),
  };
  return documentFileAdapter({
    label: 'YAML file',
    path: options.path,
    fileSystem: options.fileSystem,
    codec,
    layout: plainLayout(codec, 'YAML'),
    cache: options.cache ?? true,
    watch: options.watch ?? true,
    ...(options.lock === undefined ? {} : { lock: options.lock }),
  });
}
