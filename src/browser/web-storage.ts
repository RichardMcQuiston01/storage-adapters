/**
 * The shared implementation behind `localStorageAdapter` and `sessionStorageAdapter`.
 * This is the only part of the package that touches these browser globals, so it
 * ships as the optional `/browser` entry point and the core stays free of I/O.
 */
import {
  compareKeys,
  prefixFailure,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** The subset of the Web Storage API this adapter uses. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Optional, as on the real `Storage`: how many keys there are. Needed for `list`. */
  readonly length?: number;
  /** Optional, as on the real `Storage`: the key at a position. Needed for `list`. */
  key?(index: number): string | null;
}

/** The parts of a `storage` event this adapter reads. */
export interface StorageChangeEvent {
  readonly key: string | null;
  readonly newValue: string | null;
  /**
   * The storage that changed. Browsers set it, so an adapter ignores a change made
   * to a different storage (a `sessionStorage` write is not a `localStorage` one).
   */
  readonly storageArea?: unknown;
}

/** The subset of `window` used to hear about changes made in other tabs. */
export interface StorageEventTarget {
  addEventListener(
    type: 'storage',
    listener: (event: StorageChangeEvent) => void
  ): void;
  removeEventListener(
    type: 'storage',
    listener: (event: StorageChangeEvent) => void
  ): void;
}

export interface WebStorageAdapterOptions {
  /** Defaults to the global `localStorage` or `sessionStorage`, as the adapter needs. */
  readonly storage?: WebStorageLike;
  /** Defaults to the global `window`. Without one, `subscribe` does nothing. */
  readonly events?: StorageEventTarget;
}

/** Which Web Storage global an adapter wraps. It also names the storage in errors. */
export type WebStorageName = 'localStorage' | 'sessionStorage';

/** What is written to Web Storage: the value plus a counter used as its revision. */
interface Envelope {
  readonly r: string;
  readonly v: string;
}

/** The globals this adapter falls back to, typed without the DOM library. */
interface BrowserScope {
  readonly localStorage?: WebStorageLike;
  readonly sessionStorage?: WebStorageLike;
  readonly window?: StorageEventTarget;
}

