/**
 * The engine behind the single-document file adapters: one file holds every key.
 * It does the reading, caching, queued read-modify-write and atomic replace, and
 * leaves two things to its callers: the text format (`codec`, for JSON, YAML or INI)
 * and how one entry looks inside the document (`layout`).
 */
import { describeUnknownError } from '../errors.js';
import { lockedTask, type FileLockOptions } from '../file/lock.js';
import type { FileSystemLike } from '../file/file.js';
import {
  classifyFileError,
  errorCodeOf,
  failedWithFor,
  failureFor,
  withLock,
  writeTemporaryFile,
} from '../file/shared.js';
import {
  compareKeys,
  prefixFailure,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** Turns the file's text into a plain object and back. */
export interface DocumentCodec {
  /** Throws when the text is not valid in this format. */
  parse(text: string): unknown;
  stringify(document: Record<string, unknown>): string;
}

/** How one key's entry is written inside the document. */
export interface EntryLayout {
  /**
   * Optional. Says why this key and value cannot be stored in this format, or
   * `undefined` if they can. Called before anything is written, so a value the
   * format would change is refused instead of stored wrongly.
   */
  check?(key: string, value: string): string | undefined;
  /** Reads an entry. `undefined` means what is there is not a valid entry. */
  read(raw: unknown): StoredValue | undefined;
  /** Makes the entry for a new value, given what is stored now (`null` for nothing). */
  write(
    value: string,
    existing: StoredValue | null
  ): { readonly raw: unknown; readonly stored: StoredValue };
}

export interface DocumentFileOptions {
  /** Starts every error message, for example `"JSON file"`. */
  readonly label: string;
  readonly path: string;
  readonly fileSystem: FileSystemLike;
  readonly codec: DocumentCodec;
  readonly layout: EntryLayout;
  /** Serve `get` from memory once the file has been read. */
  readonly cache: boolean;
  /** Re-read the file when it changes, if the file system can watch. */
  readonly watch: boolean;
  /** Take a lock file around each write, so several processes can share the file. */
  readonly lock?: FileLockOptions;
}

/** A file read: its entries, or why it is not a usable document. */
type DocumentRead =
  | { readonly kind: 'ok'; readonly entries: Map<string, unknown> }
  | { readonly kind: 'corrupt'; readonly detail: string };

/** The folder part of a path, or `''` when there is none. */
function parentOf(path: string): string {
  const slash: number = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (slash === -1) {
    return '';
  }
  return slash === 0 ? path.slice(0, 1) : path.slice(0, slash);
}

function sameStored(
  left: StoredValue | null,
  right: StoredValue | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.value === right.value &&
      left.revision === right.revision)
  );
}

