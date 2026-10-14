/**
 * Persistence for one kind of value over any `StorageAdapter`: a versioned
 * envelope, tolerant reads, a size limit, revision tracking with a conflict
 * policy, and saves serialized per key so rapid edits never race. The value
 * type, how it is read back and the envelope's field name are yours.
 */

import { describeUnknownError } from './errors.js';
import {
  failure,
  utf8Length,
  type StorageAdapter,
  type StoreResult,
  type StoredValue,
} from './storage.js';

/** Default largest serialized value (bytes). */
export const DEFAULT_MAX_BYTES = 64 * 1024;

export type ConflictPolicy<T> =
  /** Save anyway; the other device's change is lost. */
  | 'overwrite'
  /** Drop the local save and return what is stored. */
  | 'keep-theirs'
  /** Return `outcome: 'conflict'` and let the caller choose (default). */
  | 'ask'
  /** Merge, then save the result once. */
  | ((mine: T, theirs: T) => T);

export interface PersistenceOptions<T> {
  /**
   * Reads a stored payload back into a `T`, repairing what it can. Throw to
   * report a payload that can't be read (it becomes a `corrupt` error that
   * names the key). Also reads a bare value saved without an envelope.
   */
  readonly parse: (raw: unknown) => T;
  /** The JSON-serialisable form of a value. Default: the value itself. */
  readonly serialize?: (value: T) => unknown;
  /** Envelope version written. Newer stored versions are refused. Default 1. */
  readonly version?: number;
  /** The envelope field that holds the value. Default `'value'`. */
  readonly field?: string;
  /** What the value is called in error messages. Default `'value'`. */
  readonly label?: string;
  /** Default 64 KB. */
  readonly maxBytes?: number;
  /** For adapters with revisions. Default `'ask'`. */
  readonly onConflict?: ConflictPolicy<T>;
  /** Cancels every operation. */
  readonly signal?: AbortSignal;
  /** Epoch ms for the envelope's `savedAt`. Default `Date.now`. */
  readonly now?: () => number;
}

export interface Loaded<T> {
  /** Null when nothing is stored. */
  readonly value: T | null;
  readonly revision?: string;
  /** ISO time from the envelope; absent for a bare value. */
  readonly savedAt?: string;
}

export interface Saved<T> {
  /**
   * `saved`: stored (or merged, then stored). `kept-theirs`: the stored value
   * won and `value` is it. `conflict`: nothing was stored and `value` is the
   * stored one; decide, then save again with `force: true`.
   */
  readonly outcome: 'saved' | 'kept-theirs' | 'conflict';
  /** What is now stored (or, for `conflict`, what someone else stored). */
  readonly value: T;
  readonly revision?: string;
}

export interface LoadOptions {
  /**
   * Remember the revision for conflict detection on the next save. Default
   * true. Pass false for values you overwrite without checking (a backup).
   */
  readonly track?: boolean;
}

export interface SaveOptions {
  /** Skip conflict detection and overwrite. */
  readonly force?: boolean;
  /**
   * Default true. False writes straight through: no revision check, no
   * queueing, no conflict handling.
   */
  readonly track?: boolean;
}

export interface Persistence<T> {
  load(key: string, options?: LoadOptions): Promise<StoreResult<Loaded<T>>>;
  save(
    key: string,
    value: T,
    options?: SaveOptions
  ): Promise<StoreResult<Saved<T>>>;
  /** Removes a key. A missing key is fine; needs `adapter.remove`. */
  remove(key: string): Promise<StoreResult<null>>;
  /** Calls `onChange` when another tab or device changes the key; needs `adapter.subscribe`. */
  watch(key: string, onChange: (loaded: Loaded<T>) => void): () => void;
}

interface PendingSave<T> {
  value: T;
  force: boolean;
  readonly waiters: ((result: StoreResult<Saved<T>>) => void)[];
}

