/**
 * A `StorageAdapter` over IndexedDB, for values too large or too many for
 * `localStorage`. Like `/browser`, this is an optional entry point: the core stays
 * free of I/O, and every browser global is read through a typed cast and can be
 * replaced through the options.
 */
import { describeUnknownError } from '../errors.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreErrorCode,
  StoreResult,
} from '../storage.js';

/*
 * Minimal structural types for the parts of IndexedDB this adapter uses, so it
 * builds without the DOM library. The real `indexedDB` object satisfies them.
 * Handlers are typed `(event: never) => void` so the DOM's `Event`-taking handler
 * types stay assignable; this adapter never reads the event.
 */

export interface IdbRequestLike<T> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: ((event: never) => void) | null;
  onerror: ((event: never) => void) | null;
}

export interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: ((event: never) => void) | null;
  onblocked: ((event: never) => void) | null;
}

export interface IdbObjectStoreLike {
  get(key: string): IdbRequestLike<unknown>;
  put(value: unknown, key: string): IdbRequestLike<unknown>;
  delete(key: string): IdbRequestLike<unknown>;
}

export interface IdbTransactionLike {
  readonly error: unknown;
  oncomplete: ((event: never) => void) | null;
  onerror: ((event: never) => void) | null;
  onabort: ((event: never) => void) | null;
  objectStore(name: string): IdbObjectStoreLike;
  abort(): void;
}

export interface IdbDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  onversionchange: ((event: never) => void) | null;
  createObjectStore(name: string): unknown;
  transaction(
    storeName: string,
    mode: 'readonly' | 'readwrite'
  ): IdbTransactionLike;
  close(): void;
}

/** The subset of `indexedDB` (an `IDBFactory`) this adapter uses. */
export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
}

/** The subset of `BroadcastChannel` used to hear about changes from other tabs. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { readonly data: unknown }) => void
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: { readonly data: unknown }) => void
  ): void;
  close(): void;
}

export interface IndexedDbAdapterOptions {
  /** Defaults to the global `indexedDB`. */
  readonly factory?: IdbFactoryLike;
  /** Defaults to `"storage-adapters"`. */
  readonly databaseName?: string;
  /** Defaults to `"entry"`. */
  readonly storeName?: string;
  /**
   * Used to tell other tabs about writes. Defaults to a `BroadcastChannel` named
   * after the database. Without one, `subscribe` does nothing. A channel you pass
   * in is yours to close.
   */
  readonly channel?: BroadcastChannelLike;
}

/** What is stored per key: the value plus a counter used as its revision. */
interface StoredRecord {
  readonly r: string;
  readonly v: string;
}

/** The globals this adapter falls back to, typed without the DOM library. */
interface BrowserScope {
  readonly indexedDB?: IdbFactoryLike;
  readonly BroadcastChannel?: new (name: string) => BroadcastChannelLike;
}

const DEFAULT_DATABASE_NAME = 'storage-adapters';
const DEFAULT_STORE_NAME = 'entry';
const DATABASE_VERSION = 1;

/** `null` when nothing is stored, `undefined` when what is stored is not a record. */
function parseRecord(raw: unknown): StoredRecord | null | undefined {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === 'object') {
    const candidate = raw as Partial<StoredRecord>;
    if (typeof candidate.r === 'string' && typeof candidate.v === 'string') {
      return { r: candidate.r, v: candidate.v };
    }
  }
  return undefined;
}

function classifyError(error: unknown): StoreErrorCode {
  const name: string =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return 'quota';
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return 'forbidden';
  }
  return 'unavailable';
}

function failure<T>(
  code: StoreErrorCode,
  key: string,
  detail: string
): StoreResult<T> {
  return { ok: false, code, error: `IndexedDB ${detail} for key "${key}"` };
}

/** A database that could not be opened, before it is tied to a key. */
interface OpenFailure {
  readonly code: StoreErrorCode;
  readonly detail: string;
}

type OpenResult =
  | { readonly ok: true; readonly database: IdbDatabaseLike }
  | ({ readonly ok: false } & OpenFailure);

