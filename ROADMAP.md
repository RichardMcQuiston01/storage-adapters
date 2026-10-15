# ROADMAP

## Shipped

- **0.1.0**: the `StorageAdapter` contract and wrappers, moved from
  `dashboard-widgets-toolkit`.
- **0.2.0**: `createPersistence<T>`: typed persistence with a versioned
  envelope, conflict policies, serialized saves and `watch`.
- **0.3.0**: the `/browser` entry point with `localStorageAdapter()`.
- **0.4.0**: the `/indexeddb` entry point with `indexedDbAdapter()` and the
  `/sqlite` entry point with `sqliteAdapter()`.
- **0.5.0**: `sessionStorageAdapter()` in `/browser`, the `/file` entry point
  with `fileAdapter()` (and `nodeFileSystem()` in `/file/node`), and the
  `/json-file` entry point with `jsonFileAdapter()`.
- **0.6.0**: the `/yaml-file` and `/ini-file` entry points with
  `yamlFileAdapter()` and `iniFileAdapter()`, and a fix for a stale cache in
  `jsonFileAdapter()` after a conflict.

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
- Each adapter is added to `test/conformance.test.ts`, which runs the shared
  contract suite (`test/support/conformance.ts`) against it.

## Next

1. **Chromium in CI.** Move the real-browser checks for localStorage,
   sessionStorage and IndexedDB into the repository and run them in CI.
2. **Cross-process locking for the file adapters.** An optional lock file so
   several processes can share one directory or document safely.

## Eventually

Cloud and server backends. They follow the adapters above and reuse the shared
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

- **Firebase adapter** (`/firebase`). Firestore first, with one document per
  key. A transaction makes the revision check atomic, and `onSnapshot` powers
  `subscribe`. The Realtime Database can follow if there is demand. The
  Firebase SDK is an optional peer dependency, and security rules stay the
  consumer's job.

## Later

- Try `s3Adapter` against more services (MinIO, Cloudflare R2, DigitalOcean
  Spaces) and note which enforce `If-Match`. It was tested against Amazon S3's
  documented behaviour through the `moto` emulator.

- Listen for writes made by other processes on the server SQL adapters:
  `LISTEN`/`NOTIFY` for `postgresAdapter`. MySQL has no equivalent, so
  `mysqlAdapter` would need polling or an external channel.

- Keep comments and layout when writing YAML, by editing the parsed document
  instead of rewriting it (the `yaml` package can do this). INI has no such option
  in the `ini` package.
- REST adapter for a remote key-value API.
- Optional `list(prefix, options)` on `StorageAdapter`, to list or clear keys.
  Useful once the file and database adapters exist.
- Switch `dashboard-widgets-toolkit` to depend on this package; it keeps
  re-exporting the wrappers so its public API and tests are unchanged.
- Optional React hook (`useStoredValue`).
