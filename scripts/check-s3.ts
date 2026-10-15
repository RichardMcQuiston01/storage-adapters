/**
 * Tries an S3-compatible bucket (Amazon S3, a DigitalOcean Space, MinIO, ...) and
 * reports, step by step, whether it handles the conditional writes `s3Adapter`
 * relies on for `ifRevision`, then runs the adapter itself against it. If the store
 * refuses a write whose `If-Match` is the object's own ETag, it also tries other
 * ETag formats to show what the store will accept. Everything is written under a
 * throwaway prefix and deleted afterwards.
 *
 *   TEST_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com \
 *   TEST_S3_BUCKET=my-space \
 *   TEST_S3_ACCESS_KEY_ID=... TEST_S3_SECRET_ACCESS_KEY=... \
 *   bun run check:s3
 *
 * TEST_S3_REGION is optional (default "us-east-1"; a Space's own region name such
 * as "nyc3" also works). Credentials are read from the environment only and are
 * never printed. (On Windows PowerShell set them with `$env:NAME = "value"`.)
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

const describeOutcome = (outcome: Outcome): string =>
  outcome.ok
    ? 'accepted'
    : `refused (${outcome.status ?? '?'} ${outcome.name})`;

/** What the check found out, to decide the verdict. */
let ignoredConditions = 0; // a write that had to be refused was accepted
let rejectedMatches = 0; // a write that had to be accepted was refused
let otherSurprises = 0;

function report(
  step: string,
  outcome: Outcome,
  expected: 'accepted' | 'refused',
  kind: 'plain' | 'condition' | 'match'
): void {
  const good: boolean =
    expected === 'accepted'
      ? outcome.ok
      : !outcome.ok && (outcome.status === 412 || outcome.status === 404);
  if (!good) {
    if (expected === 'refused') {
      ignoredConditions += 1;
    } else if (kind === 'match') {
      rejectedMatches += 1;
    } else {
      otherSurprises += 1;
    }
  }
  console.log(
    `${good ? 'PASS' : 'FAIL'}  ${step.padEnd(60)} expected ${expected.padEnd(9)} got ${describeOutcome(outcome)}`
  );
}

/** The ETag header as the store gives it for GET and HEAD, for comparison. */
async function etagForms(key: string): Promise<{ get: string; head: string }> {
  const got = await client.send(
    new sdk.GetObjectCommand({ Bucket: bucket, Key: `${prefix}${key}` })
  );
  await got.Body?.transformToString();
  const head = await client.send(
    new sdk.HeadObjectCommand({ Bucket: bucket, Key: `${prefix}${key}` })
  );
  return { get: got.ETag ?? '(none)', head: head.ETag ?? '(none)' };
}

/** Tries other ways of sending the ETag in If-Match, to see what the store accepts. */
async function diagnoseMatch(): Promise<string[]> {
  console.log(
    "\nThe store refused If-Match with the object's own ETag. Trying other formats:"
  );
  const created = await put('diag', 'diag-0');
  const forms = await etagForms('diag');
  const shape = (etag: string): string =>
    `${etag}  (${etag.length} characters, ${etag.startsWith('"') ? 'quoted' : 'not quoted'})`;
  console.log(`  ETag from the write response : ${shape(created.etag ?? '')}`);
  console.log(`  ETag from GetObject          : ${shape(forms.get)}`);
  console.log(`  ETag from HeadObject         : ${shape(forms.head)}`);
  const unquote = (etag: string): string => etag.replace(/^"(.*)"$/, '$1');
  const variants: [
    string,
    (etag: string, fromGet: string, fromHead: string) => string,
  ][] = [
    [
      'quoted, from the write response (what the adapter sends)',
      (etag) => etag,
    ],
    ['without quotes', (etag) => unquote(etag)],
    ['quoted, from GetObject', (_etag, fromGet) => fromGet],
    ['quoted, from HeadObject', (_etag, _fromGet, fromHead) => fromHead],
    ['weak form (W/"...")', (etag) => `W/${etag}`],
    ['"*" (any current object)', () => '*'],
  ];
  const accepted: string[] = [];
  let counter = 1;
  for (const [label, build] of variants) {
    // A fresh version of the object each time, so each try starts from a current ETag.
    const current = await put('diag', `diag-${counter}`);
    counter += 1;
    const forms2 = await etagForms('diag');
    const outcome = await put('diag', `diag-${counter}`, {
      IfMatch: build(current.etag ?? '', forms2.get, forms2.head),
    });
    counter += 1;
    console.log(`  If-Match ${label.padEnd(54)} ${describeOutcome(outcome)}`);
    if (outcome.ok) {
      accepted.push(label);
    }
  }
  return accepted;
}

