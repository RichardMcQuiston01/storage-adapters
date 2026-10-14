/**
 * A `StorageAdapter` over one JSON file that holds every key. Like the other entry
 * points, it imports no file system module: you pass a `FileSystemLike`
 * (`nodeFileSystem()` from `/file/node` covers Node, Bun and Deno).
 */
import type { FileSystemLike } from '../file/file.js';
import type { StorageAdapter, StoredValue } from '../storage.js';
import {
  documentFileAdapter,
  type DocumentCodec,
  type EntryLayout,
} from './document-file.js';

export interface JsonFileAdapterOptions {
  /** The file to keep everything in. Its folder is created on first write. */
  readonly path: string;
  readonly fileSystem: FileSystemLike;
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
}

/** Each entry is `{ "r": revision, "v": value }`, a counter revision beside the value. */
const jsonLayout: EntryLayout = {
  read(raw: unknown): StoredValue | undefined {
    if (typeof raw !== 'object' || raw === null) {
      return undefined;
    }
    const entry = raw as { r?: unknown; v?: unknown };
    return typeof entry.r === 'string' && typeof entry.v === 'string'
      ? { value: entry.v, revision: entry.r }
      : undefined;
  },
  write(value: string, existing: StoredValue | null) {
    const revision: string = String((Number(existing?.revision) || 0) + 1);
    return { raw: { r: revision, v: value }, stored: { value, revision } };
  },
};

const jsonCodec: DocumentCodec = {
  parse: (text) => JSON.parse(text) as unknown,
  stringify: (document) => `${JSON.stringify(document, null, 2)}\n`,
};

/**
 * A `StorageAdapter` that keeps every key in one JSON file:
 * `{ "<key>": { "r": "1", "v": "..." } }`, keys in order, easy to read and edit.
 * The file is read once and kept in memory; each write re-reads it, changes one
 * entry and replaces the whole file through a temporary file and a rename, so a
 * reader never sees half of a write. Writes are queued, so `set` with `ifRevision`
 * reports `conflict` when another write got there first, as long as every writer is
 * in this process. A file that is not valid JSON is never overwritten: every call
 * returns `corrupt` until you fix it. Best for small amounts of data such as
 * settings; use the file adapter for many or large values, and the SQLite adapter
 * when more than one process writes. Nothing throws: every failure is a `StoreResult`.
 */
export function jsonFileAdapter(
  options: JsonFileAdapterOptions
): StorageAdapter {
  return documentFileAdapter({
    label: 'JSON file',
    path: options.path,
    fileSystem: options.fileSystem,
    codec: jsonCodec,
    layout: jsonLayout,
    cache: options.cache ?? true,
    watch: options.watch ?? true,
  });
}
