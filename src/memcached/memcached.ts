/**
 * A `StorageAdapter` over Memcached, for cache-style storage. Like `/redis`, this is
 * an optional entry point that imports no client: you connect with `memcache-client`
 * (or anything that can do `gets`, `add`, `cas` and `delete`) and pass it in.
 */
import { describeUnknownError } from '../errors.js';
import { createChangeListeners, sqlFailure } from '../sql-shared.js';
import { utf8Bytes } from '../utf8.js';
import {
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** What `gets` returns: the stored text and the server's token for that version of it. */
export interface MemcachedEntryLike {
  readonly value: string;
  /** Memcached's CAS unique for this version, as digits. */
  readonly casUniq: string;
}

/** How a `add` or `cas` ended, in Memcached's own words. */
export type MemcachedStoreOutcome =
  | 'stored'
  /** `add` found a value already there. */
  | 'not_stored'
  /** `cas` found the value changed since `gets`. */
  | 'exists'
  /** `cas` found nothing there (it expired or was deleted). */
  | 'not_found';

/**
 * The four things this adapter needs from a Memcached client. `memcachedFromMemcacheClient`
 * wraps the `memcache-client` package. A failure to reach the server, or a
 * `SERVER_ERROR`/`CLIENT_ERROR`, should reject; the four outcomes above should not.
 */
export interface MemcachedClientLike {
  /** `null` when nothing is stored. */
  gets(key: string): Promise<MemcachedEntryLike | null>;
  /** Stores only if the key is absent. */
  add(
    key: string,
    value: string,
    options: { readonly ttlSeconds: number }
  ): Promise<MemcachedStoreOutcome>;
  /** Stores only if the key still holds the version `casUniq` names. */
  cas(
    key: string,
    value: string,
    casUniq: string,
    options: { readonly ttlSeconds: number }
  ): Promise<MemcachedStoreOutcome>;
  /** Deletes the key; deleting nothing is not a failure. */
  delete(key: string): Promise<void>;
}

export interface MemcachedAdapterOptions {
  /** A connected client. The adapter never closes it. */
  readonly client: MemcachedClientLike;
  /**
   * Put in front of every Memcached key. Defaults to `storage:`; `''` for none. Only
   * letters, digits and `_ . : -` are allowed, because a key cannot hold spaces or
   * control characters.
   */
  readonly prefix?: string;
  /**
   * Seconds until a key expires after each write. Memcached reads anything over
   * 2592000 (30 days) as a date, so that is the most allowed. Defaults to no expiry,
   * which still lets Memcached evict the key when it needs the memory.
   */
  readonly ttlSeconds?: number;
}

const LABEL = 'Memcached';
const DEFAULT_PREFIX = 'storage:';
const MAX_KEY_LENGTH = 250;
const MAX_TTL_SECONDS = 2_592_000;
/** A write that keeps meeting a newer version is tried this many times. */
const MAX_WRITE_ATTEMPTS = 12;
/** After a lost race, wait up to this many milliseconds (growing, with jitter) before reading again. */
const MAX_BACKOFF_MS = 30;
const PREFIX_PATTERN = /^[A-Za-z0-9_.:-]*$/;

/** What is stored under a key: the counter revision and the value. */
interface Stored {
  readonly revision: number;
  readonly value: string;
  readonly casUniq: string;
}

/**
 * Turns a key into a Memcached key: letters, digits, `_`, `.` and `-` stay, every
 * other byte of the key's UTF-8 becomes `=` and two uppercase hex digits. Returns
 * `undefined` for a key that is not valid Unicode text.
 */
function escapeKey(key: string): string | undefined {
  let escaped = '';
  for (const char of key) {
    const codePoint: number = char.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return undefined;
    }
    if (/^[A-Za-z0-9_.-]$/.test(char)) {
      escaped += char;
    } else {
      for (const byte of utf8Bytes(codePoint)) {
        escaped += `=${byte.toString(16).padStart(2, '0').toUpperCase()}`;
      }
    }
  }
  return escaped;
}

function classifyError(error: unknown): StoreErrorCode {
  const message: string = describeUnknownError(error);
  if (/^SERVER_ERROR object too large|too large/i.test(message)) {
    return 'invalid';
  }
  if (/^SERVER_ERROR out of memory|out of memory/i.test(message)) {
    return 'quota';
  }
  if (/^CLIENT_ERROR/i.test(message)) {
    return 'invalid';
  }
  return 'unavailable';
}

