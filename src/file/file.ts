/**
 * A `StorageAdapter` over a directory of files, one file per key. Like `/browser`,
 * `/indexeddb` and `/sqlite`, this is an optional entry point: the core stays free
 * of I/O, and this file imports no file system module. You pass in a
 * `FileSystemLike`; `nodeFileSystem()` from `/file/node` covers Node, Bun and Deno.
 */
import { describeUnknownError } from '../errors.js';
import {
  classifyFileError,
  errorCodeOf,
  failedWithFor,
  failureFor,
  withLock,
  writeTemporaryFile,
} from './shared.js';
import {
  compareKeys,
  prefixFailure,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/**
 * The file operations this adapter needs. Each rejects with an error that has a
 * Node-style `code` string such as `"ENOENT"` where the operation can fail that way.
 */
export interface FileSystemLike {
  /** Resolves the file's text. Rejects with code `"ENOENT"` when it does not exist. */
  readFile(path: string): Promise<string>;
  /** Writes the text, replacing the file if it exists. */
  writeFile(path: string, data: string): Promise<void>;
  /**
   * Optional. Creates a new file with the text, and rejects with code `"EEXIST"`
   * instead of writing when anything is already at `path`, a symbolic link included
   * (`O_CREAT | O_EXCL`). The adapters write their temporary files this way when it
   * is available, so a file or link someone else put at the guessed name is never
   * written through or deleted.
   */
  writeNewFile?(path: string, data: string): Promise<void>;
  /** Moves a file, replacing the destination in one step. */
  rename(fromPath: string, toPath: string): Promise<void>;
  /** Deletes a file. A file that is already gone is not an error. */
  remove(path: string): Promise<void>;
  /** Creates a directory and any missing parents. An existing one is not an error. */
  mkdir(path: string): Promise<void>;
  /**
   * Optional. Calls `onChange` whenever the file at `path` is created, changed,
   * replaced or removed, including by another program. Returns a function that stops
   * watching. A file replaced by a rename must still be noticed.
   */
  watch?(path: string, onChange: () => void): () => void;
  /**
   * Optional. The names (not paths) of the files in the directory, or an empty list
   * if the directory does not exist. Needed for `list`; without it `list` reports
   * that it is not supported.
   */
  listFiles?(directory: string): Promise<string[]>;
  /**
   * Optional. Calls `onChange` with the name of the file (just the name, not the
   * path) whenever something in the directory is created, changed, replaced, renamed
   * or removed, including by another program, or with `null` when the system cannot
   * say which. Returns a function that stops watching. It lets `fileAdapter` report
   * writes made by other processes.
   */
  watchDirectory?(
    directory: string,
    onChange: (name: string | null) => void
  ): () => void;
}

export interface FileAdapterOptions {
  /** Where the files go. Created on first use. */
  readonly directory: string;
  readonly fileSystem: FileSystemLike;
}

/** What is written to each file: the value plus a counter used as its revision. */
interface Envelope {
  readonly r: string;
  readonly v: string;
}

const FILE_EXTENSION = '.json';

/** Longest encoded key. File names are limited to 255 bytes on common systems. */
const MAX_ENCODED_KEY_LENGTH = 200;

/**
 * Turns a key into a file name stem that is safe on every common file system,
 * including case-insensitive ones. `a-z`, `0-9` and `-` stay as they are; an
 * uppercase letter becomes `_` and its lowercase form; every other byte of the
 * key's UTF-8 becomes `~` and two lowercase hex digits. `.` is always escaped, so
 * a key can never become `.` or `..`, a hidden file, or a name ending in a dot.
 * Returns `undefined` for a key that cannot be stored.
 */
export function encodeKey(key: string): string | undefined {
  let encoded = '';
  for (const char of key) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return undefined; // A lone surrogate is not valid Unicode text.
    }
    if (
      (char >= 'a' && char <= 'z') ||
      (char >= '0' && char <= '9') ||
      char === '-'
    ) {
      encoded += char;
    } else if (char >= 'A' && char <= 'Z') {
      encoded += `_${char.toLowerCase()}`;
    } else {
      for (const byte of utf8Bytes(codePoint)) {
        encoded += `~${byte.toString(16).padStart(2, '0')}`;
      }
    }
  }
  if (encoded === '' || encoded.length > MAX_ENCODED_KEY_LENGTH) {
    return undefined;
  }
  return encoded;
}

