/**
 * A `StorageAdapter` over an S3-compatible object store: Amazon S3, DigitalOcean
 * Spaces, MinIO, Cloudflare R2 and others. Like `/sqlite` and `/postgres`, this is
 * an optional entry point that imports no SDK. You give it a small
 * `ObjectStoreLike`; `awsSdkObjectStore()` makes one from the AWS SDK for
 * JavaScript v3 (or anything that sends its commands).
 */
import { describeUnknownError } from '../errors.js';
import { createChangeListeners, sqlFailure } from '../sql-shared.js';
import {
  utf8Length,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** An object read from the store: its text and its ETag, exactly as the store gave it. */
export interface StoredObjectLike {
  readonly body: string;
  readonly etag: string;
}

/**
 * The part of an object store this adapter uses. Reject with the SDK's own error,
 * unchanged: the adapter reads its `name`, `Code` or `code` and its HTTP status
 * (`$metadata.httpStatusCode`, `statusCode` or `status`) to tell a missing key, a
 * failed condition or a permission problem apart.
 */
export interface ObjectStoreLike {
  /** Resolves `null` for a key that does not exist (rejecting with 404 also works). */
  getObject(
    key: string,
    options: { readonly signal: AbortSignal }
  ): Promise<StoredObjectLike | null>;
  /**
   * Writes the object. With `ifMatch`, only if its ETag is that value (HTTP 412 if
   * not, 404 if there is no object). With `ifNoneMatch: '*'`, only if there is no
   * object (412 if there is).
   */
  putObject(
    key: string,
    body: string,
    options: {
      readonly signal: AbortSignal;
      readonly ifMatch?: string;
      readonly ifNoneMatch?: '*';
    }
  ): Promise<{ readonly etag: string }>;
  /** Deleting a key that is not there is not an error. */
  deleteObject(
    key: string,
    options: { readonly signal: AbortSignal }
  ): Promise<void>;
}

export interface S3AdapterOptions {
  readonly store: ObjectStoreLike;
  /** Put in front of every key, for example `"settings/"`. Defaults to none. */
  readonly prefix?: string;
  /** Names the store in messages, for example `"DigitalOcean Spaces"`. Defaults to `"S3"`. */
  readonly name?: string;
  /**
   * Before the first write that uses `ifRevision`, check once that the store handles
   * `If-Match` and `If-None-Match` correctly (a few extra requests on a throwaway
   * object): it must refuse a second create and a wrong ETag, and accept an object's
   * own ETag. A store that ignores the headers would silently lose the conflict
   * check, and one that refuses a matching ETag would fail every check, so such a
   * write is refused with `invalid` and a message saying which. Set `false` if you
   * know your store handles them, as Amazon S3 does. Defaults to `true`.
   */
  readonly verifyConditionalWrites?: boolean;
}

const DEFAULT_NAME = 'S3';
/** Object keys can be at most 1024 bytes of UTF-8. */
const MAX_KEY_BYTES = 1024;
/** A conditional write is retried this many times if its object keeps appearing and vanishing. */
const MAX_WRITE_ATTEMPTS = 3;

function stringField(error: unknown, field: string): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const value: unknown = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/** The HTTP status an SDK error carries, if any. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const fields = error as {
    $metadata?: { httpStatusCode?: unknown };
    statusCode?: unknown;
    status?: unknown;
    $response?: { statusCode?: unknown };
  };
  const status: unknown =
    fields.$metadata?.httpStatusCode ??
    fields.statusCode ??
    fields.status ??
    fields.$response?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/** The error's name or S3 error code, such as `NoSuchKey`. */
function codeOf(error: unknown): string {
  return (
    stringField(error, 'Code') ??
    stringField(error, 'name') ??
    stringField(error, 'code') ??
    ''
  );
}

function isMissingObject(error: unknown): boolean {
  const code: string = codeOf(error);
  return (
    code === 'NoSuchKey' ||
    code === 'NotFound' ||
    (statusOf(error) === 404 && code !== 'NoSuchBucket')
  );
}

function isFailedCondition(error: unknown): boolean {
  const code: string = codeOf(error);
  return (
    statusOf(error) === 412 ||
    statusOf(error) === 409 ||
    code === 'PreconditionFailed' ||
    code === 'ConditionalRequestConflict'
  );
}

function isNotImplemented(error: unknown): boolean {
  const code: string = codeOf(error);
  return (
    statusOf(error) === 501 ||
    code === 'NotImplemented' ||
    code === 'XNotImplemented'
  );
}

/** Maps an SDK error to an error code. */
function classifyError(error: unknown): StoreErrorCode {
  const status: number | undefined = statusOf(error);
  const code: string = codeOf(error);
  const message: string = describeUnknownError(error);
  if (
    status === 507 ||
    /^(QuotaExceeded|StorageLimitExceeded|ServiceQuotaExceeded|InsufficientStorage|MaxMessageLengthExceeded)$/.test(
      code
    ) ||
    /quota exceeded|no space left/i.test(message)
  ) {
    return 'quota';
  }
  if (
    status === 401 ||
    status === 403 ||
    /^(AccessDenied|AllAccessDisabled|InvalidAccessKeyId|SignatureDoesNotMatch|ExpiredToken|InvalidToken|AccountProblem|Forbidden|Unauthorized)$/.test(
      code
    )
  ) {
    return 'forbidden';
  }
  if (
    status === 413 ||
    /^(EntityTooLarge|KeyTooLongError|InvalidArgument|InvalidRequest|InvalidKey|MalformedXML|InvalidBucketName|EntityTooSmall)$/.test(
      code
    )
  ) {
    return 'invalid';
  }
  return 'unavailable';
}

/**
 * A key the store would refuse or, worse, misread: empty, over 1024 bytes, or with a
 * `.` or `..` path segment that URL handling collapses into a different key.
 */
function keyProblem(objectKey: string): string | undefined {
  if (objectKey === '') {
    return 'the key is empty';
  }
  if (utf8Length(objectKey) > MAX_KEY_BYTES) {
    return `the key is longer than ${MAX_KEY_BYTES} bytes of UTF-8`;
  }
  if (objectKey.split('/').some((part) => part === '.' || part === '..')) {
    return 'the key has a "." or ".." path segment, which URLs treat as a directory step';
  }
  return undefined;
}

/**
 * A `StorageAdapter` over an S3-compatible bucket. Each key is an object and its
 * ETag is the revision, so a value written again unchanged keeps its revision. `set`
 * with `ifRevision` is a conditional write (`If-Match`), so two writers holding the
 * same revision cannot both win: one gets `conflict`. A key with nothing stored is
 * created, with `If-None-Match: *`. Stores that ignore conditional writes are
 * detected, and a revision check on them is refused with `invalid`. `subscribe`
 * reports changes made through the same adapter. Nothing throws: every failure is a
 * `StoreResult`.
 */
export function s3Adapter(options: S3AdapterOptions): StorageAdapter {
  const { store } = options;
  const prefix: string = options.prefix ?? '';
  const label: string = options.name ?? DEFAULT_NAME;
  const verify: boolean = options.verifyConditionalWrites ?? true;
  const listeners = createChangeListeners();
  let support: Promise<string | null> | null = verify
    ? null
    : Promise.resolve(null);

  const objectKeyOf = (key: string): string => `${prefix}${key}`;

  /**
   * Checks once that the store handles conditional writes correctly, on a throwaway
   * object: a create that must succeed, a second create and a write with the wrong
   * ETag that must be refused, and a write with the object's own ETag that must be
   * accepted. Resolves why the store cannot be used, or `null` if it can. A failure
   * to find out (no permission, network) is thrown and not remembered, so the next
   * write checks again.
   */
  const conditionalWritesProblem = (
    signal: AbortSignal
  ): Promise<string | null> => {
    if (support === null) {
      const probeKey = `${prefix}.storage-adapters-probe-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      const notImplemented = 'does not implement conditional writes (If-Match)';
      const run = async (): Promise<string | null> => {
        let created = false;
        try {
          let etag: string;
          try {
            etag = (
              await store.putObject(probeKey, 'probe', {
                signal,
                ifNoneMatch: '*',
              })
            ).etag;
            created = true;
          } catch (error: unknown) {
            if (isNotImplemented(error) || statusOf(error) === 400) {
              return notImplemented;
            }
            throw error;
          }
          for (const condition of [
            { ifNoneMatch: '*' as const },
            { ifMatch: '"storage-adapters-probe"' },
          ]) {
            try {
              await store.putObject(probeKey, 'probe', {
                signal,
                ...condition,
              });
              return 'ignores If-Match and If-None-Match, so a revision check would be silently skipped';
            } catch (error: unknown) {
              if (isNotImplemented(error)) {
                return notImplemented;
              }
              if (!isFailedCondition(error)) {
                throw error;
              }
            }
          }
          if (etag === '') {
            return 'returned no ETag to use as a revision';
          }
          try {
            await store.putObject(probeKey, 'probe', { signal, ifMatch: etag });
          } catch (error: unknown) {
            if (isNotImplemented(error)) {
              return notImplemented;
            }
            if (isFailedCondition(error)) {
              return "refuses a write whose If-Match is the object's own ETag, so every revision check would fail";
            }
            throw error;
          }
          return null;
        } finally {
          if (created) {
            try {
              await store.deleteObject(probeKey, { signal });
            } catch {
              // A leftover probe object is harmless.
            }
          }
        }
      };
      support = run();
      support.catch(() => {
        support = null;
      });
    }
    return support;
  };

  /** What the key holds now, for the conflict message. Never throws. */
  const currentRevision = async (
    objectKey: string,
    signal: AbortSignal
  ): Promise<string | null | undefined> => {
    try {
      const found = await store.getObject(objectKey, { signal });
      return found === null ? null : found.etag;
    } catch (error: unknown) {
      return isMissingObject(error) ? null : undefined;
    }
  };

  const failedWith = <T>(
    error: unknown,
    key: string,
    verb: string
  ): StoreResult<T> =>
    sqlFailure(
      label,
      classifyError(error),
      key,
      `could not be ${verb} (${describeUnknownError(error)})`
    );

  /** Why this call cannot go ahead, or null if it can. */
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
      : sqlFailure(label, 'invalid', key, `cannot be stored: ${problem}`);
  };

  const stored = (
    key: string,
    value: string,
    etag: string
  ): StoreResult<StoredValue> => {
    if (etag === '') {
      return sqlFailure(
        label,
        'unavailable',
        key,
        'was written, but the store returned no ETag to use as its revision'
      );
    }
    const result: StoredValue = { value, revision: etag };
    listeners.notify(key, result);
    return { ok: true, value: result };
  };

  return {
    async get(key, { signal }) {
      const refused = refusal<StoredValue | null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      try {
        const found = await store.getObject(objectKeyOf(key), { signal });
        if (found === null) {
          return { ok: true, value: null };
        }
        if (typeof found.body !== 'string' || typeof found.etag !== 'string') {
          return sqlFailure(
            label,
            'corrupt',
            key,
            'holds an object that is not text with an ETag'
          );
        }
        return { ok: true, value: { value: found.body, revision: found.etag } };
      } catch (error: unknown) {
        if (isMissingObject(error)) {
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
      const objectKey: string = objectKeyOf(key);
      try {
        if (ifRevision === undefined) {
          const written = await store.putObject(objectKey, value, { signal });
          return stored(key, value, written.etag);
        }
        const problem: string | null = await conditionalWritesProblem(signal);
        if (problem !== null) {
          return sqlFailure(
            label,
            'invalid',
            key,
            `cannot check revision ${ifRevision}: ${label} ${problem}. Write without ifRevision (last write wins), or set verifyConditionalWrites to false if you know it works`
          );
        }
        for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
          try {
            const written = await store.putObject(objectKey, value, {
              signal,
              ifMatch: ifRevision,
            });
            return stored(key, value, written.etag);
          } catch (error: unknown) {
            if (isMissingObject(error)) {
              // Nothing is stored, so the key is created: only if still absent.
              try {
                const created = await store.putObject(objectKey, value, {
                  signal,
                  ifNoneMatch: '*',
                });
                return stored(key, value, created.etag);
              } catch (createError: unknown) {
                if (!isFailedCondition(createError)) {
                  throw createError;
                }
                // Someone created it first: compare again.
              }
            } else if (!isFailedCondition(error)) {
              throw error;
            }
          }
          const current = await currentRevision(objectKey, signal);
          if (current !== null) {
            return sqlFailure(
              label,
              'conflict',
              key,
              current === undefined
                ? `changed since revision ${ifRevision} was read`
                : `holds revision ${current}, but revision ${ifRevision} was expected`
            );
          }
          // The object was removed in between, so write again as new.
        }
        return sqlFailure(
          label,
          'unavailable',
          key,
          'changed too often to be written'
        );
      } catch (error: unknown) {
        if (isNotImplemented(error) && ifRevision !== undefined) {
          return sqlFailure(
            label,
            'invalid',
            key,
            `cannot check revision ${ifRevision}: ${label} does not support conditional writes`
          );
        }
        return failedWith(error, key, 'written');
      }
    },

    async remove(key, { signal }) {
      const refused = refusal<null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      try {
        await store.deleteObject(objectKeyOf(key), { signal });
      } catch (error: unknown) {
        if (!isMissingObject(error)) {
          return failedWith(error, key, 'removed');
        }
      }
      listeners.notify(key, null);
      return { ok: true, value: null };
    },

    subscribe: listeners.subscribe,
  };
}

/** The AWS SDK v3 pieces `awsSdkObjectStore` needs, passed in so this file imports none. */
export interface AwsSdkCommands {
  readonly GetObjectCommand: new (input: never) => unknown;
  readonly PutObjectCommand: new (input: never) => unknown;
  readonly DeleteObjectCommand: new (input: never) => unknown;
}

export interface AwsSdkObjectStoreOptions {
  /** An `S3Client`, or anything with a `send(command, { abortSignal })`. */
  readonly client: {
    send(
      command: never,
      options?: { abortSignal?: AbortSignal }
    ): Promise<unknown>;
  };
  readonly bucket: string;
  /** `GetObjectCommand`, `PutObjectCommand` and `DeleteObjectCommand` from `@aws-sdk/client-s3`. */
  readonly commands: AwsSdkCommands;
  /** Defaults to `text/plain; charset=utf-8`. */
  readonly contentType?: string;
}

/**
 * An `ObjectStoreLike` over the AWS SDK for JavaScript v3. Pass the client and the
 * three command classes (`import * as sdk from '@aws-sdk/client-s3'`), so this
 * package never imports the SDK itself. Works with any S3-compatible endpoint the
 * client is pointed at.
 */
export function awsSdkObjectStore(
  options: AwsSdkObjectStoreOptions
): ObjectStoreLike {
  const { client, bucket, commands } = options;
  const contentType: string =
    options.contentType ?? 'text/plain; charset=utf-8';
  const send = (command: unknown, signal: AbortSignal): Promise<unknown> =>
    client.send(command as never, { abortSignal: signal });
  return {
    async getObject(key, { signal }) {
      let response: unknown;
      try {
        response = await send(
          new commands.GetObjectCommand({ Bucket: bucket, Key: key } as never),
          signal
        );
      } catch (error: unknown) {
        if (isMissingObject(error)) {
          return null;
        }
        throw error;
      }
      const fields = response as {
        Body?: { transformToString?: (encoding?: string) => Promise<string> };
        ETag?: unknown;
      };
      if (
        typeof fields.Body?.transformToString !== 'function' ||
        typeof fields.ETag !== 'string'
      ) {
        throw new Error(
          'the response had no readable Body or ETag (is this a GetObject response?)'
        );
      }
      return {
        body: await fields.Body.transformToString('utf-8'),
        etag: fields.ETag,
      };
    },
    async putObject(key, body, { signal, ifMatch, ifNoneMatch }) {
      const response = (await send(
        new commands.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          // Said outright because the SDK cannot tell an empty string from a stream
          // of unknown length, and warns about it.
          ContentLength: utf8Length(body),
          ContentType: contentType,
          ...(ifMatch === undefined ? {} : { IfMatch: ifMatch }),
          ...(ifNoneMatch === undefined ? {} : { IfNoneMatch: ifNoneMatch }),
        } as never),
        signal
      )) as { ETag?: unknown };
      return { etag: typeof response.ETag === 'string' ? response.ETag : '' };
    },
    async deleteObject(key, { signal }) {
      await send(
        new commands.DeleteObjectCommand({ Bucket: bucket, Key: key } as never),
        signal
      );
    },
  };
}
