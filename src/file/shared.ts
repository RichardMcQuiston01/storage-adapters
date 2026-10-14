/**
 * Pieces shared by the file-based adapters (`/file` and `/json-file`): mapping file
 * system errors to store error codes, and a per-name queue for writes.
 */
import { describeUnknownError } from '../errors.js';
import type { StoreErrorCode, StoreResult } from '../storage.js';

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
