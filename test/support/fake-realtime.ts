import type {
  RealtimeDecision,
  RealtimeDatabaseStoreLike,
  RealtimeFields,
} from '../../src/firebase/realtime.js';

/** An error shaped like the ones the Realtime Database SDKs throw. */
export function realtimeError(message: string, code?: string): Error {
  return code === undefined
    ? new Error(message)
    : Object.assign(new Error(message), { code });
}

export interface FakeRealtime extends RealtimeDatabaseStoreLike {
  readonly nodes: Map<string, RealtimeFields>;
  readonly calls: string[];
  /** Makes the next call of this kind reject with this error. */
  failNext: Partial<Record<'get' | 'transact' | 'list', Error>>;
  /** How many listeners are active, per node name. */
  readonly watchers: Map<string, number>;
  /** Pushes the current state of a node to its listeners, as a server would. */
  push(nodeKey: string): void;
  /** Fails every active listener, as a lost permission would. */
  failWatchers(error: Error): void;
  /** Runs the transaction function this many extra times first, as a retry would. */
  rerunTransactions: number;
}

/**
 * An in-memory parent node that behaves like the Realtime Database for the calls the
 * adapter makes: transactions that read then write, listeners that hear every change
 * a moment later, and children sorted by name.
 */
export function fakeRealtime(
  nodes: Map<string, RealtimeFields> = new Map()
): FakeRealtime {
  const calls: string[] = [];
  const watchers = new Map<string, number>();
  const listeners = new Map<
    string,
    Set<{
      onData: (fields: RealtimeFields | null) => void;
      onError: (error: unknown) => void;
    }>
  >();

  const push = (nodeKey: string): void => {
    const fields: RealtimeFields | null = nodes.get(nodeKey) ?? null;
    for (const listener of [...(listeners.get(nodeKey) ?? [])]) {
      listener.onData(fields);
    }
  };

  const fake: FakeRealtime = {
    nodes,
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
    get: (nodeKey) => {
      calls.push(`get ${nodeKey}`);
      const failure = fake.failNext.get;
      if (failure !== undefined) {
        delete fake.failNext.get;
        return Promise.reject(failure);
      }
      return Promise.resolve(nodes.get(nodeKey) ?? null);
    },
    transact: async <T>(
      nodeKey: string,
      decide: (current: RealtimeFields | null) => RealtimeDecision<T>
    ): Promise<T> => {
      calls.push(`transact ${nodeKey}`);
      const failure = fake.failNext.transact;
      if (failure !== undefined) {
        delete fake.failNext.transact;
        throw failure;
      }
      // Let other callers run between the read and the write, as a network would.
      await Promise.resolve();
      for (let rerun = 0; rerun < fake.rerunTransactions; rerun += 1) {
        decide(nodes.get(nodeKey) ?? null);
      }
      const decision: RealtimeDecision<T> = decide(nodes.get(nodeKey) ?? null);
      if (decision.write === 'delete') {
        nodes.delete(nodeKey);
        queueMicrotask(() => {
          push(nodeKey);
        });
      } else if (decision.write !== undefined) {
        nodes.set(nodeKey, { ...decision.write });
        queueMicrotask(() => {
          push(nodeKey);
        });
      }
      return decision.result;
    },
    listNodeKeys: (nodePrefix) => {
      calls.push(`list ${nodePrefix}`);
      const failure = fake.failNext.list;
      if (failure !== undefined) {
        delete fake.failNext.list;
        return Promise.reject(failure);
      }
      return Promise.resolve(
        [...nodes.keys()]
          .filter((name) => name.startsWith(nodePrefix))
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      );
    },
    watch: (nodeKey, onData, onError) => {
      calls.push(`watch ${nodeKey}`);
      const listener = { onData, onError };
      const set = listeners.get(nodeKey) ?? new Set();
      set.add(listener);
      listeners.set(nodeKey, set);
      watchers.set(nodeKey, (watchers.get(nodeKey) ?? 0) + 1);
      queueMicrotask(() => {
        onData(nodes.get(nodeKey) ?? null);
      });
      return () => {
        if (set.delete(listener)) {
          watchers.set(nodeKey, (watchers.get(nodeKey) ?? 1) - 1);
        }
      };
    },
  };
  return fake;
}
