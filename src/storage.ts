/**
 * Storage adapters: the async key-value contract you implement for
 * localStorage, IndexedDB, a REST API or a database, plus I/O-free wrappers
 * built on it. This package does no I/O itself: no timers, DOM, `fetch` or
 * storage globals.
 */

import { describeUnknownError } from './errors.js';

export type StoreErrorCode =
  /** Storage can't be reached or is disabled. */
  | 'unavailable'
  /** Storage is full. */
  | 'quota'
  /** Not allowed to read or write. */
  | 'forbidden'
  /** The stored revision is newer than the one given. */
  | 'conflict'
  /** The adapter was given something it can't store. */
  | 'invalid'
  /** What is stored can't be read back. */
  | 'corrupt';

export type StoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: StoreErrorCode;
      /** Names the key and the cause. */
      readonly error: string;
    };

export interface StoredValue {
  /** The serialized layout. */
  readonly value: string;
  /** Opaque version (an ETag, a row version) for conflict detection. */
  readonly revision?: string;
}

export interface StorageAdapter {
  /** Resolves `{ ok: true, value: null }` when nothing is stored. */
  get(
    key: string,
    options: { readonly signal: AbortSignal }
  ): Promise<StoreResult<StoredValue | null>>;
  /**
   * With `ifRevision`, fail with `conflict` when the stored revision differs.
   * Adapters without revisions ignore it (last write wins).
   */
  set(
    key: string,
    value: string,
    options: { readonly signal: AbortSignal; readonly ifRevision?: string }
  ): Promise<StoreResult<StoredValue>>;
  remove?(
    key: string,
    options: { readonly signal: AbortSignal }
  ): Promise<StoreResult<null>>;
  /** Optional: report a change made elsewhere (another tab). Returns an unsubscribe. */
  subscribe?(
    key: string,
    onChange: (stored: StoredValue | null) => void
  ): () => void;
}

function failure(
  code: StoreErrorCode,
  error: string
): {
  readonly ok: false;
  readonly code: StoreErrorCode;
  readonly error: string;
} {
  return { ok: false, code, error };
}

/** UTF-8 byte length without `TextEncoder` (no DOM or Node lib). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point: number = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/* ------------------------------------------------------------------ */
/* Adapters and wrappers                                               */
/* ------------------------------------------------------------------ */

/** An in-memory adapter with revisions and `subscribe`: tests, SSR, fallback. */
export function memoryAdapter(
  initial: Readonly<Record<string, string>> = {}
): StorageAdapter {
  const entries = new Map<string, StoredValue>();
  const listeners = new Map<
    string,
    Set<(stored: StoredValue | null) => void>
  >();
  let counter = 0;
  for (const [key, value] of Object.entries(initial)) {
    counter += 1;
    entries.set(key, { value, revision: String(counter) });
  }
  const notify = (key: string, stored: StoredValue | null): void => {
    for (const listener of listeners.get(key) ?? []) listener(stored);
  };
  return {
    get: (key) =>
      Promise.resolve({ ok: true, value: entries.get(key) ?? null }),
    set: (key, value, options) => {
      const current: StoredValue | undefined = entries.get(key);
      if (
        options.ifRevision !== undefined &&
        (current?.revision ?? undefined) !== options.ifRevision
      ) {
        return Promise.resolve(
          failure(
            'conflict',
            `Could not save "${key}": it changed since revision ${options.ifRevision} (now ${current?.revision ?? 'none'}).`
          )
        );
      }
      counter += 1;
      const stored: StoredValue = { value, revision: String(counter) };
      entries.set(key, stored);
      notify(key, stored);
      return Promise.resolve({ ok: true, value: stored });
    },
    remove: (key) => {
      entries.delete(key);
      notify(key, null);
      return Promise.resolve({ ok: true, value: null });
    },
    subscribe: (key, onChange) => {
      const set: Set<(stored: StoredValue | null) => void> =
        listeners.get(key) ?? new Set();
      set.add(onChange);
      listeners.set(key, set);
      return () => {
        set.delete(onChange);
      };
    },
  };
}

