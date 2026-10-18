/**
 * A React hook for one key of a `StorageAdapter`: it loads the value, follows changes
 * other tabs or processes make when the adapter can `subscribe`, and gives back `set`
 * and `remove`. React is an optional peer dependency of this entry point only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { describeUnknownError } from '../errors.js';
import type {
  StorageAdapter,
  StoreErrorCode,
  StoreResult,
  StoredValue,
} from '../storage.js';

/**
 * `loading` until the first read finishes, `ready` once the value is known (even if
 * nothing is stored), and `error` when the read failed and the value is not known.
 */
export type StoredValueStatus = 'loading' | 'ready' | 'error';

/** Why the last operation failed: the adapter's code and its message, which names the key. */
export interface StoredValueError {
  readonly code: StoreErrorCode;
  readonly message: string;
}

export interface StoredValueState {
  readonly status: StoredValueStatus;
  /** The stored text, or `null` when nothing is stored or it is not known yet. */
  readonly value: string | null;
  /** The revision of `value`, for adapters that have revisions. */
  readonly revision: string | undefined;
  /**
   * The last failure of a read, `set` or `remove`; `null` after the next success. A
   * failed `set` or `remove` leaves `status` and `value` as they were.
   */
  readonly error: StoredValueError | null;
}

export interface SetStoredValueOptions {
  /** Refuse the write with `conflict` if the stored revision is not this one. */
  readonly ifRevision?: string;
}

export interface UseStoredValueResult extends StoredValueState {
  /** Writes the value. Resolves with the adapter's result, which the caller should check. */
  set(
    value: string,
    options?: SetStoredValueOptions
  ): Promise<StoreResult<StoredValue>>;
  /** Removes the key. Resolves `unavailable` when the adapter cannot remove. */
  remove(): Promise<StoreResult<null>>;
  /** Reads the key again now, for adapters that cannot `subscribe`. */
  refresh(): Promise<StoreResult<StoredValue | null>>;
}

const LOADING: StoredValueState = {
  status: 'loading',
  value: null,
  revision: undefined,
  error: null,
};

/** A signal that never aborts: a write is not cancelled because a component went away. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

function readyState(stored: StoredValue | null): StoredValueState {
  return {
    status: 'ready',
    value: stored?.value ?? null,
    revision: stored?.revision,
    error: null,
  };
}

function withError(
  state: StoredValueState,
  code: StoreErrorCode,
  message: string
): StoredValueState {
  return { ...state, error: { code, message } };
}

/** Turns a rejection (an adapter that broke its contract) into a result. */
async function settled<T>(
  key: string,
  verb: string,
  work: () => Promise<StoreResult<T>>
): Promise<StoreResult<T>> {
  try {
    return await work();
  } catch (error: unknown) {
    return {
      ok: false,
      code: 'unavailable',
      error: `${verb} failed for key "${key}" (${describeUnknownError(error)})`,
    };
  }
}

/**
 * Follows one key of an adapter. Create the adapter once (outside the component, or
 * with `useMemo`): a new adapter object on every render starts the read again each time.
 *
 * ```tsx
 * const theme = useStoredValue(adapter, 'theme');
 * if (theme.status === 'loading') return null;
 * return <button onClick={() => void theme.set('dark')}>{theme.value ?? 'light'}</button>;
 * ```
 */
export function useStoredValue(
  adapter: StorageAdapter,
  key: string
): UseStoredValueResult {
  const [state, setState] = useState<StoredValueState>(LOADING);
  const latest = useRef({ adapter, key });
  latest.current = { adapter, key };
  const mounted = useRef(false);

  /** True while this adapter and key are still the ones being shown. */
  const isCurrent = useCallback(
    (forAdapter: StorageAdapter, forKey: string): boolean =>
      mounted.current &&
      latest.current.adapter === forAdapter &&
      latest.current.key === forKey,
    []
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    // A change heard while the first read is still going is newer than that read.
    let heardChange = false;
    setState(LOADING);

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = adapter.subscribe?.(key, (stored) => {
        heardChange = true;
        setState(readyState(stored));
      });
    } catch (error: unknown) {
      // The value can still be read; it just will not follow changes.
      setState((current) =>
        withError(
          current,
          'unavailable',
          `could not listen for key "${key}" (${describeUnknownError(error)})`
        )
      );
    }

    void settled(key, 'read', () =>
      adapter.get(key, { signal: controller.signal })
    ).then((result) => {
      if (controller.signal.aborted || heardChange) {
        return;
      }
      setState((current) =>
        result.ok
          ? readyState(result.value)
          : {
              ...withError(current, result.code, result.error),
              status: 'error',
            }
      );
    });

    return () => {
      mounted.current = false;
      controller.abort();
      try {
        unsubscribe?.();
      } catch {
        // Nothing useful to do if stopping the listener fails.
      }
    };
  }, [adapter, key]);

  const set = useCallback(
    async (
      value: string,
      options: SetStoredValueOptions = {}
    ): Promise<StoreResult<StoredValue>> => {
      const result = await settled(key, 'write', () =>
        adapter.set(key, value, {
          signal: NEVER_ABORTED,
          ...(options.ifRevision === undefined
            ? {}
            : { ifRevision: options.ifRevision }),
        })
      );
      if (isCurrent(adapter, key)) {
        setState((current) =>
          result.ok
            ? readyState(result.value)
            : withError(current, result.code, result.error)
        );
      }
      return result;
    },
    [adapter, key, isCurrent]
  );

  const remove = useCallback(async (): Promise<StoreResult<null>> => {
    const result: StoreResult<null> =
      adapter.remove === undefined
        ? {
            ok: false,
            code: 'unavailable',
            error: `this adapter cannot remove key "${key}"`,
          }
        : await settled(
            key,
            'remove',
            () =>
              adapter.remove?.(key, { signal: NEVER_ABORTED }) ??
              Promise.resolve({ ok: true as const, value: null })
          );
    if (isCurrent(adapter, key)) {
      setState((current) =>
        result.ok
          ? readyState(null)
          : withError(current, result.code, result.error)
      );
    }
    return result;
  }, [adapter, key, isCurrent]);

  const refresh = useCallback(async (): Promise<
    StoreResult<StoredValue | null>
  > => {
    const result = await settled(key, 'read', () =>
      adapter.get(key, { signal: NEVER_ABORTED })
    );
    if (isCurrent(adapter, key)) {
      setState((current) =>
        result.ok
          ? readyState(result.value)
          : {
              ...withError(current, result.code, result.error),
              status: current.status === 'ready' ? 'ready' : 'error',
            }
      );
    }
    return result;
  }, [adapter, key, isCurrent]);

  return { ...state, set, remove, refresh };
}