/** `null` when nothing is stored, `undefined` when what is stored is not an envelope. */
function parseEnvelope(raw: string | null): Envelope | null | undefined {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope> | null;
    if (
      parsed !== null &&
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

function classifyError(error: unknown): StoreErrorCode {
  const name: string = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return 'quota';
  }
  if (name === 'SecurityError') {
    return 'forbidden';
  }
  return 'unavailable';
}

function failureFor<T>(
  name: WebStorageName,
  code: StoreErrorCode,
  key: string,
  detail: string
): StoreResult<T> {
  return { ok: false, code, error: `${name} ${detail} for key "${key}"` };
}

/**
 * A `StorageAdapter` over a Web Storage object. Each value is stored with a counter
 * revision, so `set` with `ifRevision` reports `conflict` when another document
 * wrote first, and `subscribe` reports changes made by other documents. Nothing
 * throws: every failure is a `StoreResult`.
 *
 * Web Storage has no compare-and-set, so the revision check is not atomic between
 * tabs: two tabs can both read the same revision and both write. Within one tab it
 * is exact. After writing, the adapter reads the key back and reports `conflict` if
 * another tab's write landed after its own, which narrows the gap but does not close
 * it. For writers that must never overwrite each other, use `indexedDbAdapter`,
 * whose check and write run in one transaction.
 */
export function webStorageAdapter(
  name: WebStorageName,
  options: WebStorageAdapterOptions = {}
): StorageAdapter {
  const scope = globalThis as BrowserScope;

  const failure = <T>(
    code: StoreErrorCode,
    key: string,
    detail: string
  ): StoreResult<T> => failureFor(name, code, key, detail);

  const resolveStorage = (): WebStorageLike | null => {
    try {
      return options.storage ?? scope[name] ?? null;
    } catch {
      // Reading the global itself throws when storage is blocked.
      return null;
    }
  };

  const read = (key: string): StoreResult<Envelope | null> => {
    const storage: WebStorageLike | null = resolveStorage();
    if (storage === null) {
      return failure('unavailable', key, 'is not available');
    }
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch (error: unknown) {
      return failure(
        classifyError(error),
        key,
        `could not be read (${String(error)})`
      );
    }
    const envelope: Envelope | null | undefined = parseEnvelope(raw);
    if (envelope === undefined) {
      return failure(
        'corrupt',
        key,
        'holds a value that is not a stored envelope'
      );
    }
    return { ok: true, value: envelope };
  };

  const aborted = <T>(
    key: string,
    signal: AbortSignal
  ): StoreResult<T> | null =>
    signal.aborted ? failure('unavailable', key, 'request was aborted') : null;

  return {
    get(key, { signal }) {
      const stopped: StoreResult<StoredValue | null> | null = aborted(
        key,
        signal
      );
      if (stopped !== null) {
        return Promise.resolve(stopped);
      }
      const result: StoreResult<Envelope | null> = read(key);
      if (!result.ok) {
        return Promise.resolve(result);
      }
      return Promise.resolve({
        ok: true,
        value:
          result.value === null
            ? null
            : { value: result.value.v, revision: result.value.r },
      });
    },

    set(key, value, { signal, ifRevision }) {
      const stopped: StoreResult<StoredValue> | null = aborted(key, signal);
      if (stopped !== null) {
        return Promise.resolve(stopped);
      }
      const current: StoreResult<Envelope | null> = read(key);
      // A corrupt value is replaced; an unreachable store is an error.
      if (!current.ok && current.code !== 'corrupt') {
        return Promise.resolve(current);
      }
      const existing: Envelope | null = current.ok ? current.value : null;
      if (
        ifRevision !== undefined &&
        existing !== null &&
        existing.r !== ifRevision
      ) {
        return Promise.resolve(
          failure(
            'conflict',
            key,
            `holds revision ${existing.r}, but revision ${ifRevision} was expected`
          )
        );
      }
      const revision: string = String((Number(existing?.r) || 0) + 1);
      const storage: WebStorageLike | null = resolveStorage();
      if (storage === null) {
        return Promise.resolve(failure('unavailable', key, 'is not available'));
      }
      try {
        const envelope: Envelope = { r: revision, v: value };
        const written: string = JSON.stringify(envelope);
        storage.setItem(key, written);
        // Web Storage has no compare-and-set, so another tab may have written
        // between our read and our write. If what is stored is not what we just
        // wrote, someone else's write landed after ours and ours is lost. This
        // narrows the gap; it cannot close it (see the note on the adapter).
        const stored: string | null = storage.getItem(key);
        if (stored !== written) {
          const winner: Envelope | null | undefined = parseEnvelope(stored);
          return Promise.resolve(
            failure(
              'conflict',
              key,
              winner === null || winner === undefined
                ? 'was changed by another tab while it was being written'
                : `was changed by another tab while it was being written; it now holds revision ${winner.r}`
            )
          );
        }
      } catch (error: unknown) {
        return Promise.resolve(
          failure(
            classifyError(error),
            key,
            `could not be written (${String(error)})`
          )
        );
      }
      return Promise.resolve({ ok: true, value: { value, revision } });
    },

    remove(key, { signal }) {
      const stopped: StoreResult<null> | null = aborted(key, signal);
      if (stopped !== null) {
        return Promise.resolve(stopped);
      }
      const storage: WebStorageLike | null = resolveStorage();
      if (storage === null) {
        return Promise.resolve(failure('unavailable', key, 'is not available'));
      }
      try {
        storage.removeItem(key);
      } catch (error: unknown) {
        return Promise.resolve(
          failure(
            classifyError(error),
            key,
            `could not be removed (${String(error)})`
          )
        );
      }
      return Promise.resolve({ ok: true, value: null });
    },

    list(prefix, { signal }) {
      if (signal.aborted) {
        return Promise.resolve(
          prefixFailure(
            name,
            'unavailable',
            prefix,
            'request to list keys was aborted'
          )
        );
      }
      const storage: WebStorageLike | null = resolveStorage();
      if (storage === null) {
        return Promise.resolve(
          prefixFailure(name, 'unavailable', prefix, 'is not available')
        );
      }
      if (typeof storage.length !== 'number' || storage.key === undefined) {
        return Promise.resolve(
          prefixFailure(
            name,
            'invalid',
            prefix,
            'cannot list keys: this storage has no length and key()'
          )
        );
      }
      try {
        const keys: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key: string | null = storage.key(index);
          // The storage is shared with the rest of the page, so only keys that hold
          // one of this adapter's envelopes count.
          if (
            key !== null &&
            key.startsWith(prefix) &&
            parseEnvelope(storage.getItem(key)) != null
          ) {
            keys.push(key);
          }
        }
        return Promise.resolve({ ok: true, value: keys.sort(compareKeys) });
      } catch (error: unknown) {
        return Promise.resolve(
          prefixFailure(
            name,
            classifyError(error),
            prefix,
            `could not list keys (${String(error)})`
          )
        );
      }
    },

    subscribe(key, onChange) {
      const target: StorageEventTarget | undefined =
        options.events ?? scope.window;
      if (target === undefined) {
        return () => {};
      }
      const listener = (event: StorageChangeEvent): void => {
        if (event.key !== key) {
          return;
        }
        // A change to the other kind of storage under the same key is not ours.
        if (
          event.storageArea !== undefined &&
          event.storageArea !== resolveStorage()
        ) {
          return;
        }
        const envelope: Envelope | null | undefined = parseEnvelope(
          event.newValue
        );
        if (envelope === undefined) {
          return;
        }
        onChange(
          envelope === null ? null : { value: envelope.v, revision: envelope.r }
        );
      };
      target.addEventListener('storage', listener);
      return () => {
        target.removeEventListener('storage', listener);
      };
    },
  };
}
