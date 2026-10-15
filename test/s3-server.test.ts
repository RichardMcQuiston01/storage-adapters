/**
 * The adapter contract against a real S3-compatible server, through the AWS SDK for
 * JavaScript v3 and `awsSdkObjectStore`. Skipped unless an endpoint is set:
 *
 *   TEST_S3_ENDPOINT=http://127.0.0.1:9000   (MinIO, moto, Spaces, ...)
 *   TEST_S3_BUCKET=adapters                  (created if missing; default "adapters")
 *   TEST_S3_ACCESS_KEY_ID / TEST_S3_SECRET_ACCESS_KEY   (default "test")
 *   TEST_S3_REGION                           (default "us-east-1")
 *
 * Every test works under its own prefix and deletes what it wrote.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import * as sdk from '@aws-sdk/client-s3';

import {
  awsSdkObjectStore,
  s3Adapter,
  type ObjectStoreLike,
} from '../src/s3/index.js';
import type { StorageAdapter } from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const endpoint: string | undefined = process.env.TEST_S3_ENDPOINT;

if (endpoint === undefined || endpoint === '') {
  void describe('s3Adapter on an S3-compatible server', () => {
    void it(
      'is skipped: set TEST_S3_ENDPOINT to run it',
      { skip: true },
      () => {
        // Nothing to run without a server.
      }
    );
  });
} else {
  const bucket: string = process.env.TEST_S3_BUCKET ?? 'adapters';
  const client = new sdk.S3Client({
    endpoint,
    region: process.env.TEST_S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  const store: ObjectStoreLike = awsSdkObjectStore({
    client,
    bucket,
    commands: sdk,
  });
  const signal: AbortSignal = new AbortController().signal;

  const freshPrefix = (): string => `test-${randomBytes(6).toString('hex')}/`;

  async function keysUnder(prefix: string): Promise<string[]> {
    const listed = await client.send(
      new sdk.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })
    );
    return (listed.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [object.Key]
    );
  }

  async function clear(prefix: string): Promise<void> {
    for (const key of await keysUnder(prefix)) {
      await client.send(
        new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key })
      );
    }
  }

  // Use the bucket if it is there; create it only if it is missing. Creating an
  // existing bucket can be refused (restricted keys), which must not stop the tests.
  await client
    .send(new sdk.HeadBucketCommand({ Bucket: bucket }))
    .catch(async (error: unknown) => {
      const status: number | undefined = (
        error as { $metadata?: { httpStatusCode?: number } }
      ).$metadata?.httpStatusCode;
      if (status !== 404) {
        throw error;
      }
      await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
    });

  runConformance('s3Adapter on an S3-compatible server', {
    ownWrites: 'notifies',
    create: () => {
      const prefix: string = freshPrefix();
      return {
        adapter: s3Adapter({ store, prefix }),
        reopen: () => s3Adapter({ store, prefix }),
        cleanup: () => clear(prefix),
      };
    },
  });

  void describe('s3Adapter on an S3-compatible server: beyond the contract', () => {
    void it('loses no update when two adapters count together', async () => {
      const prefix: string = freshPrefix();
      try {
        const first: StorageAdapter = s3Adapter({ store, prefix });
        const second: StorageAdapter = s3Adapter({ store, prefix });
        // Start from a stored value: with nothing stored there is no revision to
        // check, so each side's first write would be a plain overwrite.
        assert.ok((await first.set('counter', '0', { signal })).ok);
        const add = async (adapter: StorageAdapter): Promise<void> => {
          for (let done = 0; done < 15;) {
            const read = await adapter.get('counter', { signal });
            assert.ok(read.ok && read.value !== null, JSON.stringify(read));
            const written = await adapter.set(
              'counter',
              String(Number(read.value.value) + 1),
              { signal, ifRevision: read.value.revision ?? '' }
            );
            if (written.ok) {
              done += 1;
            } else {
              assert.equal(written.code, 'conflict', JSON.stringify(written));
            }
          }
        };
        await Promise.all([add(first), add(second)]);
        const total = await first.get('counter', { signal });
        assert.ok(total.ok);
        assert.equal(total.value?.value, '30');
      } finally {
        await clear(prefix);
      }
    });

    void it('accepts the first write with a revision on this server and leaves no probe object behind', async () => {
      const prefix: string = freshPrefix();
      try {
        const adapter = s3Adapter({ store, prefix });
        const written = await adapter.set('k', 'v', {
          signal,
          ifRevision: '"x"',
        });
        assert.ok(written.ok, JSON.stringify(written));
        assert.deepEqual(await keysUnder(prefix), [`${prefix}k`]);
      } finally {
        await clear(prefix);
      }
    });

    void it('stores the revision as the ETag the server reports', async () => {
      const prefix: string = freshPrefix();
      try {
        const adapter = s3Adapter({ store, prefix });
        const written = await adapter.set('k', 'v', { signal });
        assert.ok(written.ok);
        const head = await client.send(
          new sdk.HeadObjectCommand({ Bucket: bucket, Key: `${prefix}k` })
        );
        assert.equal(written.value.revision, head.ETag);
      } finally {
        await clear(prefix);
      }
    });

    void it('stores text with emoji and a megabyte of it unchanged', async () => {
      const prefix: string = freshPrefix();
      try {
        const adapter = s3Adapter({ store, prefix });
        const big: string = 'café \u{1F600} '.repeat(100_000);
        assert.ok((await adapter.set('big', big, { signal })).ok);
        const read = await adapter.get('big', { signal });
        assert.ok(read.ok);
        assert.equal(read.value?.value, big);
      } finally {
        await clear(prefix);
      }
    });

    void it('keeps keys with slashes and spaces apart', async () => {
      const prefix: string = freshPrefix();
      try {
        const adapter = s3Adapter({ store, prefix });
        const keys: readonly string[] = [
          'a/b',
          'a b',
          'a',
          'A',
          '\u{1F600}',
          'x/',
        ];
        for (const key of keys) {
          assert.ok(
            (await adapter.set(key, `value of ${key}`, { signal })).ok,
            key
          );
        }
        for (const key of keys) {
          const read = await adapter.get(key, { signal });
          assert.ok(read.ok);
          assert.equal(read.value?.value, `value of ${key}`);
        }
      } finally {
        await clear(prefix);
      }
    });
  });
}