function failedWith<T>(
  error: unknown,
  key: string,
  verb: string
): StoreResult<T> {
  const code: StoreErrorCode = classifyError(error);
  const detail: string =
    code === 'invalid'
      ? `could not be ${verb}: Memcached refused it, perhaps because the value is larger than the server's item size limit, 1 MB by default (${describeUnknownError(error)})`
      : `could not be ${verb} (${describeUnknownError(error)})`;
  return sqlFailure(LABEL, code, key, detail);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The counter and value inside stored text, or `undefined` if it is not ours. */
function parseStored(
  text: string
): { revision: number; value: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const fields = parsed as { r?: unknown; v?: unknown };
    if (
      typeof fields.r === 'number' &&
      Number.isSafeInteger(fields.r) &&
      fields.r >= 1 &&
      typeof fields.v === 'string'
    ) {
      return { revision: fields.r, value: fields.v };
    }
  } catch {
    // Falls through: not JSON, so not an entry of ours.
  }
  return undefined;
}

/**
 * A `StorageAdapter` over Memcached. Memcached's own CAS token only says "unchanged
 * since I read it" and a write does not hand back the new one, so each value is kept
 * with a counter revision (`{"r": 3, "v": "..."}`), as the Redis adapter does. A write
 * reads the key, checks `ifRevision` against the counter, and stores with `add` (new
 * key) or `cas` (existing key), so two processes cannot both win; the loser reads
 * again and reports `conflict`. A key with nothing stored is created. Memcached may
 * evict or expire a key, and then its counter starts again at 1. It cannot list keys,
 * so `list` is not offered, and it cannot announce changes, so `subscribe` reports
 * only writes made through this adapter. Nothing throws: every failure is a
 * `StoreResult`.
 */
