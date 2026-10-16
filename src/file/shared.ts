/**
 * Pieces shared by the file-based adapters (`/file` and `/json-file`): mapping file
 * system errors to store error codes, and a per-name queue for writes.
 */
import { describeUnknownError } from '../errors.js';
import type { StoreErrorCode, StoreResult } from '../storage.js';
import type { FileSystemLike } from './file.js';

/** Queues by name, shared by every adapter in this process. */
const locks = new Map<string, Promise<void>>();

/** Runs `task` after every earlier task for the same lock name has finished. */
export function withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
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

/** The Node-style `code` of an error such as `"ENOENT"`, or `""` if it has none. */
export function errorCodeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return '';
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

export function classifyFileError(error: unknown): StoreErrorCode {
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

/** A failed result whose message starts with `label` and names the key. */
export function failureFor<T>(
  label: string,
  code: StoreErrorCode,
  key: string,
  detail: string
): StoreResult<T> {
  return { ok: false, code, error: `${label} ${detail} for key "${key}"` };
}

/** A failed result for a thrown file system error, worded `could not be <verb> (...)`. */
export function failedWithFor<T>(
  label: string,
  error: unknown,
  key: string,
  verb: string
): StoreResult<T> {
  return failureFor(
    label,
    classifyFileError(error),
    key,
    `could not be ${verb} (${describeUnknownError(error)})`
  );
}

/** Tries this many temporary names before giving up on finding a free one. */
const MAX_TEMPORARY_ATTEMPTS = 8;

/** Sixteen hex digits that are hard to guess: random bytes where the runtime has them. */
function unguessableSuffix(): string {
  const source:
    { getRandomValues?: (bytes: Uint8Array) => Uint8Array } | undefined = (
    globalThis as {
      crypto?: { getRandomValues?: (bytes: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (typeof source?.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    source.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
      ''
    );
  }
  return `${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`.padEnd(
    16,
    '0'
  );
}

/**
 * Writes `data` to a new temporary file next to `path` and returns its path, ready
 * to be renamed over `path`. With a file system that can create exclusively, a name
 * that is taken (by anything, including a symbolic link someone planted) is skipped
 * and never written through; the returned file is always one this call created, so
 * it is safe for the caller to remove if the rename fails. Without that, it falls
 * back to a plain write.
 */
export async function writeTemporaryFile(
  fileSystem: FileSystemLike,
  path: string,
  data: string
): Promise<string> {
  for (let attempt = 0; attempt < MAX_TEMPORARY_ATTEMPTS; attempt += 1) {
    const temporaryPath = `${path}.${unguessableSuffix()}.tmp`;
    if (fileSystem.writeNewFile === undefined) {
      await fileSystem.writeFile(temporaryPath, data);
      return temporaryPath;
    }
    try {
      await fileSystem.writeNewFile(temporaryPath, data);
      return temporaryPath;
    } catch (error: unknown) {
      if (errorCodeOf(error) !== 'EEXIST') {
        throw error;
      }
    }
  }
  throw Object.assign(
    new Error(
      `could not find an unused temporary file name next to ${path} after ${MAX_TEMPORARY_ATTEMPTS} tries`
    ),
    { code: 'EEXIST' }
  );
}
