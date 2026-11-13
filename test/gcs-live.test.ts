/**
 * The Google Cloud Storage adapter against a real bucket (or an emulator), through
 * `@google-cloud/storage`. Skipped unless a bucket is named:
 *
 *   TEST_GCS_BUCKET=<name of a bucket that already exists>
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json     (a real bucket)
 *   TEST_GCS_EMULATOR_HOST=http://127.0.0.1:4443                  (an emulator, in place of credentials)
 *   TEST_GCS_PROJECT_ID=<project>                                (only if the client cannot find it)
 *
 * The emulator address has its own variable because the client treats STORAGE_EMULATOR_HOST
 * as the whole API base URL (it does not add /storage/v1), which an emulator's host alone
 * does not satisfy; the test passes it to the client as `apiEndpoint` instead. Leave
 * STORAGE_EMULATOR_HOST unset when using it.
 *
 * The account needs permission to create, read, delete and list objects in the bucket (the
 * Storage Object Admin role). Every test works under a prefix of its own and deletes what it
 * wrote. Google Cloud Storage allows about one write a second to a single object name, so the
 * tests that write one key many times can be slowed by rate limiting on a real bucket: run
 * with a long timeout.
 *
 *   bun test --timeout 600000 test/gcs-live.test.ts
 *
 * Nothing here has been run against a real bucket or an emulator by the author of the adapter
 * yet; the default test run uses the stand-ins in test/support/fake-gcs.ts.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { Storage } from '@google-cloud/storage';

import {
  gcsAdapter,
  gcsObjectStore,
  type GcsBucketLike,
} from '../src/gcs/index.js';
import type { StorageAdapter, StoreResult } from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

const bucketName: string | undefined = process.env.TEST_GCS_BUCKET;
if (bucketName === undefined || bucketName === '') {
  void describe('gcsAdapter on a Google Cloud Storage bucket', () => {
    void it('is skipped: set TEST_GCS_BUCKET to run it', { skip: true }, () => {
      // Nothing to run without a bucket.
    });
  });
} else {
  const projectId: string | undefined = process.env.TEST_GCS_PROJECT_ID;
  const emulatorHost: string | undefined = process.env.TEST_GCS_EMULATOR_HOST;
  const storage = new Storage({
    ...(projectId === undefined ? {} : { projectId }),
    ...(emulatorHost === undefined || emulatorHost === ''
      ? {}
      : { apiEndpoint: emulatorHost }),
  });
  const realBucket = storage.bucket(bucketName);
  // The real bucket is passed as it is: this also checks that it fits `GcsBucketLike`.
  const bucket: GcsBucketLike = realBucket;

  const freshPrefix = (): string =>
    `adapter-test-${randomBytes(6).toString('hex')}/`;

  const dropPrefix = async (prefix: string): Promise<void> => {
    await realBucket.deleteFiles({ prefix, force: true });
  };

  const adapterFor = (prefix: string): StorageAdapter =>
    gcsAdapter({ store: gcsObjectStore({ bucket }), prefix });

  runConformance('gcsAdapter on a Google Cloud Storage bucket', {
    ownWrites: 'notifies',
    create: () => {
      const prefix: string = freshPrefix();
      return {
        adapter: adapterFor(prefix),
        reopen: () => adapterFor(prefix),
        cleanup: () => dropPrefix(prefix),
      };
    },
  });

  void describe('gcsAdapter on a Google Cloud Storage bucket: beyond the contract', () => {
    void it('uses the real generation as the revision, and stores plain text', async () => {
      const prefix: string = freshPrefix();
      try {
        const adapter = adapterFor(prefix);
        const written = expectOk(
          await adapter.set('hello', 'line one\nline two', { signal })
        );
        const [metadata] = await realBucket
          .file(`${prefix}hello`)
          .getMetadata();
        assert.equal(written.revision, String(metadata.generation));
        assert.equal(
          String(metadata.contentType).startsWith('text/plain'),
          true
        );
        const [content] = await realBucket.file(`${prefix}hello`).download();
        assert.equal(content.toString('utf8'), 'line one\nline two');
      } finally {
        await dropPrefix(prefix);
      }
    });

    void it('lets only one of several writers holding the same revision win', async () => {
      const prefix: string = freshPrefix();
      try {
        const first = expectOk(
          await adapterFor(prefix).set('k', 'start', { signal })
        );
        const results = await Promise.all(
          Array.from({ length: 5 }, (_unused, index) =>
            adapterFor(prefix).set('k', `writer ${String(index)}`, {
              signal,
              ifRevision: first.revision as string,
            })
          )
        );
        assert.equal(
          results.filter((result) => result.ok).length,
          1,
          JSON.stringify(results)
        );
      } finally {
        await dropPrefix(prefix);
      }
    });

    void it('lets only one of several writers create the same key', async () => {
      const prefix: string = freshPrefix();
      try {
        const results = await Promise.all(
          Array.from({ length: 5 }, (_unused, index) =>
            adapterFor(prefix).set('new', `writer ${String(index)}`, {
              signal,
              ifRevision: '1',
            })
          )
        );
        assert.equal(
          results.filter((result) => result.ok).length,
          1,
          JSON.stringify(results)
        );
      } finally {
        await dropPrefix(prefix);
      }
    });

    void it('explains a bucket that does not exist', async () => {
      const missing: GcsBucketLike = storage.bucket(
        `no-such-bucket-${randomBytes(8).toString('hex')}`
      );
      const result = await gcsAdapter({
        store: gcsObjectStore({ bucket: missing }),
      }).set('k', 'v', { signal });
      assert.ok(!result.ok);
      assert.match(result.error, /bucket|not found|does not exist/i);
    });
  });
}
