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
- **0.7.0**: the `/postgres` and `/mysql` entry points with `postgresAdapter()`
  and `mysqlAdapter()`.
- **0.8.0**: the `/s3` entry point with `s3Adapter()` (Amazon S3 and
  S3-compatible services, including DigitalOcean Spaces).
- **0.9.0**: the `/redis` entry point with `redisAdapter()`; `fileAdapter`
  reports other processes' changes; fixes for fourteen bugs found in review;
  CI actions pinned to commit SHAs.
- **0.10.0**: optional `list(prefix)` on every adapter and wrapper; the `/rest`
  entry point with `restAdapter()`; cross-process locking for the file
  adapters (`lock` option); Windows rename retries in `nodeFileSystem()`.
- **0.11.0**: the `/firebase` entry point with `firestoreAdapter()` (Admin SDK
  and web SDK wrappers, tested against the Firestore emulator in CI).
- **0.12.0**: the `/supabase` entry point with `supabaseAdapter()` and
  `supabaseSetupSql()` (tested against PostgreSQL and PostgREST through the
  real `supabase-js` in CI; Realtime covered with a fake channel).

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

## Later

- Try `s3Adapter` against Cloudflare R2 and note whether it enforces
  `If-Match` (needs an account). Tested so far: Amazon S3's documented
  behaviour (`moto`), MinIO (in CI) and DigitalOcean Spaces (by hand).

- Listen for writes made by other processes on `mysqlAdapter`. MySQL has no
  `LISTEN`/`NOTIFY`, so it would need polling or an external channel.
  (`postgresAdapter` does this through its `listener` option.)

- Keep comments and layout when writing YAML, by editing the parsed document
  instead of rewriting it (the `yaml` package can do this). INI has no such option
  in the `ini` package.
- Switch `dashboard-widgets-toolkit` to depend on this package; it keeps
  re-exporting the wrappers so its public API and tests are unchanged.
- Optional React hook (`useStoredValue`).
