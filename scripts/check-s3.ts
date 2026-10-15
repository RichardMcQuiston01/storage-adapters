/**
 * Tries an S3-compatible bucket (Amazon S3, a DigitalOcean Space, MinIO, ...) and
 * reports, step by step, whether it enforces the conditional writes `s3Adapter`
 * relies on for `ifRevision`, then runs the adapter itself against it. Everything
 * is written under a throwaway prefix and deleted afterwards.
 *
 *   TEST_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com \
 *   TEST_S3_BUCKET=my-space \
 *   TEST_S3_ACCESS_KEY_ID=... TEST_S3_SECRET_ACCESS_KEY=... \
 *   bun run check:s3
 *
 * TEST_S3_REGION is optional (default "us-east-1"; a Space's own region name such
 * as "nyc3" also works). Credentials are read from the environment only and are
 * never printed.
 */
import { randomBytes } from 'node:crypto';

import * as sdk from '@aws-sdk/client-s3';

import { awsSdkObjectStore, s3Adapter } from '../src/s3/index.js';

const endpoint: string | undefined = process.env.TEST_S3_ENDPOINT;
const bucket: string | undefined = process.env.TEST_S3_BUCKET;
const accessKeyId: string | undefined = process.env.TEST_S3_ACCESS_KEY_ID;
const secretAccessKey: string | undefined =
  process.env.TEST_S3_SECRET_ACCESS_KEY;

if (
  endpoint === undefined ||
  bucket === undefined ||
  accessKeyId === undefined ||
  secretAccessKey === undefined
) {
  console.error(
    'Set TEST_S3_ENDPOINT, TEST_S3_BUCKET, TEST_S3_ACCESS_KEY_ID and TEST_S3_SECRET_ACCESS_KEY.\n' +
      'See the comment at the top of scripts/check-s3.ts.'
  );
  process.exit(2);
}

const client = new sdk.S3Client({
  endpoint,
  region: process.env.TEST_S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
const prefix = `storage-adapters-check-${randomBytes(4).toString('hex')}/`;
const signal: AbortSignal = new AbortController().signal;

/** What happened: `ok` with the ETag, or the HTTP status and error name. */
interface Outcome {
  readonly ok: boolean;
  readonly status: number | undefined;
  readonly name: string;
  readonly etag: string | undefined;
}

async function attempt(
  run: () => Promise<{ ETag?: string }>
): Promise<Outcome> {
  try {
    const response = await run();
    return { ok: true, status: 200, name: 'OK', etag: response.ETag };
  } catch (error: unknown) {
    const fields = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    return {
      ok: false,
      status: fields.$metadata?.httpStatusCode,
      name: fields.name ?? 'Error',
      etag: undefined,
    };
  }
}

const put = (
  key: string,
  body: string,
  conditions: { IfMatch?: string; IfNoneMatch?: string } = {}
): Promise<Outcome> =>
  attempt(() =>
    client.send(
      new sdk.PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}${key}`,
        Body: body,
        ContentLength: Buffer.byteLength(body),
        ...conditions,
      })
    )
  );

let enforced = true;
let surprises = 0;

function report(step: string, outcome: Outcome, expected: string): void {
  const observed: string = outcome.ok
    ? 'accepted'
    : `refused (${outcome.status ?? '?'} ${outcome.name})`;
  const good: boolean =
    expected === 'accepted'
      ? outcome.ok
      : !outcome.ok && (outcome.status === 412 || outcome.status === 404);
  if (!good) {
    surprises += 1;
  }
  console.log(
    `${good ? 'PASS' : 'FAIL'}  ${step.padEnd(60)} expected ${expected.padEnd(9)} got ${observed}`
  );
}

async function main(): Promise<void> {
  console.log(`Endpoint ${endpoint}`);
  console.log(`Bucket   ${bucket}`);
  console.log(`Prefix   ${prefix} (removed at the end)\n`);

  const head = await attempt(() =>
    client.send(new sdk.HeadBucketCommand({ Bucket: bucket }))
  );
  if (!head.ok) {
    console.error(
      `Cannot reach the bucket: ${head.status ?? '?'} ${head.name}. Check the endpoint, bucket name, region and keys.`
    );
    process.exit(1);
  }

  console.log('Conditional writes, step by step:');
  const first = await put('a', 'one');
  report('write a new object', first, 'accepted');
  const wrongCreate = await put('a', 'two', { IfNoneMatch: '*' });
  report(
    'create only if absent (If-None-Match: *), but it exists',
    wrongCreate,
    'refused'
  );
  const wrongMatch = await put('a', 'two', { IfMatch: '"not-the-etag"' });
  report(
    'write if ETag matches (If-Match), with a wrong ETag',
    wrongMatch,
    'refused'
  );
  const rightMatch = await put('a', 'three', { IfMatch: first.etag ?? '' });
  report(
    'write if ETag matches (If-Match), with the right ETag',
    rightMatch,
    'accepted'
  );
  const staleMatch = await put('a', 'four', { IfMatch: first.etag ?? '' });
  report('write with the now-stale ETag', staleMatch, 'refused');
  const absentMatch = await put('absent', 'x', { IfMatch: '"abc"' });
  report('If-Match on an object that does not exist', absentMatch, 'refused');
  const create = await put('fresh', 'x', { IfNoneMatch: '*' });
  report('create only if absent, and it is absent', create, 'accepted');
  const createAgain = await put('fresh', 'y', { IfNoneMatch: '*' });
  report('create only if absent, second time', createAgain, 'refused');
  enforced = surprises === 0;

  console.log('\nThe adapter itself:');
  const adapter = s3Adapter({
    store: awsSdkObjectStore({ client, bucket, commands: sdk }),
    prefix: `${prefix}adapter/`,
  });
  const written = await adapter.set('theme', 'dark', { signal });
  console.log(
    `set                          ${written.ok ? `ok, revision ${written.value.revision}` : `${written.code}: ${written.error}`}`
  );
  const revision: string = written.ok ? (written.value.revision ?? '') : '';
  const checked = await adapter.set('theme', 'light', {
    signal,
    ifRevision: revision,
  });
  console.log(
    `set with the current revision ${checked.ok ? 'ok' : `${checked.code}: ${checked.error}`}`
  );
  const stale = await adapter.set('theme', 'blue', {
    signal,
    ifRevision: revision,
  });
  console.log(
    `set with a stale revision     ${stale.ok ? 'ok (the check was NOT enforced)' : `${stale.code}: ${stale.error}`}`
  );

  console.log(
    enforced
      ? '\nResult: this store ENFORCES conditional writes. ifRevision conflict checks are safe to use.'
      : '\nResult: this store does NOT enforce conditional writes the way S3 does. s3Adapter will refuse ifRevision writes on it (code "invalid"); plain set, get and remove still work.'
  );
}

try {
  await main();
} finally {
  // Remove everything under the throwaway prefix, whatever happened.
  try {
    const listed = await client.send(
      new sdk.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })
    );
    for (const object of listed.Contents ?? []) {
      if (object.Key !== undefined) {
        await client.send(
          new sdk.DeleteObjectCommand({ Bucket: bucket, Key: object.Key })
        );
      }
    }
    console.log('Cleaned up.');
  } catch (error: unknown) {
    console.error(`Could not clean up ${prefix}: ${String(error)}`);
  }
}
process.exit(enforced ? 0 : 3);
