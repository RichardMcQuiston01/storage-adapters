import { createHash } from 'node:crypto';

import type { ObjectStoreLike, StoredObjectLike } from '../../src/s3/index.js';

/** An error shaped like the ones the AWS SDK for JavaScript v3 throws. */
export function s3Error(
  name: string,
  httpStatusCode: number,
  message = name
): Error {
  return Object.assign(new Error(message), {
    name,
    Code: name,
    $metadata: { httpStatusCode },
  });
}

/** How the fake treats `If-Match` and `If-None-Match`. */
export type ConditionMode =
  | 'enforced' // like Amazon S3
  | 'rejects-matching' // refuses If-Match even with the right ETag (as DigitalOcean Spaces did)
  | 'ignored' // writes go through whatever the condition says
  | 'not-implemented'; // 501 for any write that has a condition

export interface FakeObjectStore extends ObjectStoreLike {
  readonly objects: Map<string, string>;
  readonly calls: string[];
  mode: ConditionMode;
  /** Makes the next call of this kind reject with this error. */
  failNext: Partial<Record<'get' | 'put' | 'delete', Error>>;
}

export function etagOf(body: string): string {
  return `"${createHash('md5').update(body).digest('hex')}"`;
}

/** An in-memory object store that behaves like S3 for the calls the adapter makes. */
export function fakeObjectStore(
  mode: ConditionMode = 'enforced'
): FakeObjectStore {
  const objects = new Map<string, string>();
  const calls: string[] = [];
  const store: FakeObjectStore = {
    objects,
    calls,
    mode,
    failNext: {},
    getObject: (key) => {
      calls.push(`get ${key}`);
      const failure = store.failNext.get;
      if (failure !== undefined) {
        delete store.failNext.get;
        return Promise.reject(failure);
      }
      const body = objects.get(key);
      const found: StoredObjectLike | null =
        body === undefined ? null : { body, etag: etagOf(body) };
      return Promise.resolve(found);
    },
    putObject: (key, body, { ifMatch, ifNoneMatch }) => {
      const conditional = ifMatch !== undefined || ifNoneMatch !== undefined;
      calls.push(
        `put ${key}${ifMatch === undefined ? '' : ` if-match ${ifMatch}`}${ifNoneMatch === undefined ? '' : ' if-none-match *'}`
      );
      const failure = store.failNext.put;
      if (failure !== undefined) {
        delete store.failNext.put;
        return Promise.reject(failure);
      }
      if (conditional && store.mode === 'not-implemented') {
        return Promise.reject(s3Error('NotImplemented', 501));
      }
      if (
        conditional &&
        (store.mode === 'enforced' || store.mode === 'rejects-matching')
      ) {
        const current = objects.get(key);
        if (ifMatch !== undefined) {
          if (store.mode === 'rejects-matching') {
            return Promise.reject(s3Error('PreconditionFailed', 412));
          }
          if (current === undefined) {
            return Promise.reject(s3Error('NoSuchKey', 404));
          }
          if (etagOf(current) !== ifMatch) {
            return Promise.reject(s3Error('PreconditionFailed', 412));
          }
        }
        if (ifNoneMatch !== undefined && current !== undefined) {
          return Promise.reject(s3Error('PreconditionFailed', 412));
        }
      }
      objects.set(key, body);
      return Promise.resolve({ etag: etagOf(body) });
    },
    deleteObject: (key) => {
      calls.push(`delete ${key}`);
      const failure = store.failNext.delete;
      if (failure !== undefined) {
        delete store.failNext.delete;
        return Promise.reject(failure);
      }
      objects.delete(key);
      return Promise.resolve();
    },
  };
  return store;
}