/**
 * The key a file name stem stands for: the reverse of `encodeKey`. Returns
 * `undefined` for a stem `encodeKey` could not have made (so a stray file in the
 * directory is not mistaken for an entry).
 */
export function decodeKey(stem: string): string | undefined {
  const bytes: number[] = [];
  const flush = (): string | undefined => {
    if (bytes.length === 0) {
      return '';
    }
    const text: string | undefined = decodeUtf8(bytes);
    bytes.length = 0;
    return text;
  };
  let key = '';
  for (let index = 0; index < stem.length; index += 1) {
    const char: string = stem.charAt(index);
    if (char === '~') {
      const byte = Number.parseInt(stem.slice(index + 1, index + 3), 16);
      if (!/^[0-9a-f]{2}$/.test(stem.slice(index + 1, index + 3))) {
        return undefined;
      }
      bytes.push(byte);
      index += 2;
      continue;
    }
    const text: string | undefined = flush();
    if (text === undefined) {
      return undefined;
    }
    key += text;
    if (char === '_') {
      const letter: string = stem.charAt(index + 1);
      if (letter < 'a' || letter > 'z') {
        return undefined;
      }
      key += letter.toUpperCase();
      index += 1;
    } else {
      key += char;
    }
  }
  const tail: string | undefined = flush();
  if (tail === undefined) {
    return undefined;
  }
  key += tail;
  return encodeKey(key) === stem ? key : undefined;
}

/** Strict UTF-8 decoding without `TextDecoder`; `undefined` for invalid bytes. */
function decodeUtf8(bytes: readonly number[]): string | undefined {
  let text = '';
  for (let index = 0; index < bytes.length;) {
    const first: number = bytes[index] ?? 0;
    const length: number =
      first < 0x80
        ? 1
        : first >= 0xc2 && first < 0xe0
          ? 2
          : first >= 0xe0 && first < 0xf0
            ? 3
            : first >= 0xf0 && first < 0xf5
              ? 4
              : 0;
    if (length === 0 || index + length > bytes.length) {
      return undefined;
    }
    let codePoint: number =
      length === 1 ? first : first & (0xff >> (length + 1));
    for (let offset = 1; offset < length; offset += 1) {
      const next: number = bytes[index + offset] ?? 0;
      if ((next & 0xc0) !== 0x80) {
        return undefined;
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (
      (length === 3 && codePoint < 0x800) ||
      (length === 4 && (codePoint < 0x10000 || codePoint > 0x10ffff)) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return undefined;
    }
    text += String.fromCodePoint(codePoint);
    index += length;
  }
  return text;
}

function utf8Bytes(codePoint: number): number[] {
  if (codePoint < 0x80) {
    return [codePoint];
  }
  if (codePoint < 0x800) {
    return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)];
  }
  if (codePoint < 0x10000) {
    return [
      0xe0 | (codePoint >> 12),
      0x80 | ((codePoint >> 6) & 0x3f),
      0x80 | (codePoint & 0x3f),
    ];
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f),
  ];
}

/** `null` when nothing is stored, `undefined` when what is stored is not an envelope. */
function parseEnvelope(text: string): Envelope | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<Envelope> | null;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof parsed.r === 'string' &&
      typeof parsed.v === 'string'
    ) {
      return { r: parsed.r, v: parsed.v };
    }
  } catch {
    // Falls through to the corrupt result below.
  }
  return undefined;
}

const LABEL = 'File storage';

function failure<T>(
  code: StoreErrorCode,
  key: string,
  detail: string
): StoreResult<T> {
  return failureFor(LABEL, code, key, detail);
}

function failedWith<T>(
  error: unknown,
  key: string,
  verb: string
): StoreResult<T> {
  return failedWithFor(LABEL, error, key, verb);
}

/**
 * A `StorageAdapter` over a directory, one file per key. A file holds the value and
 * a counter revision as JSON. A write goes to a temporary file that is then renamed
 * over the real one, so a reader sees the old value or the new one, never half of a
 * write. Writes to the same key are queued, so `set` with `ifRevision` reports
 * `conflict` when another write got there first, as long as every writer is in this
 * process. Separate processes writing the same directory can lose an update; use
 * the SQLite adapter when that matters. `subscribe` reports changes made through
 * adapters in this process and, when the file system can watch a directory
 * (`watchDirectory`, which `nodeFileSystem` has), changes other processes make to
 * the files. Nothing throws: every failure is a `StoreResult`.
 */
