/**
 * A `StorageAdapter` over a directory of files, one file per key. Like `/browser`,
 * `/indexeddb` and `/sqlite`, this is an optional entry point: the core stays free
 * of I/O, and this file imports no file system module. You pass in a
 * `FileSystemLike`; `nodeFileSystem()` from `/file/node` covers Node, Bun and Deno.
 */
import { describeUnknownError } from '../errors.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreErrorCode,
  StoreResult,
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
  /** Moves a file, replacing the destination in one step. */
  rename(fromPath: string, toPath: string): Promise<void>;
  /** Deletes a file. A file that is already gone is not an error. */
  remove(path: string): Promise<void>;
  /** Creates a directory and any missing parents. An existing one is not an error. */
  mkdir(path: string): Promise<void>;
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

/** Per-key locks, shared by every adapter in this process, keyed by directory and file. */
const locks = new Map<string, Promise<void>>();

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

function errorCodeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return '';
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function classifyError(error: unknown): StoreErrorCode {
  switch (errorCodeOf(error)) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'quota';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'forbidden';
    default:
      return 'unavailable';
  }
}

function failure<T>(
  code: StoreErrorCode,
  key: string,
  detail: string
): StoreResult<T> {
  return { ok: false, code, error: `File storage ${detail} for key "${key}"` };
}

function failedWith<T>(
  error: unknown,
  key: string,
  verb: string
): StoreResult<T> {
  return failure(
    classifyError(error),
    key,
    `could not be ${verb} (${describeUnknownError(error)})`
  );
}

/** Runs `task` after every earlier task for the same lock name has finished. */
function withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const previous: Promise<void> = locks.get(name) ?? Promise.resolve();
  const result: Promise<T> = previous.then(task, task);
  const tail: Promise<void> = result.then(
    () => undefined,
    () => undefined
  );
  locks.set(name, tail);
  void tail.then(() => {
    if (locks.get(name) === tail) {
      locks.delete(name);
    }
  });
  return result;
}

/**
 * A `StorageAdapter` over a directory, one file per key. A file holds the value and
 * a counter revision as JSON. A write goes to a temporary file that is then renamed
 * over the real one, so a reader sees the old value or the new one, never half of a
 * write. Writes to the same key are queued, so `set` with `ifRevision` reports
 * `conflict` when another write got there first, as long as every writer is in this
 * process. Separate processes writing the same directory can lose an update; use
 * the SQLite adapter when that matters. `subscribe` reports changes made through
 * adapters in this process. Nothing throws: every failure is a `StoreResult`.
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
  let tempCounter = 0;

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

  const notify = (key: string, stored: StoredValue | null): void => {
    for (const listener of listeners.get(key) ?? []) {
      try {
        listener(stored);
      } catch {
        // A faulty listener must not turn a successful write into a failure.
      }
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
            tempCounter += 1;
            temporaryPath = `${path}.${Math.random().toString(36).slice(2)}${tempCounter}.tmp`;
            const envelope: Envelope = { r: revision, v: value };
            await fileSystem.writeFile(temporaryPath, JSON.stringify(envelope));
            await fileSystem.rename(temporaryPath, path);
            temporaryPath = null;
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
      const stem: string | undefined = encodeKey(key);
      if (stem === undefined) {
        return invalidKey(key);
      }
      const result: StoreResult<null> = await withLock(
        `${directory}\u0000${stem}`,
        async (): Promise<StoreResult<null>> => {
          try {
            await fileSystem.remove(pathOf(stem));
            return { ok: true, value: null };
          } catch (error: unknown) {
            return failedWith(error, key, 'removed');
          }
        }
      );
      if (result.ok) {
        notify(key, null);
      }
      return result;
    },

    subscribe(key, onChange) {
      const set: Set<(stored: StoredValue | null) => void> =
        listeners.get(key) ?? new Set();
      set.add(onChange);
      listeners.set(key, set);
      return () => {
        set.delete(onChange);
        if (set.size === 0) {
          listeners.delete(key);
        }
      };
    },
  };
}