/** Persistence over `adapter`; see {@link PersistenceOptions}. */
export function createPersistence<T>(
  adapter: StorageAdapter,
  options: PersistenceOptions<T>
): Persistence<T> {
  const version: number = options.version ?? 1;
  const field: string = options.field ?? 'value';
  const label: string = options.label ?? 'value';
  const maxBytes: number = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const policy: ConflictPolicy<T> = options.onConflict ?? 'ask';
  const serialize: (value: T) => unknown =
    options.serialize ?? ((value: T): unknown => value);
  const signal: AbortSignal = options.signal ?? new AbortController().signal;
  const now: () => number = options.now ?? Date.now;
  const revisions = new Map<string, string>();
  const lastWritten = new Map<string, string>();
  const inFlight = new Set<string>();
  const pending = new Map<string, PendingSave<T>>();

  const guarded = async <R>(
    key: string,
    action: string,
    run: () => Promise<StoreResult<R>>
  ): Promise<StoreResult<R>> => {
    try {
      return await run();
    } catch (cause) {
      return failure(
        'unavailable',
        `Could not ${action} "${key}": the adapter threw ${describeUnknownError(cause)}`
      );
    }
  };

  const encode = (value: T, key: string): StoreResult<string> => {
    let text: string;
    try {
      text = JSON.stringify({
        v: version,
        savedAt: new Date(now()).toISOString(),
        [field]: serialize(value),
      });
    } catch (cause) {
      return failure(
        'invalid',
        `Could not save "${key}": the ${label} can't be serialized: ${describeUnknownError(cause)}`
      );
    }
    const size: number = utf8Length(text);
    if (size > maxBytes) {
      return failure(
        'invalid',
        `Could not save "${key}": the ${label} is ${size} bytes, over the ${maxBytes} byte limit.`
      );
    }
    return { ok: true, value: text };
  };

  const parseValue = (key: string, raw: unknown): StoreResult<T> => {
    try {
      return { ok: true, value: options.parse(raw) };
    } catch (cause) {
      return failure(
        'corrupt',
        `The ${label} stored at "${key}" could not be read: ${describeUnknownError(cause)}`
      );
    }
  };

  const decode = (
    key: string,
    stored: StoredValue
  ): StoreResult<{ value: T; savedAt?: string }> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored.value);
    } catch (cause) {
      return failure(
        'corrupt',
        `The ${label} stored at "${key}" is not valid JSON: ${describeUnknownError(cause)}`
      );
    }
    const isEnvelope: boolean =
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      'v' in parsed;
    if (!isEnvelope) {
      // A bare value saved without an envelope.
      const bare = parseValue(key, parsed);
      return bare.ok ? { ok: true, value: { value: bare.value } } : bare;
    }
    const record = parsed as Record<string, unknown>;
    const stamp: unknown = record['v'];
    if (typeof stamp !== 'number' || !Number.isInteger(stamp)) {
      return failure(
        'corrupt',
        `The ${label} stored at "${key}" has an invalid version ${JSON.stringify(stamp)}.`
      );
    }
    if (stamp > version) {
      return failure(
        'invalid',
        `The ${label} stored at "${key}" is version ${stamp}, newer than this code reads (${version}). Update the package.`
      );
    }
    const read = parseValue(key, record[field]);
    if (!read.ok) return read;
    const savedAt: unknown = record['savedAt'];
    return {
      ok: true,
      value: {
        value: read.value,
        ...(typeof savedAt === 'string' ? { savedAt } : {}),
      },
    };
  };

  const toLoaded = (
    key: string,
    stored: StoredValue
  ): StoreResult<Loaded<T>> => {
    const read = decode(key, stored);
    if (!read.ok) return read;
    return {
      ok: true,
      value: {
        value: read.value.value,
        ...(stored.revision === undefined ? {} : { revision: stored.revision }),
        ...(read.value.savedAt === undefined
          ? {}
          : { savedAt: read.value.savedAt }),
      },
    };
  };

  const read = async (
    key: string,
    track: boolean
  ): Promise<StoreResult<Loaded<T>>> => {
    const result = await guarded(key, 'load', () =>
      adapter.get(key, { signal })
    );
    if (!result.ok) return result;
    if (result.value === null) {
      if (track) revisions.delete(key);
      return { ok: true, value: { value: null } };
    }
    const loaded = toLoaded(key, result.value);
    if (loaded.ok && track && result.value.revision !== undefined) {
      revisions.set(key, result.value.revision);
    }
    return loaded;
  };

  const write = async (
    key: string,
    value: T,
    force: boolean
  ): Promise<StoreResult<Saved<T>>> => {
    const text = encode(value, key);
    if (!text.ok) return text;
    const known: string | undefined = revisions.get(key);
    lastWritten.set(key, text.value);
    const stored = await guarded(key, 'save', () =>
      adapter.set(key, text.value, {
        signal,
        ...(force || known === undefined ? {} : { ifRevision: known }),
      })
    );
    if (stored.ok) {
      if (stored.value.revision !== undefined) {
        revisions.set(key, stored.value.revision);
      }
      return {
        ok: true,
        value: {
          outcome: 'saved',
          value,
          ...(stored.value.revision === undefined
            ? {}
            : { revision: stored.value.revision }),
        },
      };
    }
    if (stored.code !== 'conflict') return stored;

    const theirs = await read(key, true);
    if (!theirs.ok) return theirs;
    const theirValue: T = theirs.value.value ?? value;
    const theirRevision: string | undefined = theirs.value.revision;
    const asResult = (outcome: Saved<T>['outcome']): StoreResult<Saved<T>> => ({
      ok: true,
      value: {
        outcome,
        value: theirValue,
        ...(theirRevision === undefined ? {} : { revision: theirRevision }),
      },
    });
    if (policy === 'overwrite') return write(key, value, true);
    if (policy === 'keep-theirs') return asResult('kept-theirs');
    if (policy === 'ask') return asResult('conflict');
    let merged: T;
    try {
      merged = policy(value, theirValue);
    } catch (cause) {
      return failure(
        'invalid',
        `Could not save "${key}": the conflict merge function threw ${describeUnknownError(cause)}`
      );
    }
    const second = await write(key, merged, false);
    if (second.ok && second.value.outcome === 'saved') return second;
    return second.ok ? asResult('conflict') : second;
  };

  const drain = async (key: string, first: PendingSave<T>): Promise<void> => {
    let job: PendingSave<T> | undefined = first;
    inFlight.add(key);
    while (job !== undefined) {
      const current: PendingSave<T> = job;
      pending.delete(key);
      const result = await write(key, current.value, current.force);
      for (const waiter of current.waiters) waiter(result);
      job = pending.get(key);
    }
    inFlight.delete(key);
  };

  return {
    load: (key, loadOptions = {}) => read(key, loadOptions.track !== false),
    save(key, value, saveOptions = {}) {
      if (saveOptions.track === false) {
        const text = encode(value, key);
        if (!text.ok) return Promise.resolve(text);
        return guarded(key, 'save', () =>
          adapter.set(key, text.value, { signal })
        ).then((stored): StoreResult<Saved<T>> =>
          stored.ok
            ? {
                ok: true,
                value: {
                  outcome: 'saved',
                  value,
                  ...(stored.value.revision === undefined
                    ? {}
                    : { revision: stored.value.revision }),
                },
              }
            : stored
        );
      }
      const force: boolean = saveOptions.force === true;
      return new Promise<StoreResult<Saved<T>>>((resolve) => {
        const queued: PendingSave<T> | undefined = pending.get(key);
        if (queued !== undefined) {
          // Newest wins: this value replaces the one that hasn't started.
          queued.value = value;
          queued.force = queued.force || force;
          queued.waiters.push(resolve);
          return;
        }
        const job: PendingSave<T> = { value, force, waiters: [resolve] };
        if (inFlight.has(key)) {
          pending.set(key, job);
          return;
        }
        void drain(key, job);
      });
    },
    async remove(key) {
      if (adapter.remove === undefined) {
        return failure(
          'invalid',
          `Could not remove "${key}": the adapter has no remove method.`
        );
      }
      const remove = adapter.remove.bind(adapter);
      revisions.delete(key);
      return guarded(key, 'remove', () => remove(key, { signal }));
    },
    watch(key, onChange) {
      const stop: (() => void) | undefined = adapter.subscribe?.(
        key,
        (stored) => {
          if (stored === null) {
            revisions.delete(key);
            onChange({ value: null });
            return;
          }
          if (
            stored.value === lastWritten.get(key) ||
            (stored.revision !== undefined &&
              stored.revision === revisions.get(key))
          ) {
            return; // Our own save echoing back.
          }
          const loaded = toLoaded(key, stored);
          if (loaded.ok) onChange(loaded.value);
        }
      );
      return stop ?? (() => undefined);
    },
  };
}
