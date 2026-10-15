---
'@richardmcquiston01/storage-adapters': minor
---

Add an S3 adapter as the optional `@richardmcquiston01/storage-adapters/s3` entry point. `s3Adapter({ store, prefix?, name?, verifyConditionalWrites? })` keeps each key as one object in an S3-compatible bucket (Amazon S3, DigitalOcean Spaces, MinIO, Cloudflare R2), with the object's ETag as its revision. `set` with `ifRevision` is a conditional write (`If-Match`; a key with nothing stored is created with `If-None-Match: *`), so two writers holding the same revision cannot both win. Because some S3-compatible services ignore conditional headers, the adapter checks once, before the first write that uses `ifRevision`, that the store enforces them, and refuses such a write with `invalid` and a clear message instead of silently losing the check. No SDK is bundled: `awsSdkObjectStore({ client, bucket, commands })` wraps an AWS SDK v3 client, or pass your own `ObjectStoreLike`. `subscribe` reports changes made through the same adapter.
