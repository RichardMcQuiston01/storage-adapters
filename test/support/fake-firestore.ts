import {
  firestorePrefixUpperBound,
  type FirestoreDecision,
  type FirestoreFields,
  type FirestoreStoreLike,
} from '../../src/firebase/index.js';

/** An error shaped like the ones the Firestore SDKs throw. */
export function firestoreError(
  code: string | number,
  message = String(code)
): Error {
  return Object.assign(new Error(message), { code });
}

/** Orders strings by code point, as Firestore does (JavaScript's `<` uses UTF-16 units). */
function compareCodePoints(left: string, right: string): number {
  const leftPoints: number[] = [...left].map((c) => c.codePointAt(0) ?? 0);
  const rightPoints: number[] = [...right].map((c) => c.codePointAt(0) ?? 0);
  const shared: number = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const difference: number =
      (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

export interface FakeFirestore extends FirestoreStoreLike {
  readonly documents: Map<string, FirestoreFields>;
  readonly calls: string[];
  /** Makes the next call of this kind reject with this error. */
  failNext: Partial<Record<'get' | 'transact' | 'list' | 'watch', Error>>;
  /** How many listeners are active, per document id. */
  readonly watchers: Map<string, number>;
  /** Pushes the current state of a document to its listeners, as a server would. */
  push(documentId: string): void;
  /** Fails every active listener, as a lost permission would. */
  failWatchers(error: Error): void;
  /** Runs a transaction body this many extra times first, as a retry would. */
  rerunTransactions: number;
}

/**
 * An in-memory collection that behaves like Firestore for the calls the adapter
 * makes: transactions that read then write, listeners that hear every change
 * (including ones this client made) a moment later, and prefix queries.
 */
export function fakeFirestore(
  documents: Map<string, FirestoreFields> = new Map()
): FakeFirestore {
  const calls: string[] = [];
  const watchers = new Map<string, number>();
  const listeners = new Map<
    string,
    Set<{
      onData: (fields: FirestoreFields | null) => void;
      onError: (error: unknown) => void;
    }>
  >();

  const push = (documentId: string): void => {
    const fields: FirestoreFields | null = documents.get(documentId) ?? null;
    for (const listener of [...(listeners.get(documentId) ?? [])]) {
      listener.onData(fields);
    }
  };

  const fake: FakeFirestore = {
    documents,
    calls,
    failNext: {},
    watchers,
    rerunTransactions: 0,
    push,
    failWatchers: (error) => {
      for (const set of listeners.values()) {
        for (const listener of [...set]) {
          listener.onError(error);
        }
        set.clear();
      }
      watchers.clear();
    },
    get: (documentId) => {
      calls.push(`get ${documentId}`);
      const failure = fake.failNext.get;
      if (failure !== undefined) {
        delete fake.failNext.get;
        return Promise.reject(failure);
      }
      return Promise.resolve(documents.get(documentId) ?? null);
    },
    transact: async <T>(
      documentId: string,
      decide: (current: FirestoreFields | null) => FirestoreDecision<T>
    ): Promise<T> => {
      calls.push(`transact ${documentId}`);
      const failure = fake.failNext.transact;
      if (failure !== undefined) {
        delete fake.failNext.transact;
        throw failure;
      }
      // Let other callers run between the read and the write, as a network would.
      await Promise.resolve();
      for (let rerun = 0; rerun < fake.rerunTransactions; rerun += 1) {
        decide(documents.get(documentId) ?? null);
      }
      const decision: FirestoreDecision<T> = decide(
        documents.get(documentId) ?? null
      );
      if (decision.write === 'delete') {
        documents.delete(documentId);
        queueMicrotask(() => {
          push(documentId);
        });
      } else if (decision.write !== undefined) {
        documents.set(documentId, { ...decision.write });
        queueMicrotask(() => {
          push(documentId);
        });
      }
      return decision.result;
    },
    listKeys: (prefix) => {
      calls.push(`list ${prefix}`);
      const failure = fake.failNext.list;
      if (failure !== undefined) {
        delete fake.failNext.list;
        return Promise.reject(failure);
      }
      const upper: string | null = firestorePrefixUpperBound(prefix);
      const keys: string[] = [];
      for (const fields of documents.values()) {
        const key: unknown = fields.key;
        // Firestore compares strings by code point; the fake does the same.
        if (
          typeof key === 'string' &&
          compareCodePoints(key, prefix) >= 0 &&
          (upper === null || compareCodePoints(key, upper) < 0)
        ) {
          keys.push(key);
        }
      }
      return Promise.resolve(keys);
    },
    watch: (documentId, onData, onError) => {
      calls.push(`watch ${documentId}`);
      const failure = fake.failNext.watch;
      if (failure !== undefined) {
        delete fake.failNext.watch;
        throw failure;
      }
      const listener = { onData, onError };
      const set = listeners.get(documentId) ?? new Set();
      set.add(listener);
      listeners.set(documentId, set);
      watchers.set(documentId, (watchers.get(documentId) ?? 0) + 1);
      // The first snapshot is the document as it is now.
      queueMicrotask(() => {
        if (set.has(listener)) {
          onData(documents.get(documentId) ?? null);
        }
      });
      return () => {
        if (set.delete(listener)) {
          const left: number = (watchers.get(documentId) ?? 1) - 1;
          if (left <= 0) {
            watchers.delete(documentId);
          } else {
            watchers.set(documentId, left);
          }
        }
      };
    },
  };
  return fake;
}
