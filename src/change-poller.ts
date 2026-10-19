/**
 * Finding other processes' changes by looking: for stores that cannot announce them.
 * An adapter gives this a way to read a batch of keys; this watches the subscribed keys
 * on a timer and tells subscribers what changed. Used by the adapters whose stores have
 * no change feed an HTTP or SQL client can follow. Like the rest of `src/`, this does
 * no I/O of its own.
 */
import { describeUnknownError } from './errors.js';
import { createChangeListeners } from './sql-shared.js';
import type { StoredValue } from './storage.js';

/** The shortest time between polls. */
export const MIN_POLL_INTERVAL_MS = 50;
/** How many keys an adapter is asked to read at once. */
export const POLL_BATCH_SIZE = 100;

export interface ChangePollerOptions {
  /** Milliseconds between polls, or `undefined` for no polling. Values under 50 become 50. */
  readonly intervalMs: number | undefined;
  /**
   * Reads these keys (at most `POLL_BATCH_SIZE`) and returns what is stored under each
   * that has a value. Keys with nothing stored are left out. Throws if the read fails.
   */
  readonly readKeys: (
    keys: readonly string[]
  ) => Promise<ReadonlyMap<string, StoredValue>>;
  /** Called once per run of failed polls, with a message that ends the caller's sentence. */
  readonly onError?: ((message: string) => void) | undefined;
  /** What went wrong, in words: "<label> could not poll <where> for changes (<cause>)". */
  readonly describeFailure: (cause: string) => string;
}

export interface ChangePoller {
  /** Tells subscribers about a write or removal made through the adapter itself. */
  announce(key: string, stored: StoredValue | null): void;
  /** Subscribes to a key; polls while anyone is subscribed (if polling is on). */
  subscribe(
    key: string,
    onChange: (stored: StoredValue | null) => void
  ): () => void;
}

function sameStored(a: StoredValue | null, b: StoredValue | null): boolean {
  return a === null || b === null
    ? a === b
    : a.value === b.value && a.revision === b.revision;
}

/**
 * Keeps subscribers up to date. A key seen for the first time is only noted: what is
 * stored when you subscribe is not a change. A key the adapter wrote while a poll was
 * in flight is skipped, because that poll's answer may be older than the write. Changes
 * between polls are reported as the latest state only. With nothing subscribed there is
 * no read and no timer, and the timer does not keep a program running.
 */
export function createChangePoller(options: ChangePollerOptions): ChangePoller {
  const listeners = createChangeListeners();
  const intervalMs: number | null =
    options.intervalMs !== undefined &&
    Number.isFinite(options.intervalMs) &&
    options.intervalMs > 0
      ? Math.max(MIN_POLL_INTERVAL_MS, Math.floor(options.intervalMs))
      : null;
  /** How many subscriptions each key has; polling runs while this is not empty. */
  const subscribedKeys = new Map<string, number>();
  /** What each subscribed key last held, as far as subscribers have been told. */
  const lastSeen = new Map<string, StoredValue | null>();
  /** Counts writes made through the adapter, so a poll that began earlier is not believed. */
  const localWrites = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failing = false;

  const announce = (key: string, stored: StoredValue | null): void => {
    if (subscribedKeys.has(key)) {
      lastSeen.set(key, stored);
      localWrites.set(key, (localWrites.get(key) ?? 0) + 1);
    }
    listeners.notify(key, stored);
  };

  const pollKeys = async (keys: readonly string[]): Promise<void> => {
    const stamps = new Map<string, number>(
      keys.map((key) => [key, localWrites.get(key) ?? 0])
    );
    const found = new Map<string, StoredValue>();
    for (let start = 0; start < keys.length; start += POLL_BATCH_SIZE) {
      const batch: readonly string[] = keys.slice(
        start,
        start + POLL_BATCH_SIZE
      );
      for (const [key, stored] of await options.readKeys(batch)) {
        found.set(key, stored);
      }
    }
    for (const key of keys) {
      if (
        !subscribedKeys.has(key) ||
        (localWrites.get(key) ?? 0) !== stamps.get(key)
      ) {
        continue;
      }
      const current: StoredValue | null = found.get(key) ?? null;
      const known: boolean = lastSeen.has(key);
      const before: StoredValue | null = lastSeen.get(key) ?? null;
      lastSeen.set(key, current);
      if (known && !sameStored(before, current)) {
        listeners.notify(key, current);
      }
    }
  };

  const failed = (error: unknown): void => {
    if (failing) {
      return;
    }
    failing = true;
    try {
      options.onError?.(options.describeFailure(describeUnknownError(error)));
    } catch {
      // A faulty error handler must not break the adapter.
    }
  };

  const scheduleNext = (): void => {
    if (intervalMs === null || timer !== null || subscribedKeys.size === 0) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      const keys: string[] = [...subscribedKeys.keys()];
      void (keys.length === 0 ? Promise.resolve() : pollKeys(keys))
        .then(() => {
          failing = false;
        })
        .catch(failed)
        .finally(scheduleNext);
    }, intervalMs);
    // Polling alone should not keep a program running.
    (timer as { unref?: () => void }).unref?.();
  };

  const subscribe = (
    key: string,
    onChange: (stored: StoredValue | null) => void
  ): (() => void) => {
    const stop: () => void = listeners.subscribe(key, onChange);
    if (intervalMs === null) {
      return stop;
    }
    subscribedKeys.set(key, (subscribedKeys.get(key) ?? 0) + 1);
    // Note what is stored now, then keep looking.
    void pollKeys([key]).catch(failed).finally(scheduleNext);
    let stopped = false;
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      stop();
      const remaining: number = (subscribedKeys.get(key) ?? 1) - 1;
      if (remaining > 0) {
        subscribedKeys.set(key, remaining);
        return;
      }
      subscribedKeys.delete(key);
      lastSeen.delete(key);
      localWrites.delete(key);
      if (subscribedKeys.size === 0 && timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  };

  return { announce, subscribe };
}
