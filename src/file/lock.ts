/**
 * A lock file shared by every process that uses the same directory or document, so
 * a read-modify-write is not interleaved with another process's. It is made with the
 * file system's exclusive create (`FileSystemLike.writeNewFile`, `O_CREAT | O_EXCL`),
 * which succeeds for exactly one caller at a time. The lock file holds a random token
 * and the time it was taken; it is removed afterwards only if the token is still ours.
 * A lock older than `staleMs` is taken to belong to a process that died and is broken.
 *
 * It is an advisory lock for cooperating processes, built on files, so it has the
 * limits of files: it needs a file system where exclusive create is atomic (local
 * disks are; some network file systems are not), and a process that stalls for longer
 * than `staleMs` while holding it can have it broken from under it.
 */
import type { FileSystemLike } from './file.js';
import { errorCodeOf, unguessableSuffix } from './shared.js';
import type { StoreResult } from '../storage.js';

export interface FileLockOptions {
  /** Waits `ms`. You pass it, so the library has no timers. Rejecting stops the wait. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A lock held longer than this is taken to be left behind and is broken. Default 30000. */
  readonly staleMs?: number;
  /** How long to wait for a lock held by another process before giving up. Default 10000. */
  readonly timeoutMs?: number;
  /** The first wait between tries; it grows to four times this. Default 25. */
  readonly retryMs?: number;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 25;
/**
 * On Windows, creating a file that another process has just deleted, while that
 * process or a reader still has it open, fails with EPERM or EACCES until the last
 * handle closes, instead of EEXIST. That is contention, so it is waited out; but a
 * folder that really cannot be written gives the same codes, so after this many
 * tries in a row the error is passed on as it is.
 */
const MAX_DENIED_TRIES = 40;

function lockError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** What a lock file says: who took it and when, or `null` if it is not a lock. */
function parseLock(text: string): { token: string; at: number } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const fields = parsed as { token?: unknown; at?: unknown };
      if (typeof fields.token === 'string' && typeof fields.at === 'number') {
        return { token: fields.token, at: fields.at };
      }
    }
  } catch {
    // Not a lock file yet: perhaps its owner has not finished writing it.
  }
  return null;
}

/**
 * Runs `task` while holding the lock at `lockPath`. Rejects when the lock cannot be
 * had in time (code `ELOCKED`), when `signal` aborts while waiting (`ECANCELED`), or
 * when the file system cannot create exclusively (`ENOTSUP`); otherwise it resolves or
 * rejects as `task` does. The lock is released either way.
 */
export async function withFileLock<T>(
  fileSystem: FileSystemLike,
  lockPath: string,
  options: FileLockOptions,
  signal: AbortSignal,
  task: () => Promise<T>
): Promise<T> {
  const create = fileSystem.writeNewFile;
  if (create === undefined) {
    throw lockError(
      'ENOTSUP',
      'locking needs a file system with writeNewFile (an exclusive create); nodeFileSystem() has it'
    );
  }
  const staleMs: number = options.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs: number = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const firstWaitMs: number = options.retryMs ?? DEFAULT_RETRY_MS;
  const token: string = unguessableSuffix();
  const started: number = Date.now();
  let garbageSince: number | null = null;
  let waitMs: number = firstWaitMs;
  let deniedTries = 0;

  for (;;) {
    try {
      await create.call(
        fileSystem,
        lockPath,
        JSON.stringify({ token, at: Date.now() })
      );
      break;
    } catch (error: unknown) {
      const code: string = errorCodeOf(error);
      if (code === 'EPERM' || code === 'EACCES') {
        deniedTries += 1;
        if (deniedTries > MAX_DENIED_TRIES) {
          throw error;
        }
        if (signal.aborted) {
          throw lockError(
            'ECANCELED',
            'request was aborted while waiting for the lock'
          );
        }
        await options.sleep(waitMs, signal);
        waitMs = Math.min(waitMs * 2, firstWaitMs * 4);
        continue;
      }
      if (code !== 'EEXIST') {
        throw error;
      }
      deniedTries = 0;
    }
    // Someone holds it. If it is old, or has been unreadable for as long, it was
    // left behind by a process that died: break it, but only if it is still the
    // same lock that was judged stale.
    let seen: string;
    try {
      seen = await fileSystem.readFile(lockPath);
    } catch (error: unknown) {
      if (errorCodeOf(error) !== 'ENOENT') {
        throw error;
      }
      continue; // It was released just now: try to take it.
    }
    const held = parseLock(seen);
    const now: number = Date.now();
    garbageSince = held === null ? (garbageSince ?? now) : null;
    const stale: boolean =
      held === null
        ? now - (garbageSince ?? now) > staleMs
        : now - held.at > staleMs;
    if (stale) {
      try {
        if ((await fileSystem.readFile(lockPath)) === seen) {
          await fileSystem.remove(lockPath);
        }
      } catch (error: unknown) {
        if (errorCodeOf(error) !== 'ENOENT') {
          throw error;
        }
      }
      garbageSince = null;
      continue;
    }
    if (signal.aborted) {
      throw lockError(
        'ECANCELED',
        'request was aborted while waiting for the lock'
      );
    }
    if (Date.now() - started > timeoutMs) {
      throw lockError(
        'ELOCKED',
        `timed out after ${timeoutMs} ms waiting for the lock ${lockPath}, which another process holds; if no process does, delete that file`
      );
    }
    await options.sleep(waitMs, signal);
    waitMs = Math.min(waitMs * 2, firstWaitMs * 4);
  }

  try {
    return await task();
  } finally {
    try {
      const text: string = await fileSystem.readFile(lockPath);
      if (parseLock(text)?.token === token) {
        await fileSystem.remove(lockPath);
      }
    } catch {
      // Already gone, or unreadable: nothing of ours to release.
    }
  }
}

/** What `lockedTask` needs to know about the adapter it serves. */
export interface LockedTaskContext<T> {
  readonly fileSystem: FileSystemLike;
  /** Locking is off when this is `undefined`, and the task runs as it always did. */
  readonly lock: FileLockOptions | undefined;
  readonly lockPath: string;
  readonly signal: AbortSignal;
  /** Makes sure the folder exists, which the lock file needs. */
  readonly prepare: () => Promise<void>;
  /** Turns a failure to take the lock into a result. */
  readonly fail: (error: unknown) => StoreResult<T>;
}

/** Wraps a write so it runs while holding the cross-process lock, if one is configured. */
export function lockedTask<T>(
  context: LockedTaskContext<T>,
  task: () => Promise<StoreResult<T>>
): () => Promise<StoreResult<T>> {
  const { lock } = context;
  if (lock === undefined) {
    return task;
  }
  return async () => {
    try {
      await context.prepare();
      return await withFileLock(
        context.fileSystem,
        context.lockPath,
        lock,
        context.signal,
        task
      );
    } catch (error: unknown) {
      return context.fail(error);
    }
  };
}
