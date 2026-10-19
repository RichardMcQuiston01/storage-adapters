/**
 * A `StorageAdapter` over a NATS JetStream key-value bucket. Like `/redis`, this is
 * an optional entry point that imports no client: you connect with the `@nats-io`
 * packages, open (or create) a bucket, and pass it in.
 */
import { describeUnknownError } from '../errors.js';
import { createChangeListeners, sqlFailure } from '../sql-shared.js';
import { decodeUtf8, utf8Bytes } from '../utf8.js';
import {
  compareKeys,
  prefixFailure,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** One entry of a bucket, as `Kv.get` and `Kv.watch` return it. */
export interface NatsKvEntryLike {
  /** The bucket's stream sequence number of this write. */
  readonly revision: number;
  /** `PUT` for a value; `DEL` and `PURGE` mark a removed key. */
  readonly operation: string;
  /** The value as text. */
  string(): string;
}

/** What `Kv.keys` and `Kv.watch` return: something to loop over, and to stop. */
export interface NatsKvIteratorLike<T> extends AsyncIterable<T> {
  stop(): void;
}

/**
 * The part of a `Kv` bucket (`@nats-io/kv`) this adapter calls. A bucket from
 * `new Kvm(connection).create(name)` or `.open(name)` fits as it is.
 */
export interface NatsKvLike {
  get(key: string): Promise<NatsKvEntryLike | null>;
  put(key: string, value: string): Promise<number>;
  /** Writes only if the key has no value (or its last entry is a removal). */
  create(key: string, value: string): Promise<number>;
  /** Writes only if the key's last entry has this revision. */
  update(key: string, value: string, revision: number): Promise<number>;
  purge(key: string): Promise<void>;
  keys(): Promise<NatsKvIteratorLike<string>>;
  watch(options: {
    key: string;
    include: 'updates';
  }): Promise<NatsKvIteratorLike<NatsKvEntryLike>>;
}

export interface NatsKvAdapterOptions {
  /** An open bucket. The adapter never closes it or the connection. */
  readonly kv: NatsKvLike;
  /** Called when a watch fails to start or stops, with a message naming the key. */
  readonly onWatchError?: (message: string) => void;
  /**
   * Milliseconds to wait before watching a key again after its watch fails or ends,
   * for as long as someone is subscribed to it. Defaults to 5000; `0` never retries.
   */
  readonly watchRetryMs?: number;
}

const LABEL = 'NATS KV';
const DEFAULT_RETRY_MS = 5000;
const MAX_ENCODED_KEY_LENGTH = 1024;
/** JetStream's error code for a write whose expected sequence did not match. */
const WRONG_LAST_SEQUENCE = 10071;

/**
 * Turns a key into a bucket key. NATS keys allow only letters, digits, `-`, `_`,
 * `=`, `/` and `.` (and no leading or trailing dot), so letters, digits, `-` and `_`
 * stay as they are and every other byte of the key's UTF-8 becomes `=` and two
 * uppercase hex digits. `=` itself is escaped and so is `.`, so no key can look like
 * a subject with wildcards or tokens. The encoding keeps prefixes: if a key starts
 * with a prefix, its encoded form starts with the prefix's. Returns `undefined`
 * for a key that cannot be stored.
 */
export function encodeNatsKey(key: string): string | undefined {
  let encoded = '';
  for (const char of key) {
    const codePoint: number = char.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return undefined; // A lone surrogate is not valid Unicode text.
    }
    if (/^[A-Za-z0-9_-]$/.test(char)) {
      encoded += char;
    } else {
      for (const byte of utf8Bytes(codePoint)) {
        encoded += `=${byte.toString(16).padStart(2, '0').toUpperCase()}`;
      }
    }
  }
  if (encoded === '' || encoded.length > MAX_ENCODED_KEY_LENGTH) {
    return undefined;
  }
  return encoded;
}

/**
 * The key a bucket key stands for: the reverse of `encodeNatsKey`. Returns
 * `undefined` for a name `encodeNatsKey` could not have made, so a key written by
 * something else into the same bucket is not mistaken for an entry.
 */
export function decodeNatsKey(name: string): string | undefined {
  let key = '';
  const bytes: number[] = [];
  const flush = (): boolean => {
    if (bytes.length === 0) {
      return true;
    }
    const text: string | undefined = decodeUtf8(bytes);
    bytes.length = 0;
    if (text === undefined) {
      return false;
    }
    key += text;
    return true;
  };
  for (let index = 0; index < name.length; index += 1) {
    const char: string = name.charAt(index);
    if (char === '=') {
      const hex: string = name.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) {
        return undefined;
      }
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else if (/^[A-Za-z0-9_-]$/.test(char)) {
      if (!flush()) {
        return undefined;
      }
      key += char;
    } else {
      return undefined;
    }
  }
  if (!flush()) {
    return undefined;
  }
  return encodeNatsKey(key) === name ? key : undefined;
}

function isWrongSequence(error: unknown): boolean {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return (
    code === WRONG_LAST_SEQUENCE ||
    /wrong last sequence/i.test(describeUnknownError(error))
  );
}

