/**
 * A `StorageAdapter` over the Firebase Realtime Database, for apps that use it instead of
 * (or beside) Firestore. Like `/firebase`, this is an optional entry point that imports no
 * SDK: you connect with the Firebase Admin SDK (`firebase-admin`) or the web SDK
 * (`firebase/database`), wrap the connection with `realtimeStoreFromAdmin` or
 * `realtimeStoreFromWebSdk`, and pass the result in. Security rules stay your job.
 */
import { describeUnknownError } from '../errors.js';
import { createKeyedQueue, type KeyedQueue } from '../keyed-queue.js';
import { createChangeListeners, sqlFailure } from '../sql-shared.js';
import { keyFromRealtimeNodeKey, realtimeNodeKey } from './realtime-keys.js';
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

/** The fields of a stored node, as the Realtime Database holds them. */
export type RealtimeFields = Readonly<Record<string, unknown>>;

/**
 * What a transaction decided after reading the node: the `result` to hand back, and
 * optionally a `write` (the new fields, or `'delete'`). With no `write` the transaction
 * is abandoned. It may run more than once, because the database runs it again when the
 * value it was given was out of date, so it must not have side effects.
 */
export interface RealtimeDecision<T> {
  readonly result: T;
  readonly write?: RealtimeFields | 'delete';
}

/**
 * The calls the adapter makes on the database, in terms of one parent node whose
 * children are the keys. The wrappers below make one from either SDK; write your own for
 * anything else.
 */
export interface RealtimeDatabaseStoreLike {
  /** The fields of the child node, or `null` when it does not exist. */
  get(nodeKey: string): Promise<RealtimeFields | null>;
  /**
   * Reads the child and applies the decision in one transaction, so the revision check
   * and the write cannot be separated by another writer.
   */
  transact<T>(
    nodeKey: string,
    decide: (current: RealtimeFields | null) => RealtimeDecision<T>
  ): Promise<T>;
  /**
   * The names of the children that start with `nodePrefix`. The database sorts children
   * by name, so these are one run of neighbours, and the wrappers read them a page at a
   * time. (The children's values come across too: the database cannot send names alone.)
   */
  listNodeKeys?(nodePrefix: string): Promise<string[]>;
  /**
   * Calls `onData` with the child's fields (or `null`) now and on each change, including
   * changes other clients make. Returns the function that stops it.
   */
  watch?(
    nodeKey: string,
    onData: (fields: RealtimeFields | null) => void,
    onError: (error: unknown) => void
  ): () => void;
}

export interface RealtimeDatabaseAdapterOptions {
  /** The parent node, wrapped by `realtimeStoreFromAdmin` or `realtimeStoreFromWebSdk`. */
  readonly store: RealtimeDatabaseStoreLike;
  /** The time for `created_at` and `updated_at`. Defaults to the system clock. */
  readonly now?: () => Date;
  /**
   * Called when a listener that `subscribe` started stops with an error (rules that
   * refuse reads, for example). The subscriber hears nothing more for that key until it
   * subscribes again.
   */
  readonly onWatchError?: (key: string, message: string) => void;
}

/* ------------------------------------------------------------------ */
/* Nodes                                                               */
/* ------------------------------------------------------------------ */

const LABEL = 'Realtime Database';
/** A string in the database is at most 10,485,760 bytes; leave room for the rest. */
const MAX_VALUE_BYTES = 10_000_000;

/** What a `set` transaction found. */
type WriteOutcome =
  | { readonly kind: 'written'; readonly revision: string }
  | { readonly kind: 'conflict'; readonly revision: string }
  | { readonly kind: 'corrupt' };

interface Entry {
  readonly value: string;
  readonly revision: number;
  readonly createdAt: string | null;
}

/** Reads a node's fields as an entry, or null if they are not one. */
function entryFrom(fields: RealtimeFields): Entry | null {
  const { entry_value: value, revision, created_at: createdAt } = fields;
  if (
    typeof value !== 'string' ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    return null;
  }
  return {
    value,
    revision,
    createdAt: typeof createdAt === 'string' ? createdAt : null,
  };
}

function storedFrom(fields: RealtimeFields): StoredValue | null {
  const entry: Entry | null = entryFrom(fields);
  return entry === null
    ? null
    : { value: entry.value, revision: String(entry.revision) };
}

