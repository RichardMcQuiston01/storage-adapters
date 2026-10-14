/**
 * A `StorageAdapter` over `localStorage`. This is the only part of the package that
 * touches a browser global, so it ships as the optional `/browser` entry point and
 * the core stays free of I/O.
 */
import type {
  StorageAdapter,
  StoredValue,
  StoreErrorCode,
  StoreResult,
} from '../storage.js';

/** The subset of the Web Storage API this adapter uses. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The parts of a `storage` event this adapter reads. */
export interface StorageChangeEvent {
  readonly key: string | null;
  readonly newValue: string | null;
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

export interface LocalStorageAdapterOptions {
  /** Defaults to the global `localStorage`. */
  readonly storage?: WebStorageLike;
  /** Defaults to the global `window`. Without one, `subscribe` does nothing. */
  readonly events?: StorageEventTarget;
}

/** What is written to Web Storage: the value plus a counter used as its revision. */
interface Envelope {
  readonly r: string;
  readonly v: string;
}

/** The globals this adapter falls back to, typed without the DOM library. */
interface BrowserScope {
  readonly localStorage?: WebStorageLike;
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

function failure<T>(
  code: StoreErrorCode,
  key: string,
  detail: string
): StoreResult<T> {
  return { ok: false, code, error: `localStorage ${detail} for key "${key}"` };
}

/**
 * A `StorageAdapter` over `localStorage` (or any Web Storage object). Each value is
 * stored with a counter revision, so `set` with `ifRevision` reports `conflict` when
 * another tab wrote first, and `subscribe` reports changes made in other tabs.
 * Nothing throws: every failure is a `StoreResult`.
 */
export function localStorageAdapter(
  options: LocalStorageAdapterOptions = {}
): StorageAdapter {
  const scope = globalThis as BrowserScope;

  const resolveStorage = (): WebStorageLike | null => {
    try {
      return options.storage ?? scope.localStorage ?? null;
    } catch {
      // Reading `localStorage` itself throws when storage is blocked.
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
        storage.setItem(key, JSON.stringify(envelope));
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