async function main(): Promise<number> {
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
    return 1;
  }

  console.log('Conditional writes, step by step:');
  const first = await put('a', 'one');
  report('write a new object', first, 'accepted', 'plain');
  const wrongCreate = await put('a', 'two', { IfNoneMatch: '*' });
  report(
    'create only if absent (If-None-Match: *), but it exists',
    wrongCreate,
    'refused',
    'condition'
  );
  const wrongMatch = await put('a', 'two', { IfMatch: '"not-the-etag"' });
  report(
    'write if ETag matches (If-Match), with a wrong ETag',
    wrongMatch,
    'refused',
    'condition'
  );
  const rightMatch = await put('a', 'three', { IfMatch: first.etag ?? '' });
  report(
    'write if ETag matches (If-Match), with the right ETag',
    rightMatch,
    'accepted',
    'match'
  );
  const staleMatch = await put('a', 'four', { IfMatch: first.etag ?? '' });
  report('write with the now-stale ETag', staleMatch, 'refused', 'condition');
  const absentMatch = await put('absent', 'x', { IfMatch: '"abc"' });
  report(
    'If-Match on an object that does not exist',
    absentMatch,
    'refused',
    'condition'
  );
  const create = await put('fresh', 'x', { IfNoneMatch: '*' });
  report(
    'create only if absent, and it is absent',
    create,
    'accepted',
    'plain'
  );
  const createAgain = await put('fresh', 'y', { IfNoneMatch: '*' });
  report(
    'create only if absent, second time',
    createAgain,
    'refused',
    'condition'
  );

  const workingFormats: string[] =
    rejectedMatches > 0 ? await diagnoseMatch() : [];

  console.log('\nThe adapter itself:');
  const adapter = s3Adapter({
    store: awsSdkObjectStore({ client, bucket, commands: sdk }),
    prefix: `${prefix}adapter/`,
  });
  const written = await adapter.set('theme', 'dark', { signal });
  console.log(
    `set                           ${written.ok ? `ok, revision ${written.value.revision}` : `${written.code}: ${written.error}`}`
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

  console.log('');
  if (otherSurprises > 0) {
    console.log(
      "Result: a plain write or create was refused. Check the keys' permissions on this bucket (they need to write and delete objects)."
    );
    return 3;
  }
  if (ignoredConditions > 0) {
    console.log(
      'Result: this store does NOT enforce conditional writes the way S3 does. s3Adapter will refuse ifRevision writes on it (code "invalid"); plain set, get and remove still work.'
    );
    return 3;
  }
  if (rejectedMatches > 0) {
    console.log(
      'Result: this store refuses a conditional write even when the ETag is right, so every revision check would report a conflict. s3Adapter detects this and refuses ifRevision writes on it (code "invalid"); plain set, get and remove still work.'
    );
    console.log(
      workingFormats.length > 0
        ? `Formats it did accept: ${workingFormats.join('; ')}. Please send this whole output so the adapter can be taught to use one.`
        : 'None of the formats tried was accepted. Please send this whole output.'
    );
    return 3;
  }
  console.log(
    'Result: this store handles conditional writes correctly. ifRevision conflict checks are safe to use.'
  );
  return 0;
}

let exitCode: number;
try {
  exitCode = await main();
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
process.exit(exitCode);
