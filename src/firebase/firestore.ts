/**
 * A `StorageAdapter` over Cloud Firestore, for apps that already run on Firebase.
 * Like `/redis`, this is an optional entry point that imports no SDK: you connect
 * with the Firebase Admin SDK (`@google-cloud/firestore`) or the web SDK
 * (`firebase/firestore`), wrap it with `firestoreStoreFromAdmin` or
 * `firestoreStoreFromWebSdk`, and pass the result in. Security rules (or IAM, for
 * the Admin SDK) stay your job.
 */
import { describeUnknownError } from '../errors.js';
import { createChangeListeners, sqlFailure } from '../sql-shared.js';
import {
  compareKeys,
  keysWithPrefix,
  prefixFailure,
  utf8Length,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/* ------------------------------------------------------------------ */
/* The store this adapter talks to                                     */
/* ------------------------------------------------------------------ */

/** The fields of a stored document, as Firestore holds them. */
export type FirestoreFields = Readonly<Record<string, unknown>>;

/**
 * What a transaction decided after reading the document: the `result` to hand
 * back, and optionally a `write` (the new fields, or `'delete'`). It may run more
 * than once, because Firestore retries a transaction that lost a race, so it must
 * not have side effects.
 */
export interface FirestoreDecision<T> {
  readonly result: T;
  readonly write?: FirestoreFields | 'delete';
}

/**
 * The calls the adapter makes on Firestore, in terms of one collection. The
 * wrappers below make one from either SDK; write your own for anything else.
 */
export interface FirestoreStoreLike {
  /** The fields of the document, or `null` when it does not exist. */
  get(documentId: string): Promise<FirestoreFields | null>;
  /**
   * Reads the document and applies the decision in one transaction, so the
   * revision check and the write cannot be separated by another writer.
   */
  transact<T>(
    documentId: string,
    decide: (current: FirestoreFields | null) => FirestoreDecision<T>
  ): Promise<T>;
  /** The `key` of every document whose key starts with `prefix`. */
  listKeys?(prefix: string): Promise<string[]>;
  /**
   * Calls `onData` with the document's fields (or `null`) now and on each change,
   * including changes other clients make. Returns the function that stops it.
   */
  watch?(
    documentId: string,
    onData: (fields: FirestoreFields | null) => void,
    onError: (error: unknown) => void
  ): () => void;
}

export interface FirestoreAdapterOptions {
  /** The collection, wrapped by `firestoreStoreFromAdmin` or `firestoreStoreFromWebSdk`. */
  readonly store: FirestoreStoreLike;
  /** The time for `created_at` and `updated_at`. Defaults to the system clock. */
  readonly now?: () => Date;
  /**
   * Called when a listener that `subscribe` started stops with an error (rules
   * that refuse reads, a lost connection the SDK gives up on). The subscriber
   * hears nothing more for that key until it subscribes again.
   */
  readonly onWatchError?: (key: string, message: string) => void;
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

const LABEL = 'Firestore';

/** What a `set` transaction found. */
type WriteOutcome =
  | { readonly kind: 'written'; readonly revision: string }
  | { readonly kind: 'conflict'; readonly revision: string }
  | { readonly kind: 'corrupt' };

/** Firestore document ids are at most 1,500 bytes. */
const MAX_DOCUMENT_ID_BYTES = 1500;
/** A document is at most 1 MiB; leave room for the other fields and the key. */
const MAX_VALUE_BYTES = 1_000_000;

/**
 * The document id for a key. Firestore ids cannot contain `/`, cannot be `.` or
 * `..`, and cannot look like `__name__`, and keys can be anything, so every
 * character except letters, digits and `-` is written as `%XX`. The key itself is
 * kept in the `key` field, so nothing depends on decoding this. Returns null for a
 * key Firestore cannot hold (empty, a lone surrogate, too long).
 */
export function firestoreDocumentId(key: string): string | null {
  if (key === '') {
    return null;
  }
  let encoded: string;
  try {
    encoded = encodeURIComponent(key);
  } catch {
    return null; // A lone surrogate is not valid text.
  }
  const id: string = encoded.replace(
    /[!'()*~._]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  );
  return id.length > MAX_DOCUMENT_ID_BYTES ? null : id;
}

/**
 * The smallest string greater than every string that starts with `prefix`, in
 * Firestore's order (code points, which is also UTF-8 byte order), or null when
 * no such string exists. Together with `>= prefix` it bounds a prefix query.
 */
export function firestorePrefixUpperBound(prefix: string): string | null {
  const points: string[] = [...prefix];
  while (points.length > 0) {
    const last: string = points.pop() ?? '';
    const code: number = last.codePointAt(0) ?? 0;
    if (code < 0x10ffff) {
      // Skip the surrogate range, which no valid string contains.
      const next: number = code === 0xd7ff ? 0xe000 : code + 1;
      return points.join('') + String.fromCodePoint(next);
    }
  }
  return null;
}

interface Entry {
  readonly key: string;
  readonly value: string;
  readonly revision: number;
  readonly createdAt: string | null;
}

/** Reads a document's fields as an entry, or null if they are not one. */
function entryFrom(fields: FirestoreFields): Entry | null {
  const { key, value, revision, created_at: createdAt } = fields;
  if (
    typeof key !== 'string' ||
    typeof value !== 'string' ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    return null;
  }
  return {
    key,
    value,
    revision,
    createdAt: typeof createdAt === 'string' ? createdAt : null,
  };
}

function storedFrom(fields: FirestoreFields): StoredValue | null {
  const entry: Entry | null = entryFrom(fields);
  return entry === null
    ? null
    : { value: entry.value, revision: String(entry.revision) };
}

/** Maps an SDK error (`permission-denied`, or a gRPC status number) to a code. */
function classifyError(error: unknown): StoreErrorCode {
  const code: unknown =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  const name: string =
    typeof code === 'string'
      ? code.toLowerCase().replace(/^firestore\//, '')
      : '';
  if (
    name === 'permission-denied' ||
    name === 'unauthenticated' ||
    code === 7 ||
    code === 16
  ) {
    return 'forbidden';
  }
  if (name === 'resource-exhausted' || code === 8) {
    return 'quota';
  }
  if (name === 'invalid-argument' || code === 3) {
    return 'invalid';
  }
  return 'unavailable';
}

function failedWith<T>(
  error: unknown,
  key: string,
  verb: string
): StoreResult<T> {
  return sqlFailure(
    LABEL,
    classifyError(error),
    key,
    `could not be ${verb} (${describeUnknownError(error)})`
  );
}

/* ------------------------------------------------------------------ */
/* The adapter                                                         */
/* ------------------------------------------------------------------ */

/**
 * A `StorageAdapter` with one Firestore document per key, holding the `key`, the
 * `value`, a counter `revision`, and `created_at` and `updated_at` (ISO text). A
 * transaction reads the document and writes it, so `set` with `ifRevision`
 * reports `conflict` when another client wrote first, and a key with nothing
 * stored is created. `subscribe` reports your own writes and, because it
 * listens to the document, changes other clients make. Nothing throws: every
 * failure is a `StoreResult`.
 */
export function firestoreAdapter(
  options: FirestoreAdapterOptions
): StorageAdapter {
  const { store } = options;
  const now: () => Date = options.now ?? ((): Date => new Date());
  const listeners = createChangeListeners();
  /** The revision last reported for each watched key (null: reported removed). */
  const reported = new Map<string, string | null>();
  const watchers = new Map<string, () => void>();
  /** The last write queued for each document, so writes to one key run in turn. */
  const writeTails = new Map<string, Promise<void>>();

  /**
   * Runs `write` after the writes already queued for this document. Firestore
   * transactions that read and then write one document wait on each other's locks
   * and retry with a back-off, so many at once can take seconds; in turn, each takes
   * one round trip. Writers in other processes still race, and the SDK retries those.
   */
  const queued = <T>(
    documentId: string,
    write: () => Promise<T>
  ): Promise<T> => {
    const previous: Promise<void> =
      writeTails.get(documentId) ?? Promise.resolve();
    const result: Promise<T> = previous.then(write);
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined
    );
    writeTails.set(documentId, tail);
    void tail.then(() => {
      if (writeTails.get(documentId) === tail) {
        writeTails.delete(documentId);
      }
    });
    return result;
  };

  /** Why this call cannot go ahead, or null if it can. */
  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): { readonly id: string } | StoreResult<T> => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    const id: string | null = firestoreDocumentId(key);
    if (id === null) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        'cannot be used as a key: it must not be empty, must be valid text and must be shorter than a Firestore document id allows'
      );
    }
    return { id };
  };

  /** Tells subscribers, once per change, whichever way the change reached us. */
  const report = (key: string, stored: StoredValue | null): void => {
    const revision: string | null = stored?.revision ?? null;
    if (reported.has(key) && reported.get(key) === revision) {
      return;
    }
    if (watchers.has(key)) {
      reported.set(key, revision);
    }
    listeners.notify(key, stored);
  };

  const startWatching = (key: string, id: string): void => {
    if (store.watch === undefined || watchers.has(key)) {
      return;
    }
    let baselined = false;
    try {
      const stop: () => void = store.watch(
        id,
        (fields) => {
          const stored: StoredValue | null =
            fields === null ? null : storedFrom(fields);
          if (!baselined) {
            baselined = true; // What is there now is not a change.
            if (!reported.has(key)) {
              reported.set(key, stored?.revision ?? null);
            }
            return;
          }
          report(key, stored);
        },
        (error) => {
          options.onWatchError?.(
            key,
            `${LABEL} stopped listening for key "${key}" (${describeUnknownError(error)})`
          );
        }
      );
      watchers.set(key, stop);
    } catch (error: unknown) {
      options.onWatchError?.(
        key,
        `${LABEL} could not listen for key "${key}" (${describeUnknownError(error)})`
      );
    }
  };

  return {
    async get(key, { signal }) {
      const checked = refusal<StoredValue | null>(key, signal);
      if (!('id' in checked)) {
        return checked;
      }
      try {
        const fields: FirestoreFields | null = await store.get(checked.id);
        if (fields === null) {
          return { ok: true, value: null };
        }
        const stored: StoredValue | null = storedFrom(fields);
        return stored === null
          ? sqlFailure(
              LABEL,
              'corrupt',
              key,
              'holds a document that is not a stored entry'
            )
          : { ok: true, value: stored };
      } catch (error: unknown) {
        return failedWith(error, key, 'read');
      }
    },

    async set(key, value, { signal, ifRevision }) {
      const checked = refusal<StoredValue>(key, signal);
      if (!('id' in checked)) {
        return checked;
      }
      if (utf8Length(value) > MAX_VALUE_BYTES) {
        return sqlFailure(
          LABEL,
          'invalid',
          key,
          `cannot hold a value of ${utf8Length(value)} bytes: a Firestore document is limited to about 1 MiB`
        );
      }
      try {
        const outcome: WriteOutcome = await queued(checked.id, () =>
          store.transact<WriteOutcome>(
            checked.id,
            (current): FirestoreDecision<WriteOutcome> => {
              const entry: Entry | null =
                current === null ? null : entryFrom(current);
              if (
                current !== null &&
                entry === null &&
                ifRevision !== undefined
              ) {
                return {
                  result: { kind: 'corrupt' as const },
                };
              }
              if (
                entry !== null &&
                ifRevision !== undefined &&
                String(entry.revision) !== ifRevision
              ) {
                return {
                  result: {
                    kind: 'conflict' as const,
                    revision: String(entry.revision),
                  },
                };
              }
              const stamp: string = now().toISOString();
              const revision: number = (entry?.revision ?? 0) + 1;
              return {
                result: {
                  kind: 'written' as const,
                  revision: String(revision),
                },
                write: {
                  key,
                  value,
                  revision,
                  created_at: entry?.createdAt ?? stamp,
                  updated_at: stamp,
                },
              };
            }
          )
        );
        if (outcome.kind === 'corrupt') {
          return sqlFailure(
            LABEL,
            'corrupt',
            key,
            'holds a document that is not a stored entry, so its revision cannot be checked'
          );
        }
        if (outcome.kind === 'conflict') {
          return sqlFailure(
            LABEL,
            'conflict',
            key,
            `holds revision ${outcome.revision}, but revision ${ifRevision ?? ''} was expected`
          );
        }
        const stored: StoredValue = { value, revision: outcome.revision };
        report(key, stored);
        return { ok: true, value: stored };
      } catch (error: unknown) {
        return failedWith(error, key, 'written');
      }
    },

    async remove(key, { signal }) {
      const checked = refusal<null>(key, signal);
      if (!('id' in checked)) {
        return checked;
      }
      try {
        await queued(checked.id, () =>
          store.transact(checked.id, () => ({
            result: null,
            write: 'delete' as const,
          }))
        );
      } catch (error: unknown) {
        return failedWith(error, key, 'removed');
      }
      report(key, null);
      return { ok: true, value: null };
    },

    async list(prefix, { signal }) {
      if (signal.aborted) {
        return prefixFailure(
          LABEL,
          'unavailable',
          prefix,
          'request to list keys was aborted'
        );
      }
      if (store.listKeys === undefined) {
        return prefixFailure(
          LABEL,
          'invalid',
          prefix,
          'cannot list keys: the store has no listKeys'
        );
      }
      try {
        const keys: string[] = await store.listKeys(prefix);
        return {
          ok: true,
          value: keysWithPrefix(keys, prefix).sort(compareKeys),
        };
      } catch (error: unknown) {
        return prefixFailure(
          LABEL,
          classifyError(error),
          prefix,
          `could not list keys (${describeUnknownError(error)})`
        );
      }
    },

    subscribe: (key, onChange) => {
      const stopListening: () => void = listeners.subscribe(key, onChange);
      const id: string | null = firestoreDocumentId(key);
      if (id !== null) {
        startWatching(key, id);
      }
      return () => {
        stopListening();
        if (!listeners.has(key)) {
          watchers.get(key)?.();
          watchers.delete(key);
          reported.delete(key);
        }
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* The Firebase Admin SDK (@google-cloud/firestore)                    */
/* ------------------------------------------------------------------ */

/** A document snapshot from the Admin SDK. */
export interface AdminSnapshotLike {
  readonly exists: boolean;
  data(): FirestoreFields | undefined;
}

export interface AdminDocumentLike {
  get(): Promise<AdminSnapshotLike>;
  onSnapshot(
    onNext: (snapshot: AdminSnapshotLike) => void,
    onError: (error: Error) => void
  ): () => void;
}

export interface AdminQueryLike {
  where(field: string, operator: '>=' | '<', value: string): AdminQueryLike;
  select(...fields: string[]): AdminQueryLike;
  get(): Promise<{ readonly docs: readonly AdminSnapshotLike[] }>;
}

export interface AdminCollectionLike extends AdminQueryLike {
  doc(documentId: string): AdminDocumentLike;
}

export interface AdminTransactionLike {
  get(document: AdminDocumentLike): Promise<AdminSnapshotLike>;
  set(document: AdminDocumentLike, data: FirestoreFields): unknown;
  delete(document: AdminDocumentLike): unknown;
}

/** The `Firestore` instance from `@google-cloud/firestore` or `firebase-admin`. */
export interface AdminFirestoreLike {
  collection(path: string): AdminCollectionLike;
  runTransaction<T>(
    update: (transaction: AdminTransactionLike) => Promise<T>
  ): Promise<T>;
}

export interface AdminStoreOptions {
  readonly firestore: AdminFirestoreLike;
  /** The collection that holds the documents. Defaults to `storage_entry`. */
  readonly collection?: string;
}

const DEFAULT_COLLECTION = 'storage_entry';

function snapshotFields(snapshot: AdminSnapshotLike): FirestoreFields | null {
  return snapshot.exists ? (snapshot.data() ?? null) : null;
}

/** Wraps a Firestore instance from the Admin SDK (or `@google-cloud/firestore`). */
export function firestoreStoreFromAdmin(
  options: AdminStoreOptions
): FirestoreStoreLike {
  const { firestore } = options;
  const collection: AdminCollectionLike = firestore.collection(
    options.collection ?? DEFAULT_COLLECTION
  );
  return {
    get: async (documentId) =>
      snapshotFields(await collection.doc(documentId).get()),
    transact: (documentId, decide) =>
      firestore.runTransaction(async (transaction) => {
        const document: AdminDocumentLike = collection.doc(documentId);
        const decision = decide(
          snapshotFields(await transaction.get(document))
        );
        if (decision.write === 'delete') {
          transaction.delete(document);
        } else if (decision.write !== undefined) {
          transaction.set(document, decision.write);
        }
        return decision.result;
      }),
    listKeys: async (prefix) => {
      let query: AdminQueryLike = collection
        .where('key', '>=', prefix)
        .select('key');
      const upper: string | null = firestorePrefixUpperBound(prefix);
      if (upper !== null) {
        query = query.where('key', '<', upper);
      }
      const keys: string[] = [];
      for (const snapshot of (await query.get()).docs) {
        const key: unknown = snapshot.data()?.key;
        if (typeof key === 'string') {
          keys.push(key);
        }
      }
      return keys;
    },
    watch: (documentId, onData, onError) =>
      collection.doc(documentId).onSnapshot((snapshot) => {
        onData(snapshotFields(snapshot));
      }, onError),
  };
}

/* ------------------------------------------------------------------ */
/* The web SDK (firebase/firestore)                                    */
/* ------------------------------------------------------------------ */

/** A document snapshot from the web SDK. */
export interface WebSnapshotLike {
  exists(): boolean;
  data(): FirestoreFields | undefined;
}

/**
 * The functions of `firebase/firestore` the adapter uses, passed in so that the
 * package imports nothing: `import * as firestoreSdk from 'firebase/firestore'`.
 * References and queries are opaque to the adapter.
 */
export interface WebSdkLike {
  collection(firestore: unknown, path: string): unknown;
  doc(collection: unknown, documentId: string): unknown;
  getDoc(document: unknown): Promise<WebSnapshotLike>;
  getDocs(query: unknown): Promise<{
    readonly docs: readonly WebSnapshotLike[];
  }>;
  onSnapshot(
    document: unknown,
    onNext: (snapshot: WebSnapshotLike) => void,
    onError: (error: Error) => void
  ): () => void;
  query(collection: unknown, ...constraints: unknown[]): unknown;
  where(field: string, operator: '>=' | '<', value: string): unknown;
  runTransaction<T>(
    firestore: unknown,
    update: (transaction: WebTransactionLike) => Promise<T>
  ): Promise<T>;
}

export interface WebTransactionLike {
  get(document: unknown): Promise<WebSnapshotLike>;
  set(document: unknown, data: FirestoreFields): unknown;
  delete(document: unknown): unknown;
}

export interface WebStoreOptions {
  /** The `Firestore` instance from `getFirestore()`. */
  readonly firestore: unknown;
  /** The module `firebase/firestore`. */
  readonly sdk: WebSdkLike;
  /** The collection that holds the documents. Defaults to `storage_entry`. */
  readonly collection?: string;
}

function webFields(snapshot: WebSnapshotLike): FirestoreFields | null {
  return snapshot.exists() ? (snapshot.data() ?? null) : null;
}

/** Wraps the web SDK (`firebase/firestore`), in a browser or in Node. */
export function firestoreStoreFromWebSdk(
  options: WebStoreOptions
): FirestoreStoreLike {
  const { firestore, sdk } = options;
  const collection: unknown = sdk.collection(
    firestore,
    options.collection ?? DEFAULT_COLLECTION
  );
  return {
    get: async (documentId) =>
      webFields(await sdk.getDoc(sdk.doc(collection, documentId))),
    transact: (documentId, decide) =>
      sdk.runTransaction(firestore, async (transaction) => {
        const document: unknown = sdk.doc(collection, documentId);
        const decision = decide(webFields(await transaction.get(document)));
        if (decision.write === 'delete') {
          transaction.delete(document);
        } else if (decision.write !== undefined) {
          transaction.set(document, decision.write);
        }
        return decision.result;
      }),
    listKeys: async (prefix) => {
      const upper: string | null = firestorePrefixUpperBound(prefix);
      const constraints: unknown[] = [sdk.where('key', '>=', prefix)];
      if (upper !== null) {
        constraints.push(sdk.where('key', '<', upper));
      }
      const keys: string[] = [];
      for (const snapshot of (
        await sdk.getDocs(sdk.query(collection, ...constraints))
      ).docs) {
        const key: unknown = snapshot.data()?.key;
        if (typeof key === 'string') {
          keys.push(key);
        }
      }
      return keys;
    },
    watch: (documentId, onData, onError) =>
      sdk.onSnapshot(
        sdk.doc(collection, documentId),
        (snapshot) => {
          onData(webFields(snapshot));
        },
        onError
      ),
  };
}