/** Namespaces every key, for several dashboards or apps in one store. */
export function withPrefix(
  adapter: StorageAdapter,
  prefix: string
): StorageAdapter {
  return {
    get: (key, options) => adapter.get(prefix + key, options),
    set: (key, value, options) => adapter.set(prefix + key, value, options),
    ...(adapter.remove === undefined
      ? {}
      : {
          remove: (key: string, options: { readonly signal: AbortSignal }) =>
            adapter.remove?.(prefix + key, options) ??
            Promise.resolve(failure('invalid', 'remove is not supported.')),
        }),
    ...(adapter.subscribe === undefined
      ? {}
      : {
          subscribe: (
            key: string,
            onChange: (stored: StoredValue | null) => void
          ) => adapter.subscribe?.(prefix + key, onChange) ?? (() => undefined),
        }),
  };
}

/**
 * Reads from `primary`, falling back to `secondary` when it errs or holds
 * nothing. Writes go to `primary` first, then `secondary` (best effort); a
 * `conflict` from `primary` is returned as is and writes nothing else. When
 * `primary` can't be written but `secondary` can, the write counts as saved.
 */
export function withFallback(
  primary: StorageAdapter,
  secondary: StorageAdapter
): StorageAdapter {
  return {
    async get(key, options) {
      const first = await primary.get(key, options);
      if (first.ok && first.value !== null) return first;
      const second = await secondary.get(key, options);
      if (second.ok && second.value !== null) return second;
      return first;
    },
    async set(key, value, options) {
      const first = await primary.set(key, value, options);
      if (!first.ok && first.code === 'conflict') return first;
      const second = await secondary.set(key, value, {
        signal: options.signal,
      });
      if (first.ok) return first;
      return second.ok ? second : first;
    },
    async remove(key, options) {
      const first = (await primary.remove?.(key, options)) ?? {
        ok: true as const,
        value: null,
      };
      await secondary.remove?.(key, options);
      return first;
    },
    subscribe: (key, onChange) => {
      const stops: (() => void)[] = [primary, secondary].flatMap((adapter) => {
        const stop: (() => void) | undefined = adapter.subscribe?.(
          key,
          onChange
        );
        return stop === undefined ? [] : [stop];
      });
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}

/** Remembers each key's last read or write, so repeated reads skip the store. */
export function withReadCache(adapter: StorageAdapter): StorageAdapter {
  const cache = new Map<string, StoredValue | null>();
  return {
    async get(key, options) {
      const cached: StoredValue | null | undefined = cache.get(key);
      if (cached !== undefined) return { ok: true, value: cached };
      const result = await adapter.get(key, options);
      if (result.ok) cache.set(key, result.value);
      return result;
    },
    async set(key, value, options) {
      const result = await adapter.set(key, value, options);
      if (result.ok) cache.set(key, result.value);
      else cache.delete(key);
      return result;
    },
    async remove(key, options) {
      cache.delete(key);
      return (
        (await adapter.remove?.(key, options)) ??
        failure(
          'invalid',
          `Could not remove "${key}": remove is not supported.`
        )
      );
    },
    ...(adapter.subscribe === undefined
      ? {}
      : {
          subscribe: (
            key: string,
            onChange: (stored: StoredValue | null) => void
          ) =>
            adapter.subscribe?.(key, (stored) => {
              cache.set(key, stored);
              onChange(stored);
            }) ?? (() => undefined),
        }),
  };
}

/** Rejects writes with `forbidden`: previewing someone else's layout. */
export function readOnly(adapter: StorageAdapter): StorageAdapter {
  return {
    get: (key, options) => adapter.get(key, options),
    set: (key) =>
      Promise.resolve(
        failure(
          'forbidden',
          `Could not save "${key}": this store is read-only.`
        )
      ),
    remove: (key) =>
      Promise.resolve(
        failure(
          'forbidden',
          `Could not remove "${key}": this store is read-only.`
        )
      ),
    ...(adapter.subscribe === undefined
      ? {}
      : { subscribe: adapter.subscribe.bind(adapter) }),
  };
}

export interface RetryOptions {
  /** Total tries, including the first. Default 3. */
  readonly attempts?: number;
  /** First wait in ms; doubles each retry. Default 200. */
  readonly delayMs?: number;
  /** Waits `ms`. You pass it, so the library has no timers. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Retries `unavailable` errors (and nothing else) with doubling waits. */
export function withRetry(
  adapter: StorageAdapter,
  options: RetryOptions
): StorageAdapter {
  const attempts: number = Math.max(1, Math.floor(options.attempts ?? 3));
  const baseDelay: number = options.delayMs ?? 200;
  const retrying = async <T>(
    signal: AbortSignal,
    run: () => Promise<StoreResult<T>>
  ): Promise<StoreResult<T>> => {
    let result: StoreResult<T> = await run();
    for (
      let attempt = 1;
      attempt < attempts &&
      !result.ok &&
      result.code === 'unavailable' &&
      !signal.aborted;
      attempt += 1
    ) {
      await options.sleep(baseDelay * 2 ** (attempt - 1), signal);
      result = await run();
    }
    return result;
  };
  return {
    get: (key, o) => retrying(o.signal, () => adapter.get(key, o)),
    set: (key, value, o) =>
      retrying(o.signal, () => adapter.set(key, value, o)),
    ...(adapter.remove === undefined
      ? {}
      : {
          remove: (key: string, o: { readonly signal: AbortSignal }) =>
            retrying(
              o.signal,
              () =>
                adapter.remove?.(key, o) ??
                Promise.resolve(failure('invalid', 'remove is not supported.'))
            ),
        }),
    ...(adapter.subscribe === undefined
      ? {}
      : { subscribe: adapter.subscribe.bind(adapter) }),
  };
}

export interface EncodingOptions {
  /** Applied before storing: compression, or encryption with your own crypto. */
  readonly encode: (value: string) => string | Promise<string>;
  /** Reverses `encode` after reading. */
  readonly decode: (value: string) => string | Promise<string>;
}

/** Transforms values on the way in and out. Keys and revisions pass through. */
export function withEncoding(
  adapter: StorageAdapter,
  codec: EncodingOptions
): StorageAdapter {
  const decodeStored = async (
    key: string,
    stored: StoredValue
  ): Promise<StoreResult<StoredValue>> => {
    try {
      const value: string = await codec.decode(stored.value);
      return {
        ok: true,
        value:
          stored.revision === undefined
            ? { value }
            : { value, revision: stored.revision },
      };
    } catch (cause) {
      return failure(
        'corrupt',
        `Could not decode the value stored at "${key}": ${describeUnknownError(cause)}`
      );
    }
  };
  return {
    async get(key, options) {
      const result = await adapter.get(key, options);
      if (!result.ok || result.value === null) return result;
      return decodeStored(key, result.value);
    },
    async set(key, value, options) {
      let encoded: string;
      try {
        encoded = await codec.encode(value);
      } catch (cause) {
        return failure(
          'invalid',
          `Could not encode the value for "${key}": ${describeUnknownError(cause)}`
        );
      }
      const result = await adapter.set(key, encoded, options);
      if (!result.ok) return result;
      return result.value.revision === undefined
        ? { ok: true, value: { value } }
        : { ok: true, value: { value, revision: result.value.revision } };
    },
    ...(adapter.remove === undefined
      ? {}
      : { remove: adapter.remove.bind(adapter) }),
    ...(adapter.subscribe === undefined
      ? {}
      : {
          subscribe: (
            key: string,
            onChange: (stored: StoredValue | null) => void
          ) =>
            adapter.subscribe?.(key, (stored) => {
              if (stored === null) {
                onChange(null);
                return;
              }
              void decodeStored(key, stored).then((decoded) => {
                if (decoded.ok) onChange(decoded.value);
              });
            }) ?? (() => undefined),
        }),
  };
}

export interface StorageLogEvent {
  readonly operation: 'get' | 'set' | 'remove';
  readonly key: string;
  readonly ok: boolean;
  /** Present when `ok` is false. Values are never logged. */
  readonly code?: StoreErrorCode;
}

/** Reports each operation's key and outcome. Never the stored value. */
export function withLogging(
  adapter: StorageAdapter,
  log: (event: StorageLogEvent) => void
): StorageAdapter {
  const report = <T>(
    operation: StorageLogEvent['operation'],
    key: string,
    result: StoreResult<T>
  ): StoreResult<T> => {
    try {
      log(
        result.ok
          ? { operation, key, ok: true }
          : { operation, key, ok: false, code: result.code }
      );
    } catch {
      // A broken logger must not break storage.
    }
    return result;
  };
  return {
    get: async (key, o) => report('get', key, await adapter.get(key, o)),
    set: async (key, value, o) =>
      report('set', key, await adapter.set(key, value, o)),
    ...(adapter.remove === undefined
      ? {}
      : {
          remove: async (key: string, o: { readonly signal: AbortSignal }) =>
            report(
              'remove',
              key,
              (await adapter.remove?.(key, o)) ??
                failure('invalid', 'remove is not supported.')
            ),
        }),
    ...(adapter.subscribe === undefined
      ? {}
      : { subscribe: adapter.subscribe.bind(adapter) }),
  };
}
