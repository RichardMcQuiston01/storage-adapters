# ROADMAP

## Shipped

- **0.1.0**: the `StorageAdapter` contract and wrappers, moved from
  `dashboard-widgets-toolkit`.
- **0.2.0**: `createPersistence<T>`: typed persistence with a versioned
  envelope, conflict policies, serialized saves and `watch`.
- **0.3.0**: the `/browser` entry point with `localStorageAdapter()`.

## Ground rules for every new adapter

- The core (`src/index.ts`) stays free of I/O. Each backend is an optional
  subpath export (`/indexeddb`, `/sqlite`, ...) with its own tsup entry,
  `exports` and `typesVersions` entries, and ESLint override.
- Same contract as `localStorageAdapter()`: every operation returns a
  `StoreResult`, nothing throws, error messages name the key, and an aborted
  `signal` returns `unavailable` without touching the backend.
- Revisions are counters kept as strings. `set` with `ifRevision` returns
  `conflict` when the stored revision differs, and the check and write are
  atomic wherever the backend allows it.
- Drivers are optional peer dependencies, never bundled. Importing a subpath
  without its driver installed returns an `unavailable` result, not a crash.
- Tests use `node:test` and run offline against fakes or local files.
- Each adapter ships with a changeset (minor), README usage and a matching
  entry here.

## Next

1. **IndexedDB adapter** (`/indexeddb`). For values too large or too many for
   `localStorage`. One object store keyed by storage key, holding
   `{ value, revision }`. A single read-write transaction makes the revision
   check atomic. `subscribe` uses `BroadcastChannel` for cross-tab changes.
   Maps `QuotaExceededError` to `quota` and blocked or private-mode failures to
   `forbidden` or `unavailable`.
2. **SQLite adapter** (`/sqlite`). Works with `bun:sqlite` and `node:sqlite`
   behind a small `SqliteLike` interface, so other drivers can plug in.
   Compare-and-set is one `UPDATE ... WHERE revision = ?`. Table `storage_entry`
   with snake_case columns: `storage_entry_id` (UUID text), `entry_key`
   (unique), `entry_value`, `revision`, `created_at`, `updated_at`. The schema
   is created on first use. `subscribe` covers changes made through the same
   adapter only.
3. **sessionStorage adapter**. Add `sessionStorageAdapter()` to `/browser`,
   sharing the code and tests of `localStorageAdapter()`. Same envelope, so no
   new subpath is needed. `subscribe` is a no-op because `storage` events do
   not fire across tabs for session data.
4. **Flat file adapter** (`/file`). One file per key inside a directory, with
   keys encoded into safe file names. Writes go to a temp file and are renamed
   into place. A per-key lock makes the revision check safe within one process.
   Revision is stored beside the value. Takes a `FileSystemLike` interface, so
   Node, Bun and Deno can each supply their own.
5. **JSON file adapter** (`/json-file`). One JSON document holding every key:
   `{ "<key>": { "r": "...", "v": "..." } }`. Atomic write by temp file and
   rename. Loads once and caches, with an optional watch for outside edits.
   Best for small config and settings data; the docs will say where to prefer
   the flat file or SQLite adapters.
6. **MySQL and Postgres adapters** (`/mysql`, `/postgres`). Server-side
   adapters over a minimal `query(sql, params)` interface, so `mysql2`, `pg`,
   `postgres` and similar clients all fit. Same `storage_entry` table as
   SQLite, using native `UUID` on Postgres and `CHAR(36)` on MySQL, with
   `created_at` and `updated_at` timestamps. Compare-and-set is a single
   conditional `UPDATE`, or `INSERT ... ON CONFLICT` / `ON DUPLICATE KEY` for
   first writes. `subscribe` uses `LISTEN/NOTIFY` on Postgres and is a no-op on
   MySQL. Integration tests run against a real server only when a connection
   string is set in the environment, so the default test run stays offline.

## Eventually

Cloud and server backends. They follow the six above and reuse the shared
conformance suite.

- **Redis adapter** (`/redis`). One Redis hash per key holding `r` (revision)
  and `v` (value), over a minimal `RedisLike` interface so `ioredis`, `redis`
  and similar clients all fit. A short Lua script (or `WATCH`/`MULTI`) checks
  the revision and writes in one step, so `ifRevision` conflicts are atomic
  across processes. `subscribe` uses Pub/Sub on a channel per key prefix, so it
  does not depend on server keyspace-notification settings. An optional
  `ttlSeconds` option sets expiry for cache-style data, and an expired key
  reads as missing. Integration tests run only when a Redis URL is set in the
  environment.

- **S3 and DigitalOcean Spaces adapter** (`/s3`). One object per key, over a
  minimal `ObjectStoreLike` interface so the AWS SDK, a presigned-URL client or
  any S3-compatible service fits. The object's ETag is the revision, and
  `ifRevision` maps to an `If-Match` conditional write. Spaces may not honour
  conditional writes, so the adapter checks for support and returns `invalid`
  with a clear message instead of silently losing the conflict check.
  `subscribe` is a no-op.
- **Firebase adapter** (`/firebase`). Firestore first, with one document per
  key. A transaction makes the revision check atomic, and `onSnapshot` powers
  `subscribe`. The Realtime Database can follow if there is demand. The
  Firebase SDK is an optional peer dependency, and security rules stay the
  consumer's job.

## Later

- REST adapter for a remote key-value API.
- Optional `list(prefix, options)` on `StorageAdapter`, to list or clear keys.
  Useful once the file and database adapters exist.
- Shared conformance test suite that every adapter runs, to keep behaviour
  identical across backends.
- Switch `dashboard-widgets-toolkit` to depend on this package; it keeps
  re-exporting the wrappers so its public API and tests are unchanged.
- Optional React hook (`useStoredValue`).