/**
 * A `StorageAdapter` over IndexedDB. Each value is stored with a counter revision,
 * and the revision check and the write happen in one transaction, so `set` with
 * `ifRevision` reports `conflict` when another tab wrote first. `subscribe`
 * reports changes made by other tabs (or other adapters on the same page).
 * Nothing throws: every failure is a `StoreResult`.
 */
export function indexedDbAdapter(
  options: IndexedDbAdapterOptions = {}
): StorageAdapter {
  // Via `unknown`: some type environments (Node) declare their own BroadcastChannel.
  const scope = globalThis as unknown as BrowserScope;
  const databaseName: string = options.databaseName ?? DEFAULT_DATABASE_NAME;
  const storeName: string = options.storeName ?? DEFAULT_STORE_NAME;

  let databasePromise: Promise<OpenResult> | null = null;
  let channel: BroadcastChannelLike | null = options.channel ?? null;

  const resolveFactory = (): IdbFactoryLike | null => {
    try {
      return options.factory ?? scope.indexedDB ?? null;
    } catch {
      // Reading `indexedDB` itself throws when storage is blocked.
      return null;
    }
  };

  const openDatabase = (): Promise<OpenResult> => {
    const factory: IdbFactoryLike | null = resolveFactory();
    if (factory === null) {
      return Promise.resolve({
        ok: false,
        code: 'unavailable',
        detail: 'is not available',
      });
    }
    return new Promise<OpenResult>((resolve) => {
      let request: IdbOpenRequestLike;
      try {
        request = factory.open(databaseName, DATABASE_VERSION);
      } catch (error: unknown) {
        resolve({
          ok: false,
          code: classifyError(error),
          detail: `could not be opened (${describeUnknownError(error)})`,
        });
        return;
      }
      request.onupgradeneeded = (): void => {
        try {
          const database: IdbDatabaseLike = request.result;
          if (!database.objectStoreNames.contains(storeName)) {
            database.createObjectStore(storeName);
          }
        } catch (error: unknown) {
          resolve({
            ok: false,
            code: classifyError(error),
            detail: `could not be set up (${describeUnknownError(error)})`,
          });
        }
      };
      request.onsuccess = (): void => {
        const database: IdbDatabaseLike = request.result;
        // Let another tab upgrade the database instead of blocking it.
        database.onversionchange = (): void => {
          database.close();
          databasePromise = null;
        };
        resolve({ ok: true, database });
      };
      request.onerror = (): void => {
        resolve({
          ok: false,
          code: classifyError(request.error),
          detail: `could not be opened (${describeUnknownError(request.error)})`,
        });
      };
    });
  };

  const getDatabase = async (): Promise<OpenResult> => {
    databasePromise ??= openDatabase();
    const result: OpenResult = await databasePromise;
    if (!result.ok) {
      // Do not remember a failure: the next call tries again.
      databasePromise = null;
    }
    return result;
  };

  /**
   * Runs `work` inside one transaction. `work` reports its outcome through
   * `settle`; the promise resolves once the transaction has committed, so a
   * success means the data is durable, and any abort becomes a failure.
   */
  const transact = async <T>(
    key: string,
    mode: 'readonly' | 'readwrite',
    verb: string,
    work: (
      store: IdbObjectStoreLike,
      settle: (outcome: StoreResult<T>) => void
    ) => void
  ): Promise<StoreResult<T>> => {
    const opened: OpenResult = await getDatabase();
    if (!opened.ok) {
      return failure(opened.code, key, opened.detail);
    }
    return new Promise<StoreResult<T>>((resolve) => {
      let outcome: StoreResult<T> | null = null;
      let finished = false;
      const finish = (result: StoreResult<T>): void => {
        if (!finished) {
          finished = true;
          resolve(result);
        }
      };
      let transaction: IdbTransactionLike;
      try {
        transaction = opened.database.transaction(storeName, mode);
      } catch (error: unknown) {
        // The connection may have been closed under us; reopen next time.
        databasePromise = null;
        finish(
          failure(
            classifyError(error),
            key,
            `could not start a transaction (${describeUnknownError(error)})`
          )
        );
        return;
      }
      transaction.oncomplete = (): void => {
        finish(
          outcome ??
            failure('unavailable', key, `finished without a result (${verb})`)
        );
      };
      const aborted = (): void => {
        finish(
          failure(
            classifyError(transaction.error),
            key,
            `could not be ${verb} (${describeUnknownError(transaction.error)})`
          )
        );
      };
      transaction.onerror = aborted;
      transaction.onabort = aborted;
      try {
        work(transaction.objectStore(storeName), (result) => {
          outcome = result;
        });
      } catch (error: unknown) {
        finish(
          failure(
            classifyError(error),
            key,
            `could not be ${verb} (${describeUnknownError(error)})`
          )
        );
        try {
          transaction.abort();
        } catch {
          // Already finished; nothing to undo.
        }
      }
    });
  };

  const stopped = <T>(
    key: string,
    signal: AbortSignal
  ): StoreResult<T> | null =>
    signal.aborted ? failure('unavailable', key, 'request was aborted') : null;

  const getChannel = (): BroadcastChannelLike | null => {
    if (channel !== null) {
      return channel;
    }
    try {
      const Channel = scope.BroadcastChannel;
      channel = Channel === undefined ? null : new Channel(databaseName);
    } catch {
      channel = null;
    }
    return channel;
  };

  const announce = (key: string): void => {
    try {
      getChannel()?.postMessage({ key });
    } catch {
      // Other tabs miss one update; the write itself succeeded.
    }
  };

  const adapter: StorageAdapter = {
    async get(key, { signal }) {
      const abortedResult = stopped<StoredValue | null>(key, signal);
      if (abortedResult !== null) {
        return abortedResult;
      }
      return transact<StoredValue | null>(
        key,
        'readonly',
        'read',
        (store, settle) => {
          const request = store.get(key);
          request.onsuccess = (): void => {
            const record: StoredRecord | null | undefined = parseRecord(
              request.result
            );
            settle(
              record === undefined
                ? failure(
                    'corrupt',
                    key,
                    'holds a value that is not a stored record'
                  )
                : {
                    ok: true,
                    value:
                      record === null
                        ? null
                        : { value: record.v, revision: record.r },
                  }
            );
          };
        }
      );
    },

    async set(key, value, { signal, ifRevision }) {
      const abortedResult = stopped<StoredValue>(key, signal);
      if (abortedResult !== null) {
        return abortedResult;
      }
      const result: StoreResult<StoredValue> = await transact<StoredValue>(
        key,
        'readwrite',
        'written',
        (store, settle) => {
          const request = store.get(key);
          request.onsuccess = (): void => {
            // A corrupt value is replaced, so it counts as nothing stored.
            const parsed: StoredRecord | null | undefined = parseRecord(
              request.result
            );
            const existing: StoredRecord | null = parsed ?? null;
            if (
              ifRevision !== undefined &&
              existing !== null &&
              existing.r !== ifRevision
            ) {
              settle(
                failure(
                  'conflict',
                  key,
                  `holds revision ${existing.r}, but revision ${ifRevision} was expected`
                )
              );
              return;
            }
            const revision: string = String((Number(existing?.r) || 0) + 1);
            store.put({ r: revision, v: value } satisfies StoredRecord, key);
            settle({ ok: true, value: { value, revision } });
          };
        }
      );
      if (result.ok) {
        announce(key);
      }
      return result;
    },

    async remove(key, { signal }) {
      const abortedResult = stopped<null>(key, signal);
      if (abortedResult !== null) {
        return abortedResult;
      }
      const result: StoreResult<null> = await transact<null>(
        key,
        'readwrite',
        'removed',
        (store, settle) => {
          store.delete(key);
          settle({ ok: true, value: null });
        }
      );
      if (result.ok) {
        announce(key);
      }
      return result;
    },

    subscribe(key, onChange) {
      const source: BroadcastChannelLike | null = getChannel();
      if (source === null) {
        return () => {};
      }
      const listener = (event: { readonly data: unknown }): void => {
        const data = event.data as { readonly key?: unknown } | null;
        if (typeof data !== 'object' || data === null || data.key !== key) {
          return;
        }
        // The message only names the key; read the current value from the database.
        void adapter
          .get(key, { signal: new AbortController().signal })
          .then((read) => {
            if (read.ok) {
              onChange(read.value);
            }
          });
      };
      source.addEventListener('message', listener);
      return () => {
        source.removeEventListener('message', listener);
      };
    },
  };
  return adapter;
}