function classifyError(error: unknown): StoreErrorCode {
  const message: string = describeUnknownError(error);
  if (
    /permissions? violation|authorization violation|not authorized/i.test(
      message
    )
  ) {
    return 'forbidden';
  }
  if (/max_payload|maximum payload/i.test(message)) {
    return 'invalid';
  }
  if (
    /insufficient (storage )?resources|maximum (bytes|messages)|no space left/i.test(
      message
    )
  ) {
    return 'quota';
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
      ? `value is too large for the server's maximum payload (${describeUnknownError(error)})`
      : `could not be ${verb} (${describeUnknownError(error)})`;
  return sqlFailure(LABEL, code, key, detail);
}

/** What has been reported for a key, so a write is not announced twice. */
interface Seen {
  revision: number;
  removed: boolean;
}

interface Watching {
  count: number;
  stopped: boolean;
  stop: (() => void) | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  restarts: number;
}

/**
 * A `StorageAdapter` over a NATS JetStream key-value bucket. Revisions are the
 * bucket's stream sequence numbers: they only grow, but they are not a count per
 * key. `set` with `ifRevision` uses the server's own check, so it reports
 * `conflict` when another connection or process wrote first, and a key with
 * nothing stored is created. `subscribe` watches the key on the server, so it hears
 * changes made by any process. `list` reads every key in the bucket and filters, as
 * NATS cannot match part of a name. Nothing throws: every failure is a `StoreResult`.
 */
export function natsKvAdapter(options: NatsKvAdapterOptions): StorageAdapter {
  const { kv, onWatchError } = options;
  const retryMs: number = options.watchRetryMs ?? DEFAULT_RETRY_MS;
  const listeners = createChangeListeners();
  const seen = new Map<string, Seen>();
  const watches = new Map<string, Watching>();

  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): { name: string } | StoreResult<T> => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    const name: string | undefined = encodeNatsKey(key);
    if (name === undefined) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use this key: it must be text of at most ${String(MAX_ENCODED_KEY_LENGTH)} characters once escaped, and not empty`
      );
    }
    return { name };
  };

  const stored = (entry: NatsKvEntryLike): StoredValue => ({
    value: entry.string(),
    revision: String(entry.revision),
  });

  /** Reads what the bucket holds for a key. */
  const readName = async (
    key: string,
    name: string
  ): Promise<StoreResult<NatsKvEntryLike | null>> => {
    try {
      const entry: NatsKvEntryLike | null = await kv.get(name);
      if (entry === null || entry.operation !== 'PUT') {
        return { ok: true, value: null };
      }
      return { ok: true, value: entry };
    } catch (error: unknown) {
      return failedWith(error, key, 'read');
    }
  };

  /** Tells subscribers about a write or removal unless they have already heard. */
  const settle = (
    key: string,
    revision: number | null,
    value: string | null
  ): void => {
    if (!listeners.has(key)) {
      return;
    }
    const known: Seen | undefined = seen.get(key);
    if (value === null) {
      // `revision` is the removal marker's, or null for our own purge (not known).
      if (known?.removed === true) {
        if (revision !== null && revision > known.revision) {
          known.revision = revision;
        }
        return;
      }
      if (
        revision !== null &&
        known !== undefined &&
        revision <= known.revision
      ) {
        return;
      }
      seen.set(key, {
        revision: revision ?? known?.revision ?? 0,
        removed: true,
      });
      listeners.notify(key, null);
      return;
    }
    if (
      revision === null ||
      (known !== undefined && revision <= known.revision)
    ) {
      return;
    }
    seen.set(key, { revision, removed: false });
    listeners.notify(key, { value, revision: String(revision) });
  };

  const reportWatchError = (
    key: string,
    action: string,
    error: unknown
  ): void => {
    try {
      onWatchError?.(
        `${LABEL} could not ${action} for key "${key}" (${describeUnknownError(error)})`
      );
    } catch {
      // A faulty error handler must not break the adapter.
    }
  };

  const handleEntry = (key: string, entry: NatsKvEntryLike): void => {
    try {
      settle(
        key,
        entry.revision,
        entry.operation === 'PUT' ? entry.string() : null
      );
    } catch (error: unknown) {
      reportWatchError(key, 'read a change', error);
    }
  };

  /**
   * Compares the bucket with what subscribers were last told. The first time a key
   * is watched this only records where it stands, so the next change is reported
   * against something; after a watch restarts it also reports what changed while
   * the watch was down.
   */
  const catchUp = async (
    key: string,
    name: string,
    restarted: boolean
  ): Promise<void> => {
    const before: Seen | undefined = seen.get(key);
    const read = await readName(key, name);
    if (!read.ok || seen.get(key)?.revision !== before?.revision) {
      return; // Unreadable, or the watch has delivered something newer meanwhile.
    }
    if (before === undefined) {
      seen.set(
        key,
        read.value === null
          ? { revision: 0, removed: true }
          : { revision: read.value.revision, removed: false }
      );
    } else if (restarted) {
      settle(
        key,
        read.value?.revision ?? null,
        read.value === null ? null : read.value.string()
      );
    }
  };

  const startWatching = (key: string, state: Watching): void => {
    const name: string | undefined = encodeNatsKey(key);
    if (name === undefined || state.stopped) {
      return;
    }
    const restarted: boolean = state.restarts > 0;
    const run = async (): Promise<void> => {
      try {
        const iterator = await kv.watch({ key: name, include: 'updates' });
        if (state.stopped) {
          iterator.stop();
          return;
        }
        state.stop = () => {
          iterator.stop();
        };
        void catchUp(key, name, restarted);
        for await (const entry of iterator) {
          handleEntry(key, entry);
        }
      } catch (error: unknown) {
        if (!state.stopped) {
          reportWatchError(key, 'watch', error);
        }
      }
      state.stop = null;
      if (!state.stopped && retryMs > 0) {
        state.restarts += 1;
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          startWatching(key, state);
        }, retryMs);
        // A pending retry alone should not keep a Node-style process running.
        (state.retryTimer as { unref?: () => void }).unref?.();
      }
    };
    void run();
  };

  return {
    async get(key, { signal }) {
      const checked = refusal<StoredValue | null>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      const read = await readName(key, checked.name);
      if (!read.ok) {
        return read;
      }
      if (read.value === null) {
        return { ok: true, value: null };
      }
      try {
        return { ok: true, value: stored(read.value) };
      } catch (error: unknown) {
        return sqlFailure(
          LABEL,
          'corrupt',
          key,
          `holds a value that is not readable text (${describeUnknownError(error)})`
        );
      }
    },

    async set(key, value, { signal, ifRevision }) {
      const checked = refusal<StoredValue>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      const { name } = checked;
      const conflict = async (): Promise<StoreResult<StoredValue>> => {
        const current = await readName(key, name);
        const holds: string =
          current.ok && current.value !== null
            ? `holds revision ${String(current.value.revision)}`
            : 'changed';
        return sqlFailure(
          LABEL,
          'conflict',
          key,
          `${holds}, but revision ${ifRevision ?? ''} was expected`
        );
      };
      try {
        let revision: number;
        if (ifRevision === undefined) {
          revision = await kv.put(name, value);
        } else {
          const expected: number = /^[0-9]{1,15}$/.test(ifRevision)
            ? Number(ifRevision)
            : 0;
          try {
            // A revision that is not a plain number can never match; sequence 0 is
            // the server's "no entry yet", which is what creating a key means.
            revision =
              expected === 0
                ? await kv.create(name, value)
                : await kv.update(name, value, expected);
          } catch (error: unknown) {
            if (!isWrongSequence(error)) {
              throw error;
            }
            if (expected === 0) {
              return await conflict(); // The create above found a value.
            }
            // The revision did not match. If nothing is stored there is no revision
            // to differ, so create the key; if a value is, that create fails.
            try {
              revision = await kv.create(name, value);
            } catch (second: unknown) {
              if (isWrongSequence(second)) {
                return await conflict();
              }
              throw second;
            }
          }
        }
        const result: StoredValue = { value, revision: String(revision) };
        settle(key, revision, value);
        return { ok: true, value: result };
      } catch (error: unknown) {
        return failedWith(error, key, 'written');
      }
    },

    async remove(key, { signal }) {
      const checked = refusal<null>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      try {
        await kv.purge(checked.name);
      } catch (error: unknown) {
        return failedWith(error, key, 'removed');
      }
      settle(key, null, null);
      return { ok: true, value: null };
    },

    async list(keyPrefix, { signal }) {
      if (signal.aborted) {
        return prefixFailure(
          LABEL,
          'unavailable',
          keyPrefix,
          'request to list keys was aborted'
        );
      }
      try {
        const found: string[] = [];
        const iterator = await kv.keys();
        for await (const name of iterator) {
          const key: string | undefined = decodeNatsKey(name);
          if (key !== undefined && key.startsWith(keyPrefix)) {
            found.push(key);
          }
        }
        return { ok: true, value: found.sort(compareKeys) };
      } catch (error: unknown) {
        return prefixFailure(
          LABEL,
          classifyError(error),
          keyPrefix,
          `could not list keys (${describeUnknownError(error)})`
        );
      }
    },

    subscribe(key, onChange) {
      const unsubscribe: () => void = listeners.subscribe(key, onChange);
      let state: Watching | undefined = watches.get(key);
      if (state === undefined) {
        state = {
          count: 0,
          stopped: false,
          stop: null,
          retryTimer: null,
          restarts: 0,
        };
        watches.set(key, state);
        startWatching(key, state);
      }
      state.count += 1;
      const mine: Watching = state;
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        unsubscribe();
        mine.count -= 1;
        if (mine.count > 0) {
          return;
        }
        mine.stopped = true;
        watches.delete(key);
        seen.delete(key);
        if (mine.retryTimer !== null) {
          clearTimeout(mine.retryTimer);
          mine.retryTimer = null;
        }
        try {
          mine.stop?.();
        } catch (error: unknown) {
          reportWatchError(key, 'stop watching', error);
        }
      };
    },
  };
}