/** Maps an SDK error to a code. The SDKs are not consistent about `code`, so the text counts too. */
function classifyError(error: unknown): StoreErrorCode {
  const code: unknown =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  const text = `${typeof code === 'string' ? code : ''} ${describeUnknownError(error)}`;
  if (/permission[_ ]denied/i.test(text)) {
    return 'forbidden';
  }
  if (/greater than \d+ (utf8 )?bytes|exceeds the maximum length/i.test(text)) {
    return 'invalid';
  }
  if (/quota/i.test(text)) {
    return 'quota';
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
 * A `StorageAdapter` with one child node per key, holding `entry_key`, `entry_value`, a
 * counter `revision`, and `created_at` and `updated_at` (ISO text). A transaction reads
 * the node and writes it, so `set` with `ifRevision` reports `conflict` when another
 * client wrote first, and a key with nothing stored is created. `subscribe` listens to
 * the node, so it reports your own writes and changes other clients make. Nothing
 * throws: every failure is a `StoreResult`.
 *
 * @experimental May change in a minor release until it has been run against the real service. See docs/export-audit.md.
 */
export function realtimeDatabaseAdapter(
  options: RealtimeDatabaseAdapterOptions
): StorageAdapter {
  const { store } = options;
  const now: () => Date = options.now ?? ((): Date => new Date());
  const listeners = createChangeListeners();
  /** The revision last reported for each watched key (null: reported removed). */
  const reported = new Map<string, string | null>();
  const watchers = new Map<string, () => void>();
  /**
   * Writes to one key run in turn: a transaction that loses a race is run again, and
   * many at once on one node make each other wait. Writers in other processes still
   * race, and the SDK runs those again.
   */
  const writes: KeyedQueue = createKeyedQueue();

  /** Why this call cannot go ahead, or null if it can. */
  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): { readonly nodeKey: string } | StoreResult<T> => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    const nodeKey: string | null = realtimeNodeKey(key);
    if (nodeKey === null) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        'cannot be used as a key: it must be valid text and no more than 767 bytes once the characters the database refuses are escaped'
      );
    }
    return { nodeKey };
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

  const startWatching = (key: string, nodeKey: string): void => {
    if (store.watch === undefined || watchers.has(key)) {
      return;
    }
    let baselined = false;
    try {
      const stop: () => void = store.watch(
        nodeKey,
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
      if (!('nodeKey' in checked)) {
        return checked;
      }
      try {
        const fields: RealtimeFields | null = await store.get(checked.nodeKey);
        if (fields === null) {
          return { ok: true, value: null };
        }
        const stored: StoredValue | null = storedFrom(fields);
        return stored === null
          ? sqlFailure(
              LABEL,
              'corrupt',
              key,
              'holds a node that is not a stored entry'
            )
          : { ok: true, value: stored };
      } catch (error: unknown) {
        return failedWith(error, key, 'read');
      }
    },

    async set(key, value, { signal, ifRevision }) {
      const checked = refusal<StoredValue>(key, signal);
      if (!('nodeKey' in checked)) {
        return checked;
      }
      if (utf8Length(value) > MAX_VALUE_BYTES) {
        return sqlFailure(
          LABEL,
          'invalid',
          key,
          `cannot hold a value of ${utf8Length(value)} bytes: a string in the Realtime Database is limited to about 10 MB`
        );
      }
      try {
        const outcome: WriteOutcome = await writes.run(checked.nodeKey, () =>
          store.transact<WriteOutcome>(
            checked.nodeKey,
            (current): RealtimeDecision<WriteOutcome> => {
              const entry: Entry | null =
                current === null ? null : entryFrom(current);
              if (
                current !== null &&
                entry === null &&
                ifRevision !== undefined
              ) {
                return { result: { kind: 'corrupt' } };
              }
              if (
                entry !== null &&
                ifRevision !== undefined &&
                String(entry.revision) !== ifRevision
              ) {
                return {
                  result: {
                    kind: 'conflict',
                    revision: String(entry.revision),
                  },
                };
              }
              const stamp: string = now().toISOString();
              const revision: number = (entry?.revision ?? 0) + 1;
              return {
                result: { kind: 'written', revision: String(revision) },
                write: {
                  entry_key: key,
                  entry_value: value,
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
            'holds a node that is not a stored entry, so its revision cannot be checked'
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
      if (!('nodeKey' in checked)) {
        return checked;
      }
      try {
        await writes.run(checked.nodeKey, () =>
          store.transact(checked.nodeKey, () => ({
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
      if (store.listNodeKeys === undefined) {
        return prefixFailure(
          LABEL,
          'invalid',
          prefix,
          'cannot list keys: the store has no listNodeKeys'
        );
      }
      // Escaping works one character at a time, so a key with this prefix has a name
      // that starts with the prefix's own name (which is null for a lone surrogate, and
      // then nothing can match).
      const nodePrefix: string | null = realtimeNodeKey(prefix);
      if (nodePrefix === null) {
        return { ok: true, value: [] };
      }
      try {
        const keys: string[] = [];
        for (const nodeKey of await store.listNodeKeys(nodePrefix)) {
          const key: string | null = keyFromRealtimeNodeKey(nodeKey);
          if (key !== null) {
            keys.push(key);
          }
        }
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
      const nodeKey: string | null = realtimeNodeKey(key);
      if (nodeKey !== null) {
        startWatching(key, nodeKey);
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
/* What the two SDKs have in common                                    */
/* ------------------------------------------------------------------ */

const DEFAULT_PATH = 'storage_entry';
/** Children read per request when listing. */
const LIST_PAGE_SIZE = 500;

/** A snapshot from either SDK, as the wrappers use it. */
interface SnapshotShape {
  val(): unknown;
  forEach(
    action: (child: { readonly key: string | null }) => boolean | void
  ): boolean;
}

/** The fields of a value the SDK gave back (`null` for nothing, `{}` for what is not an object). */
function fieldsOf(value: unknown): RealtimeFields | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'object' && !Array.isArray(value)
    ? (value as RealtimeFields)
    : {};
}

/** What a transaction's update function returns for a decision: `undefined` abandons it. */
function updateFor(
  write: RealtimeFields | 'delete' | undefined
): RealtimeFields | null | undefined {
  return write === 'delete' ? null : write;
}

/** Runs `decide` as the update function of a transaction and returns what it decided. */
async function runDecision<T>(
  start: (
    update: (current: unknown) => RealtimeFields | null | undefined
  ) => PromiseLike<unknown>,
  decide: (current: RealtimeFields | null) => RealtimeDecision<T>
): Promise<T> {
  const last: { decision?: RealtimeDecision<T> } = {};
  await start((current) => {
    last.decision = decide(fieldsOf(current));
    return updateFor(last.decision.write);
  });
  if (last.decision === undefined) {
    throw new Error('the transaction never ran its update function');
  }
  return last.decision.result;
}

/** The names of the children from `nodePrefix` on, read a page at a time, while they start with it. */
async function listFrom(
  nodePrefix: string,
  readPage: (startAt: string, limit: number) => Promise<SnapshotShape>
): Promise<string[]> {
  const names: string[] = [];
  let startAt: string = nodePrefix;
  for (let pageNumber = 0; ; pageNumber += 1) {
    const page: SnapshotShape = await readPage(startAt, LIST_PAGE_SIZE);
    let seen = 0;
    let leftThePrefix = false;
    let added = 0;
    page.forEach((child) => {
      const name: string | null = child.key;
      if (name === null) {
        return false;
      }
      seen += 1;
      if (!name.startsWith(nodePrefix)) {
        leftThePrefix = true;
        return true; // Stop: the run of children with this prefix is over.
      }
      // A page after the first starts at the last name of the one before.
      if (pageNumber > 0 && name === startAt) {
        return false;
      }
      names.push(name);
      added += 1;
      return false;
    });
    if (leftThePrefix || seen < LIST_PAGE_SIZE || added === 0) {
      return names;
    }
    startAt = names.at(-1) ?? startAt;
  }
}

/* ------------------------------------------------------------------ */
/* The Firebase Admin SDK (firebase-admin)                             */
/* ------------------------------------------------------------------ */

/**
 * The `Database` from `firebase-admin/database`. What `ref` returns is typed `unknown` on
 * purpose: the SDK's reference types are generic enough that TypeScript cannot compare
 * them with a hand-written one. The wrapper uses it as a reference, which the real one is.
 */
export interface AdminDatabaseLike {
  ref(path?: string): unknown;
}

export interface AdminRealtimeStoreOptions {
  readonly database: AdminDatabaseLike;
  /** The parent node whose children are the keys. Defaults to `storage_entry`. */
  readonly path?: string;
}

/** The parts of an Admin SDK reference this wrapper calls. */
interface AdminRef {
  child(path: string): AdminRef;
  once(event: 'value'): Promise<SnapshotShape>;
  transaction(
    update: (current: unknown) => unknown,
    onComplete: undefined,
    applyLocally: boolean
  ): Promise<unknown>;
  on(
    event: 'value',
    callback: (snapshot: SnapshotShape) => void,
    cancel: (error: Error) => void
  ): (snapshot: SnapshotShape) => void;
  off(event: 'value', callback: (snapshot: SnapshotShape) => void): void;
  orderByKey(): AdminRef;
  startAt(value: string): AdminRef;
  limitToFirst(limit: number): AdminRef;
}

/**
 * Wraps a Database from the Admin SDK (`getDatabase()` from `firebase-admin/database`).
 *
 * @experimental May change in a minor release until it has been run against the real service. See docs/export-audit.md.
 */
export function realtimeStoreFromAdmin(
  options: AdminRealtimeStoreOptions
): RealtimeDatabaseStoreLike {
  const parent = options.database.ref(options.path ?? DEFAULT_PATH) as AdminRef;
  return {
    get: async (nodeKey) =>
      fieldsOf((await parent.child(nodeKey).once('value')).val()),
    transact: (nodeKey, decide) =>
      runDecision(
        (update) =>
          // `applyLocally` off: nobody should see a value that may still be run again.
          parent.child(nodeKey).transaction(update, undefined, false),
        decide
      ),
    listNodeKeys: (nodePrefix) =>
      listFrom(nodePrefix, (startAt, limit) =>
        parent.orderByKey().startAt(startAt).limitToFirst(limit).once('value')
      ),
    watch: (nodeKey, onData, onError) => {
      const reference: AdminRef = parent.child(nodeKey);
      const callback = reference.on(
        'value',
        (snapshot) => {
          onData(fieldsOf(snapshot.val()));
        },
        onError
      );
      return () => {
        reference.off('value', callback);
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* The web SDK (firebase/database)                                     */
/* ------------------------------------------------------------------ */

/**
 * The functions of `firebase/database` the adapter uses, passed in so that the package
 * imports nothing: `import * as databaseSdk from 'firebase/database'`. References and
 * queries are opaque to the adapter, so what they return is typed `unknown`.
 */
export interface RealtimeWebSdkLike {
  ref(database: unknown, path?: string): unknown;
  child(parent: unknown, path: string): unknown;
  get(query: unknown): PromiseLike<unknown>;
  runTransaction(
    reference: unknown,
    update: (current: unknown) => unknown,
    options?: { applyLocally?: boolean }
  ): PromiseLike<unknown>;
  onValue(
    query: unknown,
    onNext: (snapshot: unknown) => unknown,
    onError: (error: Error) => unknown
  ): () => void;
  query(reference: unknown, ...constraints: unknown[]): unknown;
  orderByKey(): unknown;
  startAt(value: string): unknown;
  limitToFirst(limit: number): unknown;
}

export interface WebRealtimeStoreOptions {
  /** The `Database` from `getDatabase()`. */
  readonly database: unknown;
  /** The module `firebase/database`. */
  readonly sdk: RealtimeWebSdkLike;
  /** The parent node whose children are the keys. Defaults to `storage_entry`. */
  readonly path?: string;
}

/**
 * Wraps the web SDK (`firebase/database`), in a browser or in Node.
 *
 * @experimental May change in a minor release until it has been run against the real service. See docs/export-audit.md.
 */
export function realtimeStoreFromWebSdk(
  options: WebRealtimeStoreOptions
): RealtimeDatabaseStoreLike {
  const { database, sdk } = options;
  const parent: unknown = sdk.ref(database, options.path ?? DEFAULT_PATH);
  return {
    get: async (nodeKey) =>
      fieldsOf(
        ((await sdk.get(sdk.child(parent, nodeKey))) as SnapshotShape).val()
      ),
    transact: (nodeKey, decide) =>
      runDecision(
        (update) =>
          sdk.runTransaction(sdk.child(parent, nodeKey), update, {
            applyLocally: false,
          }),
        decide
      ),
    listNodeKeys: (nodePrefix) =>
      listFrom(
        nodePrefix,
        async (startAt, limit) =>
          (await sdk.get(
            sdk.query(
              parent,
              sdk.orderByKey(),
              sdk.startAt(startAt),
              sdk.limitToFirst(limit)
            )
          )) as SnapshotShape
      ),
    watch: (nodeKey, onData, onError) =>
      sdk.onValue(
        sdk.child(parent, nodeKey),
        (snapshot: unknown): void => {
          onData(fieldsOf((snapshot as SnapshotShape).val()));
        },
        onError
      ),
  };
}