export function documentFileAdapter(
  options: DocumentFileOptions
): StorageAdapter {
  const { label, path, fileSystem, codec, layout } = options;
  const lockName = `document\u0000${path}`;
  const listeners = new Map<
    string,
    Set<(stored: StoredValue | null) => void>
  >();

  /** The entries as last read or written. Always kept, used by `get` when caching. */
  let snapshot: Map<string, unknown> | null = null;
  let directoryReady = false;
  let reloadQueued = false;
  let stopWatching: (() => void) | null = null;
  let watchState: 'off' | 'starting' | 'on' = 'off';

  const failure = <T>(
    code: StoreErrorCode,
    key: string,
    detail: string
  ): StoreResult<T> => failureFor(label, code, key, detail);

  const stopped = <T>(
    key: string,
    signal: AbortSignal
  ): StoreResult<T> | null =>
    signal.aborted ? failure('unavailable', key, 'request was aborted') : null;

  const corruptDocument = <T>(key: string, detail: string): StoreResult<T> =>
    failure(
      'corrupt',
      key,
      `cannot be used: ${path} ${detail}. Fix or delete the file; it was left as it is`
    );

  /** Reads and parses the file. A missing file is an empty document. */
  const readDocument = async (): Promise<DocumentRead> => {
    let text: string;
    try {
      text = await fileSystem.readFile(path);
    } catch (error: unknown) {
      if (errorCodeOf(error) === 'ENOENT') {
        return { kind: 'ok', entries: new Map() };
      }
      throw error;
    }
    if (text.trim() === '') {
      return { kind: 'ok', entries: new Map() };
    }
    let parsed: unknown;
    try {
      parsed = codec.parse(text);
    } catch {
      return { kind: 'corrupt', detail: 'could not be parsed' };
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { kind: 'corrupt', detail: 'is not an object of entries' };
    }
    return { kind: 'ok', entries: new Map(Object.entries(parsed)) };
  };

  const ensureDirectory = async (): Promise<void> => {
    const directory: string = parentOf(path);
    if (!directoryReady && directory !== '') {
      await fileSystem.mkdir(directory);
    }
    directoryReady = true;
  };

  /** Replaces the file with the entries in one step, keys in a steady order. */
  const writeDocument = async (
    entries: Map<string, unknown>
  ): Promise<void> => {
    const sorted: [string, unknown][] = [...entries].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    const text: string = codec.stringify(Object.fromEntries(sorted));
    // Only a temporary file this call created is ever removed.
    const temporaryPath: string = await writeTemporaryFile(
      fileSystem,
      path,
      text
    );
    try {
      await fileSystem.rename(temporaryPath, path);
    } catch (error: unknown) {
      try {
        await fileSystem.remove(temporaryPath);
      } catch {
        // The leftover temporary file is harmless; the write already failed.
      }
      throw error;
    }
  };

  /** What `get` reads from: the cache when it has one, otherwise the file. */
  const load = async (): Promise<DocumentRead> => {
    if (options.cache && snapshot !== null) {
      return { kind: 'ok', entries: snapshot };
    }
    // Reads go through the queue so a slow one cannot overwrite a newer write.
    return withLock(lockName, async (): Promise<DocumentRead> => {
      if (options.cache && snapshot !== null) {
        return { kind: 'ok', entries: snapshot };
      }
      const read: DocumentRead = await readDocument();
      if (read.kind === 'ok') {
        adopt(read.entries);
      }
      return read;
    });
  };

  const storedOf = (
    entries: Map<string, unknown>,
    key: string
  ): StoredValue | null | undefined =>
    entries.has(key) ? layout.read(entries.get(key)) : null;

  const notify = (key: string, stored: StoredValue | null): void => {
    for (const listener of listeners.get(key) ?? []) {
      try {
        listener(stored);
      } catch {
        // A faulty listener must not turn a successful write into a failure.
      }
    }
  };

  /**
   * Takes entries just read from the file as the current picture of it, and tells
   * subscribers about any key that is different from the picture before. A copy is
   * kept, so a write that later fails cannot leak into what is remembered.
   */
  const adopt = (entries: Map<string, unknown>): void => {
    const before: Map<string, unknown> | null = snapshot;
    snapshot = new Map(entries);
    if (before === null) {
      return;
    }
    for (const key of listeners.keys()) {
      const previous = storedOf(before, key);
      const current = storedOf(entries, key);
      if (current !== undefined && !sameStored(previous ?? null, current)) {
        notify(key, current);
      }
    }
  };

  /** Re-reads the file after an outside change and tells subscribers what moved. */
  const reload = (): void => {
    if (reloadQueued) {
      return;
    }
    reloadQueued = true;
    void withLock(lockName, async (): Promise<void> => {
      reloadQueued = false;
      if (listeners.size === 0) {
        return;
      }
      let read: DocumentRead;
      try {
        read = await readDocument();
      } catch {
        return; // Try again on the next change.
      }
      if (read.kind !== 'ok') {
        return; // Probably half-saved by an editor; wait for the next change.
      }
      adopt(read.entries);
    });
  };

  const startWatching = (): void => {
    if (
      !options.watch ||
      fileSystem.watch === undefined ||
      watchState !== 'off'
    ) {
      return;
    }
    watchState = 'starting';
    void (async (): Promise<void> => {
      try {
        await ensureDirectory();
        // Have a baseline to compare against before the first change arrives.
        await load();
        if (watchState !== 'starting') {
          return; // Everyone unsubscribed while this was starting.
        }
        stopWatching = fileSystem.watch?.(path, reload) ?? null;
        watchState = 'on';
      } catch {
        watchState = 'off'; // Watching is a bonus; the adapter works without it.
      }
    })();
  };

  const stopWatchingNow = (): void => {
    watchState = 'off';
    const stop: (() => void) | null = stopWatching;
    stopWatching = null;
    try {
      stop?.();
    } catch {
      // Nothing useful to do if closing the watcher fails.
    }
  };

  return {
    async get(key, { signal }) {
      const abortedResult = stopped<StoredValue | null>(key, signal);
      if (abortedResult !== null) {
        return abortedResult;
      }
      try {
        // Uncached reads go through the same queue: one that finished after a write
        // must not put the document back as it was before that write.
        const read: DocumentRead = await load();
        if (read.kind === 'corrupt') {
          return corruptDocument(key, read.detail);
        }
        const stored = storedOf(read.entries, key);
        if (stored === undefined) {
          return failure('corrupt', key, 'holds an entry that is not valid');
        }
        return { ok: true, value: stored };
      } catch (error: unknown) {
        return failedWithFor(label, error, key, 'read');
      }
    },

    async set(key, value, { signal, ifRevision }) {
      const abortedResult = stopped<StoredValue>(key, signal);
      if (abortedResult !== null) {
        return abortedResult;
      }
      const problem: string | undefined = layout.check?.(key, value);
      if (problem !== undefined) {
        return failure('invalid', key, problem);
      }
      const result: StoreResult<StoredValue> = await withLock(
        lockName,
        lockedTask<StoredValue>(
          {
            fileSystem,
            lock: options.lock,
            lockPath: `${path}.lock`,
            signal,
            prepare: ensureDirectory,
            fail: (error) => failedWithFor(label, error, key, 'written'),
          },
          async (): Promise<StoreResult<StoredValue>> => {
            try {
              await ensureDirectory();
              // Always start from the file, never the cache, so an outside edit is kept.
              const read: DocumentRead = await readDocument();
              if (read.kind === 'corrupt') {
                return corruptDocument(key, read.detail);
              }
              // What was just read is the truth, even if the write below is refused.
              adopt(read.entries);
              // An invalid entry is replaced, so it counts as nothing stored.
              const existing: StoredValue | null =
                storedOf(read.entries, key) ?? null;
              if (
                ifRevision !== undefined &&
                existing !== null &&
                existing.revision !== ifRevision
              ) {
                return failure(
                  'conflict',
                  key,
                  `holds revision ${existing.revision ?? ''}, but revision ${ifRevision} was expected`
                );
              }
              const written = layout.write(value, existing);
              read.entries.set(key, written.raw);
              await writeDocument(read.entries);
              snapshot = new Map(read.entries);
              return { ok: true, value: written.stored };
            } catch (error: unknown) {
              return failedWithFor(label, error, key, 'written');
            }
          }
        )
      );
      if (result.ok) {
        notify(key, result.value);
      }
      return result;
    },

    async remove(key, { signal }) {
      const abortedResult = stopped<null>(key, signal);
      if (abortedResult !== null) {
        return abortedResult;
      }
      const result: StoreResult<null> = await withLock(
        lockName,
        lockedTask<null>(
          {
            fileSystem,
            lock: options.lock,
            lockPath: `${path}.lock`,
            signal,
            prepare: ensureDirectory,
            fail: (error) => failedWithFor(label, error, key, 'removed'),
          },
          async (): Promise<StoreResult<null>> => {
            try {
              const read: DocumentRead = await readDocument();
              if (read.kind === 'corrupt') {
                return corruptDocument(key, read.detail);
              }
              adopt(read.entries);
              if (read.entries.delete(key)) {
                await writeDocument(read.entries);
              }
              snapshot = new Map(read.entries);
              return { ok: true, value: null };
            } catch (error: unknown) {
              return failedWithFor(label, error, key, 'removed');
            }
          }
        )
      );
      if (result.ok) {
        notify(key, null);
      }
      return result;
    },

    async list(prefix, { signal }) {
      if (signal.aborted) {
        return prefixFailure(
          label,
          'unavailable',
          prefix,
          'request to list keys was aborted'
        );
      }
      try {
        const read: DocumentRead = await load();
        if (read.kind === 'corrupt') {
          return prefixFailure(
            label,
            'corrupt',
            prefix,
            `cannot be used: ${path} ${read.detail}. Fix or delete the file; it was left as it is`
          );
        }
        // Entries that are not valid entries are left out, as `get` would refuse them.
        const keys: string[] = [...read.entries.keys()].filter(
          (key) =>
            key.startsWith(prefix) &&
            layout.read(read.entries.get(key)) !== undefined
        );
        return { ok: true, value: keys.sort(compareKeys) };
      } catch (error: unknown) {
        return prefixFailure(
          label,
          classifyFileError(error),
          prefix,
          `could not list keys (${describeUnknownError(error)})`
        );
      }
    },

    subscribe(key, onChange) {
      const set: Set<(stored: StoredValue | null) => void> =
        listeners.get(key) ?? new Set();
      set.add(onChange);
      listeners.set(key, set);
      startWatching();
      return () => {
        set.delete(onChange);
        if (set.size === 0) {
          listeners.delete(key);
        }
        if (listeners.size === 0) {
          stopWatchingNow();
        }
      };
    },
  };
}