export function memcachedAdapter(
  options: MemcachedAdapterOptions
): StorageAdapter {
  const { client } = options;
  const prefix: string = options.prefix ?? DEFAULT_PREFIX;
  const ttlSeconds: number = options.ttlSeconds ?? 0;
  const listeners = createChangeListeners();

  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): { name: string } | StoreResult<T> => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    if (!PREFIX_PATTERN.test(prefix)) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use prefix "${prefix}": use only letters, digits and _ . : -`
      );
    }
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 0 ||
      ttlSeconds > MAX_TTL_SECONDS
    ) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use ttlSeconds ${String(ttlSeconds)}: use a whole number of seconds from 0 to ${String(MAX_TTL_SECONDS)}`
      );
    }
    const escaped: string | undefined = escapeKey(key);
    if (escaped === undefined) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        'cannot use this key: it is not valid Unicode text'
      );
    }
    const name = `${prefix}${escaped}`;
    if (name === '' || name.length > MAX_KEY_LENGTH) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use this key: with the prefix and escaping it must be 1 to ${String(MAX_KEY_LENGTH)} characters`
      );
    }
    return { name };
  };

  /** Reads what Memcached holds for a key. */
  const readStored = async (
    key: string,
    name: string
  ): Promise<StoreResult<Stored | null>> => {
    try {
      const entry: MemcachedEntryLike | null = await client.gets(name);
      if (entry === null) {
        return { ok: true, value: null };
      }
      const parsed = parseStored(entry.value);
      if (parsed === undefined) {
        return sqlFailure(
          LABEL,
          'corrupt',
          key,
          'holds something that is not a stored entry (remove the key to start again)'
        );
      }
      return { ok: true, value: { ...parsed, casUniq: entry.casUniq } };
    } catch (error: unknown) {
      return failedWith(error, key, 'read');
    }
  };

  return {
    async get(key, { signal }) {
      const checked = refusal<StoredValue | null>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      const read = await readStored(key, checked.name);
      if (!read.ok) {
        return read;
      }
      return {
        ok: true,
        value:
          read.value === null
            ? null
            : {
                value: read.value.value,
                revision: String(read.value.revision),
              },
      };
    },

    async set(key, value, { signal, ifRevision }) {
      const checked = refusal<StoredValue>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      const { name } = checked;
      let lastSeen: number | null = null;
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        const read = await readStored(key, name);
        if (!read.ok) {
          return read;
        }
        const current: Stored | null = read.value;
        lastSeen = current?.revision ?? null;
        if (
          ifRevision !== undefined &&
          current !== null &&
          String(current.revision) !== ifRevision
        ) {
          return sqlFailure(
            LABEL,
            'conflict',
            key,
            `holds revision ${String(current.revision)}, but revision ${ifRevision} was expected`
          );
        }
        const revision: number = (current?.revision ?? 0) + 1;
        const text: string = JSON.stringify({ r: revision, v: value });
        let outcome: MemcachedStoreOutcome;
        try {
          outcome =
            current === null
              ? await client.add(name, text, { ttlSeconds })
              : await client.cas(name, text, current.casUniq, { ttlSeconds });
        } catch (error: unknown) {
          return failedWith(error, key, 'written');
        }
        if (outcome === 'stored') {
          const stored: StoredValue = { value, revision: String(revision) };
          listeners.notify(key, stored);
          return { ok: true, value: stored };
        }
        // Someone else wrote, or the key expired, between our read and our write:
        // read again, and either write on top of it or report the conflict. Waiting a
        // random moment first keeps two writers from losing to each other forever.
        await pause(
          Math.floor(Math.random() * Math.min(MAX_BACKOFF_MS, 2 ** attempt))
        );
      }
      return sqlFailure(
        LABEL,
        'conflict',
        key,
        `kept changing while it was being written (gave up after ${String(MAX_WRITE_ATTEMPTS)} tries${lastSeen === null ? '' : `, last saw revision ${String(lastSeen)}`})`
      );
    },

    async remove(key, { signal }) {
      const checked = refusal<null>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      try {
        await client.delete(checked.name);
      } catch (error: unknown) {
        return failedWith(error, key, 'removed');
      }
      listeners.notify(key, null);
      return { ok: true, value: null };
    },

    subscribe(key, onChange) {
      return listeners.subscribe(key, onChange);
    },
  };
}

/** The part of a `memcache-client` `MemcacheClient` this module calls. */
export interface MemcacheClientLike {
  gets(key: string): Promise<unknown>;
  add(
    key: string,
    value: string,
    options: { lifetime: number }
  ): Promise<unknown>;
  cas(
    key: string,
    value: string,
    options: { casUniq: string; lifetime: number }
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** The status word `memcache-client` rejects with, when it is one of the outcomes. */
function outcomeFromError(error: unknown): MemcachedStoreOutcome | null {
  const message: string = describeUnknownError(error).trim();
  if (message === 'NOT_STORED') {
    return 'not_stored';
  }
  if (message === 'EXISTS') {
    return 'exists';
  }
  if (message === 'NOT_FOUND') {
    return 'not_found';
  }
  return null;
}

/**
 * Wraps a `memcache-client` `MemcacheClient`. It rejects with the server's status
 * word (`NOT_STORED`, `EXISTS`, `NOT_FOUND`) instead of resolving it; this turns
 * those into outcomes and lets every other error through.
 */
export function memcachedFromMemcacheClient(
  client: MemcacheClientLike
): MemcachedClientLike {
  return {
    async gets(key) {
      const reply: unknown = await client.gets(key);
      if (reply === undefined || reply === null) {
        return null;
      }
      const found = reply as { value?: unknown; casUniq?: unknown };
      if (
        typeof found.value !== 'string' ||
        (typeof found.casUniq !== 'string' && typeof found.casUniq !== 'number')
      ) {
        // Not text (a Buffer, a number, JSON): not an entry of ours.
        return { value: '', casUniq: String(found.casUniq ?? '') };
      }
      return { value: found.value, casUniq: String(found.casUniq) };
    },
    async add(key, value, { ttlSeconds }) {
      try {
        await client.add(key, value, { lifetime: ttlSeconds });
        return 'stored';
      } catch (error: unknown) {
        const outcome = outcomeFromError(error);
        if (outcome === null) {
          throw error;
        }
        return outcome;
      }
    },
    async cas(key, value, casUniq, { ttlSeconds }) {
      try {
        await client.cas(key, value, { casUniq, lifetime: ttlSeconds });
        return 'stored';
      } catch (error: unknown) {
        const outcome = outcomeFromError(error);
        if (outcome === null) {
          throw error;
        }
        return outcome;
      }
    },
    async delete(key) {
      try {
        await client.delete(key);
      } catch (error: unknown) {
        if (outcomeFromError(error) === null) {
          throw error;
        }
      }
    },
  };
}