export function fileAdapter(options: FileAdapterOptions): StorageAdapter {
  const { fileSystem } = options;
  // Without a trailing separator, so `dir/` and `dir` name the same place.
  const directory: string = options.directory.replace(/[\\/]+$/, '');
  const listeners = new Map<
    string,
    Set<(stored: StoredValue | null) => void>
  >();
  let directoryReady = false;

  const pathOf = (stem: string): string =>
    `${directory}/${stem}${FILE_EXTENSION}`;

  const ensureDirectory = async (): Promise<void> => {
    if (!directoryReady) {
      await fileSystem.mkdir(directory);
      directoryReady = true;
    }
  };

  /** `null` when the file does not exist. Throws on any other file system error. */
  const readEnvelope = async (
    path: string
  ): Promise<Envelope | null | undefined> => {
    let text: string;
    try {
      text = await fileSystem.readFile(path);
    } catch (error: unknown) {
      if (errorCodeOf(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
    return parseEnvelope(text);
  };

  const stopped = <T>(
    key: string,
    signal: AbortSignal
  ): StoreResult<T> | null =>
    signal.aborted ? failure('unavailable', key, 'request was aborted') : null;

  const invalidKey = <T>(key: string): StoreResult<T> =>
    failure(
      'invalid',
      key,
      'cannot use this key (it must be 1 to 200 characters after encoding, and valid Unicode)'
    );

  /** What each subscribed key last held, so a watcher event that changes nothing is silent. */
  const known = new Map<string, StoredValue | null>();
  /** Subscribed keys by the file name stem they are stored under. */
  const subscribedStems = new Map<string, string>();
  let watchState: 'off' | 'starting' | 'on' = 'off';
  let stopWatching: (() => void) | null = null;

  const sameStored = (
    left: StoredValue | null | undefined,
    right: StoredValue | null
  ): boolean =>
    left !== undefined &&
    (left === right ||
      (left !== null &&
        right !== null &&
        left.value === right.value &&
        left.revision === right.revision));

  const notify = (key: string, stored: StoredValue | null): void => {
    if (listeners.has(key)) {
      known.set(key, stored);
    }
    for (const listener of listeners.get(key) ?? []) {
      try {
        listener(stored);
      } catch {
        // A faulty listener must not turn a successful write into a failure.
      }
    }
  };

  /** Reads a key under its lock and reports it if it differs from what was last seen. */
  const refresh = (key: string, stem: string): Promise<void> =>
    withLock(`${directory}\u0000${stem}`, async (): Promise<void> => {
      if (!listeners.has(key)) {
        return;
      }
      let envelope: Envelope | null | undefined;
      try {
        envelope = await readEnvelope(pathOf(stem));
      } catch {
        return; // Try again on the next change.
      }
      if (envelope === undefined) {
        return; // Half-written or not an entry; wait for the next change.
      }
      const current: StoredValue | null =
        envelope === null ? null : { value: envelope.v, revision: envelope.r };
      if (!sameStored(known.get(key), current)) {
        notify(key, current);
      }
    });

  /** Takes the file as it is now as the starting point for a new subscription. */
  const baseline = (key: string, stem: string): Promise<void> =>
    withLock(`${directory}\u0000${stem}`, async (): Promise<void> => {
      if (known.has(key) || !listeners.has(key)) {
        return;
      }
      try {
        const envelope = await readEnvelope(pathOf(stem));
        if (envelope !== undefined && !known.has(key)) {
          known.set(
            key,
            envelope === null
              ? null
              : { value: envelope.v, revision: envelope.r }
          );
        }
      } catch {
        // No starting point; the first change will be reported.
      }
    });

  const onDirectoryChange = (name: string | null): void => {
    if (name === null) {
      for (const [stem, key] of subscribedStems) {
        void refresh(key, stem);
      }
      return;
    }
    if (!name.endsWith(FILE_EXTENSION)) {
      return; // Temporary files and anything that is not ours.
    }
    const stem: string = name.slice(0, -FILE_EXTENSION.length);
    const key: string | undefined = subscribedStems.get(stem);
    if (key !== undefined) {
      void refresh(key, stem);
    }
  };

  const startWatching = (): void => {
    if (fileSystem.watchDirectory === undefined || watchState !== 'off') {
      return;
    }
    watchState = 'starting';
    void (async (): Promise<void> => {
      try {
        await ensureDirectory();
        if (watchState !== 'starting') {
          return; // Everyone unsubscribed while this was starting.
        }
        stopWatching =
          fileSystem.watchDirectory?.(directory, onDirectoryChange) ?? null;
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
      const stem: string | undefined = encodeKey(key);
      if (stem === undefined) {
        return invalidKey(key);
      }
      try {
        const envelope = await readEnvelope(pathOf(stem));
        if (envelope === null) {
          return { ok: true, value: null };
        }
        if (envelope === undefined) {
          return failure(
            'corrupt',
            key,
            'holds a file that is not a stored entry'
          );
        }
        return { ok: true, value: { value: envelope.v, revision: envelope.r } };
      } catch (error: unknown) {
        return failedWith(error, key, 'read');
      }
    },

    async set(key, value, { signal, ifRevision }) {
      const abortedResult = stopped<StoredValue>(key, signal);
      if (abortedResult !== null) {
        return abortedResult;
      }
      const stem: string | undefined = encodeKey(key);
      if (stem === undefined) {
        return invalidKey(key);
      }
      const path: string = pathOf(stem);
      const result: StoreResult<StoredValue> = await withLock(
        `${directory}\u0000${stem}`,
        async (): Promise<StoreResult<StoredValue>> => {
          let temporaryPath: string | null = null;
          try {
            await ensureDirectory();
            // A corrupt file is replaced, so it counts as nothing stored.
            const existing: Envelope | null =
              (await readEnvelope(path)) ?? null;
            if (
              ifRevision !== undefined &&
              existing !== null &&
              existing.r !== ifRevision
            ) {
              return failure(
                'conflict',
                key,
                `holds revision ${existing.r}, but revision ${ifRevision} was expected`
              );
            }
            const revision: string = String((Number(existing?.r) || 0) + 1);
            const envelope: Envelope = { r: revision, v: value };
            temporaryPath = await writeTemporaryFile(
              fileSystem,
              path,
              JSON.stringify(envelope)
            );
            await fileSystem.rename(temporaryPath, path);
            temporaryPath = null;
            // Announced while the key is still locked, so a watcher that reads the
            // file next finds this already reported and says nothing more.
            notify(key, { value, revision });
            return { ok: true, value: { value, revision } };
          } catch (error: unknown) {
            if (temporaryPath !== null) {
              try {
                await fileSystem.remove(temporaryPath);
              } catch {
                // The leftover temporary file is harmless; the write already failed.
              }
            }
            return failedWith(error, key, 'written');
          }
        }
      );
      return result;
    },

    async remove(key, { signal }) {
      const abortedResult = stopped<null>(key, signal);
      if (abortedResult !== null) {
        return abortedResult;
      }
      const stem: string | undefined = encodeKey(key);
      if (stem === undefined) {
        return invalidKey(key);
      }
      const result: StoreResult<null> = await withLock(
        `${directory}\u0000${stem}`,
        async (): Promise<StoreResult<null>> => {
          try {
            await fileSystem.remove(pathOf(stem));
            notify(key, null);
            return { ok: true, value: null };
          } catch (error: unknown) {
            return failedWith(error, key, 'removed');
          }
        }
      );
      return result;
    },

    async list(prefix, { signal }) {
      if (signal.aborted) {
        return prefixFailure(
          LABEL,
          'unavailable',
          prefix,
          'request to list keys was aborted'
        );
      }
      if (fileSystem.listFiles === undefined) {
        return prefixFailure(
          LABEL,
          'invalid',
          prefix,
          'cannot list keys: the file system has no listFiles method'
        );
      }
      try {
        const names: string[] = await fileSystem.listFiles(directory);
        const keys: string[] = [];
        for (const name of names) {
          if (!name.endsWith(FILE_EXTENSION)) {
            continue; // Temporary files and anything that is not ours.
          }
          const key: string | undefined = decodeKey(
            name.slice(0, -FILE_EXTENSION.length)
          );
          if (key !== undefined && key.startsWith(prefix)) {
            keys.push(key);
          }
        }
        return { ok: true, value: keys.sort(compareKeys) };
      } catch (error: unknown) {
        return prefixFailure(
          LABEL,
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
      const stem: string | undefined = encodeKey(key);
      if (stem !== undefined) {
        subscribedStems.set(stem, key);
        void baseline(key, stem);
      }
      startWatching();
      return () => {
        set.delete(onChange);
        if (set.size === 0) {
          listeners.delete(key);
          known.delete(key);
          if (stem !== undefined) {
            subscribedStems.delete(stem);
          }
        }
        if (listeners.size === 0) {
          stopWatchingNow();
        }
      };
    },
  };
}
