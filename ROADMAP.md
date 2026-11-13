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
- **0.13.0**: the `/firebase/realtime` entry point with
  `realtimeDatabaseAdapter()` for the Firebase Realtime Database.
- **0.14.0**: `postgresAdapter` hears other processes' writes through
  `LISTEN`/`NOTIFY` (the `listener` option).
- **0.15.0**: `yamlFileAdapter` keeps comments, key order and blank lines; the
  `/react` entry point with the `useStoredValue` hook.
- **0.16.0**: `mysqlAdapter` polling (`pollIntervalMs`); the public surface
  trimmed for 1.0 (`utf8Length` and a few helpers are no longer exported);
  `funding` link in `package.json`.
- **0.17.0**: the `/nats` entry point with `natsKvAdapter()` and the `/couchdb`
  entry point with `couchDbAdapter()`.
- **0.18.0**: the `/memcached` entry point with `memcachedAdapter()`.
- **0.19.0**: the `/arangodb` and `/cassandra` entry points with
  `arangoDbAdapter()` and `cassandraAdapter()`.
- **0.20.0**: the `/neo4j`, `/influxdb` and `/rethinkdb` entry points with
  `neo4jAdapter()`, `influxDbAdapter()` and `rethinkDbAdapter()`.
- **0.21.0**: the `/clickhouse` entry point with `clickHouseAdapter()`
  (best-effort `ifRevision`).
- **0.22.0**: the `/rabbitmq` entry point with `rabbitMqAdapter()`, an
  append-only log in a RabbitMQ stream.
- **0.23.0**: `compact()` and `snapshotIntervalMs` for the RabbitMQ stream.
- **0.23.1**: the donate link moved to Ko-fi; a fix for a rare RethinkDB
  `subscribe` race; browser CI pinned to `ubuntu-24.04`.
- **0.24.0**: the `/google-sheets` entry point with `googleSheetsAdapter()` (best-effort
  `ifRevision`; the suite passes against a real Google spreadsheet).
- **0.24.1**: a clearer Google Sheets error when the Sheets API is not enabled for the
  credentials' project; the README records that `s3Adapter` passes against Cloudflare R2
  and the Google Sheets adapter passes against a real spreadsheet.
- **0.25.0**: the `/google-drive` entry point with `googleDriveAdapter()` (best-effort
  `ifRevision`; tested against a stand-in for the Drive API).
- **0.26.0**: the `/gcs` entry point with `gcsAdapter()` and `gcsObjectStore()` (atomic
  `ifRevision` through the object generation; tested against stand-ins and, in CI, the
  `fake-gcs-server` emulator).
- `dashboard-widgets-toolkit` 0.36.0 depends on this package and re-exports the
  wrappers, so its public API is unchanged.

## Ground rules for every new adapter

- The core (`src/index.ts`) stays free of I/O. Each backend is an optional
  subpath export (`/indexeddb`, `/sqlite`, ...) with its own tsup entry,
  `exports` and `typesVersions` entries, and ESLint override.
- Same contract as `localStorageAdapter()`: every operation returns a
  `StoreResult`, nothing throws, error messages name the key, and an aborted
  `signal` returns `unavailable` without touching the backend.
- Revisions are strings. Most adapters keep a counter; where the backend has its
  own version token (an ETag, `_rev`, a stream offset) the adapter uses that.
  `set` with `ifRevision` returns `conflict` when the stored revision differs
  (a key with nothing stored is created), and the check and write are atomic
  wherever the backend allows it. Where it does not (ClickHouse, InfluxDB), the
  adapter says so in its README.
- Drivers are optional peer dependencies, never bundled. Importing a subpath
  without its driver installed returns an `unavailable` result, not a crash.
- Tests use `node:test` and run offline against fakes or local files. An
  adapter for a server also gets a real-server test (skipped unless its
  `TEST_*_URL` is set) and a CI job that runs it.
- Each adapter ships with a changeset (minor), README usage and a matching
  entry here.
- Each adapter is added to `test/conformance.test.ts`, which runs the shared
  contract suite (`test/support/conformance.ts`) against it.

## Later

- The Google Cloud Storage adapter (`/gcs`) has been
  tested against in-memory stand-ins and, in CI, the `fake-gcs-server` emulator through the real
  client: run `test/gcs-live.test.ts` against a real bucket (needs credentials) before relying on
  it, in particular for the one-write-a-second-per-object limit, which no emulator reproduces.

- The Google Drive adapter (`/google-drive`) has been tested against a stand-in for
  the Drive API only: run `test/google-drive-live.test.ts` against
  a real Drive folder (it needs credentials with a Drive scope; see the file) before relying on it.
  I could not check Google's documentation for a conditional-update precondition, so `ifRevision`
  is best-effort, and `sharedDrive: true` is untested.

## Potential

Ideas, in no order. Nothing here is built or promised.

- Azure Blob Storage (`/azure-blob`), the object-store sibling of `/s3` and `/gcs`. It has
  conditional writes (`If-Match`), so `ifRevision` could be atomic. It would take an injected
  client and need a real account (or the Azurite emulator) for a CI job.

- Amazon DynamoDB (`/dynamodb`), through an injected document client. Conditional
  expressions give an atomic `ifRevision`. DynamoDB Local would serve the CI job.

## Not planned

- **Slack and Google Chat webhooks.** Issue #130 asked about them as places to
  send error data. They are write-only notification sinks: there is nothing to
  read back, so they cannot be a `StorageAdapter`. Posting to one is a job for
  `error-log-adapter`'s webhook adapter, or for `restAdapter` plus a wrapper in
  consumer code.
- **OrientDB.** `error-log-adapter` decided not to plan it, and the same applies
  here.
