/**
 * Small pieces shared by the server SQL adapters (`/postgres` and `/mysql`): the
 * list of change listeners, error text, and the checks on user-supplied names and
 * revisions. Like the rest of `src/`, this does no I/O.
 */
import type { StoredValue, StoreErrorCode, StoreResult } from './storage.js';

/** Who to tell when a key changes through this adapter. */
export interface ChangeListeners {
  notify(key: string, stored: StoredValue | null): void;
  subscribe(
    key: string,
    onChange: (stored: StoredValue | null) => void
  ): () => void;
}

export function createChangeListeners(): ChangeListeners {
  const listeners = new Map<
    string,
    Set<(stored: StoredValue | null) => void>
  >();
  return {
    notify(key, stored) {
      for (const listener of listeners.get(key) ?? []) {
        try {
          listener(stored);
        } catch {
          // A faulty listener must not turn a successful write into a failure.
        }
      }
    },
    subscribe(key, onChange) {
      const set: Set<(stored: StoredValue | null) => void> =
        listeners.get(key) ?? new Set();
      set.add(onChange);
      listeners.set(key, set);
      return () => {
        set.delete(onChange);
        if (set.size === 0) {
          listeners.delete(key);
        }
      };
    },
  };
}

/** `<label> <detail> for key "<key>"`: every error names the store and the key. */
export function sqlFailure<T>(
  label: string,
  code: StoreErrorCode,
  key: string,
  detail: string
): StoreResult<T> {
  return { ok: false, code, error: `${label} ${detail} for key "${key}"` };
}

/**
 * A table name that is safe to put in SQL text: letters, digits and underscores,
 * optionally with one `schema.` prefix. Anything else is refused, because a table
 * name cannot be sent as a parameter.
 */
export function isSafeTableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name);
}

/**
 * The revision to compare against, as digits. Revisions here are counters that
 * start at 1, so a value that is not a plain number can never match a stored
 * revision; `neverMatches` stands in for it and the write is refused as a conflict
 * (or creates the key, if nothing is stored) instead of failing in the database.
 */
export function revisionParameter(
  ifRevision: string,
  neverMatches: string
): string {
  return /^[0-9]{1,18}$/.test(ifRevision) ? ifRevision : neverMatches;
}

/** Digits of a revision a driver returned as a string, number or bigint. */
export function revisionText(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'bigint' && value >= 0n) {
    return value.toString();
  }
  return undefined;
}
