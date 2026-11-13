/**
 * A `StorageAdapter` over a Google Cloud Storage bucket. Like `/s3`, this is an optional
 * entry point that imports no SDK. You give it a small `GcsStoreLike`;
 * `gcsObjectStore()` makes one from a bucket of `@google-cloud/storage`.
 *
 * Unlike most stores here, GCS can check a revision atomically: every write can say "only
 * if the object's generation is N", and the adapter uses the generation as the revision.
 */
import { describeUnknownError } from '../errors.js';
import { decodeUtf8 } from '../utf8.js';
import { createChangeListeners, sqlFailure } from '../sql-shared.js';
import {
  compareKeys,
  prefixFailure,
  utf8Length,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** An object read from the store: its text and its generation, as text. */
export interface GcsObjectLike {
  readonly body: string;
  /** The object's generation: a whole number that changes every time the object is written. */
  readonly generation: string;
}

/**
 * The part of a bucket this adapter uses. Reject with the client's own error, unchanged:
 * the adapter reads its HTTP status (`code`, `status` or `response.status`) to tell a
 * missing object, a failed condition and a permission problem apart.
 */
export interface GcsStoreLike {
  /** Resolves `null` for an object that does not exist (rejecting with 404 also works). */
  getObject(
    key: string,
    options: { readonly signal: AbortSignal }
  ): Promise<GcsObjectLike | null>;
  /**
   * Writes the object and says which generation it wrote. With `ifGenerationMatch`, only
   * if the object's current generation is that value (HTTP 412 if not); `'0'` means only
   * if there is no object.
   */
  putObject(
    key: string,
    body: string,
    options: {
      readonly signal: AbortSignal;
      readonly ifGenerationMatch?: string;
    }
  ): Promise<{ readonly generation: string }>;
  /** Deleting an object that is not there is not an error. */
  deleteObject(
    key: string,
    options: { readonly signal: AbortSignal }
  ): Promise<void>;
  /**
   * Optional. Every object name that starts with `prefix`, following the store's pages
   * until the list is complete. Without it `list` reports that it is not supported.
   */
  listKeys?(
    prefix: string,
    options: { readonly signal: AbortSignal }
  ): Promise<string[]>;
}

export interface GcsAdapterOptions {
  readonly store: GcsStoreLike;
  /** Put in front of every key, for example `"settings/"`. Defaults to none. */
  readonly prefix?: string;
  /** Names the store in messages. Defaults to `"Google Cloud Storage"`. */
  readonly name?: string;
}

const DEFAULT_NAME = 'Google Cloud Storage';
/** Object names can be at most 1024 bytes of UTF-8. */
const MAX_KEY_BYTES = 1024;
/** The largest value stored, in UTF-8 bytes. Values travel in one request and sit in memory. */
export const MAX_VALUE_BYTES = 32_000_000;
const MAX_DETAIL_LENGTH = 300;

function hasLoneSurrogate(text: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    text
  );
}

/** The HTTP status a client error carries, if any. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
  };
  for (const value of [
    candidate.code,
    candidate.status,
    candidate.statusCode,
    candidate.response?.status,
    candidate.response?.statusCode,
  ]) {
    const status: number =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : NaN;
    if (Number.isInteger(status) && status >= 400 && status < 600) {
      return status;
    }
  }
  return undefined;
}

function shorten(text: string): string {
  const said: string = text.trim().replace(/\s+/g, ' ');
  return said.length > MAX_DETAIL_LENGTH
    ? `${said.slice(0, MAX_DETAIL_LENGTH)}...`
    : said;
}

const isFailedCondition = (error: unknown): boolean => statusOf(error) === 412;
const isMissing = (error: unknown): boolean => statusOf(error) === 404;

/** A name the store would refuse: empty, too long, with a line break, or a reserved one. */
function keyProblem(objectKey: string): string | undefined {
  if (objectKey === '') {
    return 'the key is empty';
  }
  if (hasLoneSurrogate(objectKey)) {
    return 'the key is not valid Unicode text';
  }
  if (utf8Length(objectKey) > MAX_KEY_BYTES) {
    return `the key is longer than ${String(MAX_KEY_BYTES)} bytes of UTF-8`;
  }
  if (/[\r\n]/.test(objectKey)) {
    return 'the key has a line break, which object names may not have';
  }
  if (objectKey === '.' || objectKey === '..') {
    return 'the key is "." or "..", which object names may not be';
  }
  if (objectKey.startsWith('.well-known/acme-challenge/')) {
    return 'the key starts with ".well-known/acme-challenge/", which object names may not';
  }
  return undefined;
}

/**
 * A `StorageAdapter` over a Google Cloud Storage bucket. Each key is an object and its
 * generation is the revision. `set` with `ifRevision` is a conditional write
 * (`ifGenerationMatch`), so two writers holding the same revision cannot both win: one
 * gets `conflict`, across processes and machines. A key with nothing stored is created
 * with `ifGenerationMatch: 0`, so two writers creating it at once cannot both win either.
 * A write without `ifRevision` replaces whatever is stored. `subscribe` reports changes
 * made through the same adapter. GCS allows about one write a second to a single object
 * name, so a key written in a tight loop can be answered with `unavailable` (HTTP 429).
 * Nothing throws: every failure is a `StoreResult`.
 */
export function gcsAdapter(options: GcsAdapterOptions): StorageAdapter {
  const { store } = options;
  const prefix: string = options.prefix ?? '';
  const label: string = options.name ?? DEFAULT_NAME;
  const listeners = createChangeListeners();

  const objectKeyOf = (key: string): string => `${prefix}${key}`;

  /** Runs one store call; an abort rejects it at once, whatever the store does with the signal. */
  const raced = async <T>(
    signal: AbortSignal,
    send: () => Promise<T>
  ): Promise<T> => {
    if (signal.aborted) {
      throw new Error('request was aborted');
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => reject(new Error('request was aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([send(), aborted]);
    } finally {
      if (onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
      // A call that finishes after an abort must not leave an unhandled rejection.
      aborted.catch(() => undefined);
    }
  };

  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): StoreResult<T> | null => {
    if (signal.aborted) {
      return sqlFailure(label, 'unavailable', key, 'request was aborted');
    }
    const problem: string | undefined = keyProblem(objectKeyOf(key));
    return problem === undefined
      ? null
      : sqlFailure(label, 'invalid', key, `cannot use this key: ${problem}`);
  };

  /** Turns what the client threw into a result that says what to do. */
  const failedWith = <T>(
    error: unknown,
    key: string,
    action: string
  ): StoreResult<T> => {
    const message: string = shorten(describeUnknownError(error));
    const status: number | undefined = statusOf(error);
    let code: StoreErrorCode = 'unavailable';
    let hint = '';
    if (/request was aborted/.test(message)) {
      return sqlFailure(label, 'unavailable', key, 'request was aborted');
    }
    if (/not valid UTF-8/i.test(message)) {
      code = 'corrupt';
    } else if (status === 401) {
      code = 'forbidden';
      hint =
        " (the client's credentials were not accepted: check the key file or token)";
    } else if (status === 403) {
      code = 'forbidden';
      hint = /storage\.objects|permission|access/i.test(message)
        ? ' (the account the client signs in as lacks permission on this bucket: it needs the Storage Object Admin role, or storage.objects.create, get, delete and list)'
        : '';
    } else if (status === 404) {
      hint =
        ' (the bucket was not found: check its name, and that the account can see it)';
    } else if (status === 429) {
      hint =
        ' (Google Cloud Storage allows about one write a second to a single object name, and limits other request rates: slow down)';
    } else if (status === 400 || status === 413) {
      code = 'invalid';
    }
    return sqlFailure(
      label,
      code,
      key,
      status === undefined && code === 'unavailable'
        ? `could not be ${action} (could not be reached: ${message})`
        : `could not be ${action} (${message})${hint}`
    );
  };

  const stored = (
    key: string,
    value: string,
    generation: string
  ): StoreResult<StoredValue> => {
    if (generation === '') {
      return sqlFailure(
        label,
        'unavailable',
        key,
        'was written, but the store did not say which generation it wrote, so there is no revision to return'
      );
    }
    const result: StoredValue = { value, revision: generation };
    listeners.notify(key, result);
    return { ok: true, value: result };
  };

  const conflict = (
    key: string,
    ifRevision: string,
    holds: string | undefined
  ): StoreResult<StoredValue> =>
    sqlFailure(
      label,
      'conflict',
      key,
      holds === undefined
        ? `changed while it was being written, so revision ${ifRevision} no longer applies`
        : `holds revision ${holds}, but revision ${ifRevision} was expected`
    );

  return {
    async get(key, { signal }) {
      const refused = refusal<StoredValue | null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      try {
        const found = await raced(signal, () =>
          store.getObject(objectKeyOf(key), { signal })
        );
        if (found === null) {
          return { ok: true, value: null };
        }
        if (
          typeof found.body !== 'string' ||
          typeof found.generation !== 'string' ||
          found.generation === ''
        ) {
          return sqlFailure(
            label,
            'corrupt',
            key,
            'holds an object that is not text with a generation'
          );
        }
        return {
          ok: true,
          value: { value: found.body, revision: found.generation },
        };
      } catch (error: unknown) {
        if (isMissing(error)) {
          return { ok: true, value: null };
        }
        return failedWith(error, key, 'read');
      }
    },

    async set(key, value, { signal, ifRevision }) {
      const refused = refusal<StoredValue>(key, signal);
      if (refused !== null) {
        return refused;
      }
      if (hasLoneSurrogate(value)) {
        return sqlFailure(
          label,
          'invalid',
          key,
          'cannot store this value: it is not valid Unicode text'
        );
      }
      if (utf8Length(value) > MAX_VALUE_BYTES) {
        return sqlFailure(
          label,
          'invalid',
          key,
          `cannot store this value: it takes ${String(utf8Length(value))} bytes and the limit is ${String(MAX_VALUE_BYTES)}`
        );
      }
      const objectKey: string = objectKeyOf(key);
      try {
        if (ifRevision === undefined) {
          const written = await raced(signal, () =>
            store.putObject(objectKey, value, { signal })
          );
          return stored(key, value, written.generation);
        }
        // A generation is a whole number above zero; anything else can never match.
        if (/^[1-9][0-9]{0,18}$/.test(ifRevision)) {
          try {
            const written = await raced(signal, () =>
              store.putObject(objectKey, value, {
                signal,
                ifGenerationMatch: ifRevision,
              })
            );
            return stored(key, value, written.generation);
          } catch (error: unknown) {
            // A different generation answers 412, and so may no object at all (404).
            if (!isFailedCondition(error) && !isMissing(error)) {
              throw error;
            }
          }
        }
        const current = await raced(signal, () =>
          store.getObject(objectKey, { signal })
        ).catch((error: unknown) => {
          if (isMissing(error)) {
            return null;
          }
          throw error;
        });
        if (current !== null) {
          return conflict(key, ifRevision, current.generation);
        }
        // Nothing is stored, so there is no revision to differ from: create it, but only
        // if no one else has by now.
        try {
          const created = await raced(signal, () =>
            store.putObject(objectKey, value, {
              signal,
              ifGenerationMatch: '0',
            })
          );
          return stored(key, value, created.generation);
        } catch (error: unknown) {
          if (isFailedCondition(error)) {
            return conflict(key, ifRevision, undefined);
          }
          throw error;
        }
      } catch (error: unknown) {
        return failedWith(error, key, 'written');
      }
    },

    async remove(key, { signal }) {
      const refused = refusal<null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      try {
        await raced(signal, () =>
          store.deleteObject(objectKeyOf(key), { signal })
        );
      } catch (error: unknown) {
        if (!isMissing(error)) {
          return failedWith(error, key, 'removed');
        }
      }
      listeners.notify(key, null);
      return { ok: true, value: null };
    },

    async list(keyPrefix, { signal }) {
      if (signal.aborted) {
        return prefixFailure(
          label,
          'unavailable',
          keyPrefix,
          'request to list keys was aborted'
        );
      }
      if (hasLoneSurrogate(keyPrefix)) {
        return prefixFailure(
          label,
          'invalid',
          keyPrefix,
          'cannot use this prefix: it is not valid Unicode text'
        );
      }
      if (store.listKeys === undefined) {
        return prefixFailure(
          label,
          'invalid',
          keyPrefix,
          'cannot list keys: the store has no listKeys'
        );
      }
      const listKeys = store.listKeys.bind(store);
      try {
        const names: string[] = await raced(signal, () =>
          listKeys(objectKeyOf(keyPrefix), { signal })
        );
        const keys: string[] = [];
        for (const name of names) {
          if (name.startsWith(prefix)) {
            keys.push(name.slice(prefix.length));
          }
        }
        return { ok: true, value: keys.sort(compareKeys) };
      } catch (error: unknown) {
        const aborted: boolean = /request was aborted/.test(
          describeUnknownError(error)
        );
        return prefixFailure(
          label,
          'unavailable',
          keyPrefix,
          aborted
            ? 'request to list keys was aborted'
            : `could not list keys (${shorten(describeUnknownError(error))})`
        );
      }
    },

    subscribe(key, onChange) {
      return listeners.subscribe(key, onChange);
    },
  };
}

/** What a `File` from `@google-cloud/storage` is asked to do here. */
export interface GcsFileLike {
  /** Filled in by the client once `save` has finished: the object's resource. */
  readonly metadata?:
    { readonly generation?: string | number | null } | null | undefined;
  getMetadata(): Promise<
    readonly [{ readonly generation?: string | number | null }, ...unknown[]]
  >;
  download(): Promise<readonly [Uint8Array, ...unknown[]]>;
  save(
    data: string,
    options: {
      readonly resumable?: boolean;
      readonly contentType?: string;
      readonly preconditionOpts?: {
        readonly ifGenerationMatch?: string | number;
      };
    }
  ): Promise<void>;
  delete(options?: { readonly ignoreNotFound?: boolean }): Promise<unknown>;
}

/** What a `Bucket` from `@google-cloud/storage` is asked to do here. */
export interface GcsBucketLike {
  file(
    name: string,
    options?: { readonly generation?: string | number }
  ): GcsFileLike;
  getFiles(options: {
    readonly prefix?: string;
  }): Promise<readonly [readonly { readonly name: string }[], ...unknown[]]>;
}

export interface GcsObjectStoreOptions {
  /** A bucket from `@google-cloud/storage`: `new Storage().bucket('my-bucket')`. */
  readonly bucket: GcsBucketLike;
}

/** How many times a read starts again when the object is replaced while it is being read. */
const MAX_READ_ATTEMPTS = 3;

/**
 * Makes a `GcsStoreLike` from a bucket of `@google-cloud/storage`. A read asks for the
 * object's generation first, then downloads exactly that generation, so the text and the
 * revision always belong together even if the object is replaced in between (the read
 * starts again). A write sends one simple upload and reads the generation from the
 * answer. Nothing here imports the client: pass in its bucket.
 */
export function gcsObjectStore(options: GcsObjectStoreOptions): GcsStoreLike {
  const { bucket } = options;
  return {
    async getObject(key) {
      for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
        let generation: string;
        try {
          const [metadata] = await bucket.file(key).getMetadata();
          const said: string | number | null | undefined = metadata.generation;
          if (said === undefined || said === null || String(said) === '') {
            throw new Error("did not say the object's generation");
          }
          generation = String(said);
        } catch (error: unknown) {
          if (isMissing(error)) {
            return null;
          }
          throw error;
        }
        let bytes: Uint8Array;
        try {
          [bytes] = await bucket.file(key, { generation }).download();
        } catch (error: unknown) {
          if (isMissing(error)) {
            // Replaced or deleted between the two requests: look again.
            continue;
          }
          throw error;
        }
        const text: string | undefined = decodeUtf8(Array.from(bytes));
        if (text === undefined) {
          throw new Error('holds bytes that are not valid UTF-8 text');
        }
        return { body: text, generation };
      }
      throw new Error(
        'kept changing while it was being read (gave up after a few tries)'
      );
    },

    async putObject(key, body, { ifGenerationMatch }) {
      const file: GcsFileLike = bucket.file(key);
      await file.save(body, {
        resumable: false,
        contentType: 'text/plain; charset=utf-8',
        ...(ifGenerationMatch === undefined
          ? {}
          : { preconditionOpts: { ifGenerationMatch } }),
      });
      const generation: string | number | null | undefined =
        file.metadata?.generation;
      return {
        generation:
          generation === undefined || generation === null
            ? ''
            : String(generation),
      };
    },

    async deleteObject(key) {
      await bucket.file(key).delete({ ignoreNotFound: true });
    },

    async listKeys(prefix) {
      const [files] = await bucket.getFiles({ prefix });
      return files.map((file) => file.name);
    },
  };
}
