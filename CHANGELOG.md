# CHANGELOG

## 0.8.0

### Minor Changes

- ff417b1: Add an S3 adapter as the optional `@richardmcquiston01/storage-adapters/s3` entry point. `s3Adapter({ store, prefix?, name?, verifyConditionalWrites? })` keeps each key as one object in an S3-compatible bucket (Amazon S3, DigitalOcean Spaces, MinIO, Cloudflare R2), with the object's ETag as its revision. `set` with `ifRevision` is a conditional write (`If-Match`; a key with nothing stored is created with `If-None-Match: *`), so two writers holding the same revision cannot both win. Because some S3-compatible services ignore conditional headers, or want the ETag in a different form (DigitalOcean Spaces wants it without quotes and answers 412 for a missing object), the adapter checks once, before the first write that uses `ifRevision`, that the store refuses a second create and a wrong ETag and accepts an object's own ETag (quoted, or else bare, which it then uses), and refuses such a write with `invalid` and a clear message instead of silently skipping the check or failing every one. No SDK is bundled: `awsSdkObjectStore({ client, bucket, commands })` wraps an AWS SDK v3 client, or pass your own `ObjectStoreLike`. `subscribe` reports changes made through the same adapter.

## 0.7.0

### Minor Changes

- b7c4270: Add PostgreSQL and MySQL adapters as optional entry points. `postgresAdapter()` from `/postgres` takes any client with `query(sql, parameters)` that resolves `{ rows }` (`pg`, PGlite), and `mysqlAdapter()` from `/mysql` takes a `mysql2/promise` pool or connection. Both keep a `storage_entry` table (a `table` option names another) with a UUID id, the value, a counter revision and `created_at`/`updated_at`, create it on first use, and make the `ifRevision` check atomic, so two connections racing with the same revision cannot both win. Neither bundles a driver. `subscribe` reports changes made through the same adapter.

### Patch Changes

- 765c85a: `memoryAdapter()` now honours an aborted signal like every other adapter: `get`, `set` and `remove` return an `unavailable` result that names the key, and leave the stored data untouched. Before, they ignored the signal.
- 31e58fd: `memoryAdapter()` now creates a key that has nothing stored when `set` is given `ifRevision`, like every other adapter. Before, it returned `conflict`. The `StorageAdapter.set` documentation now states the rule: `conflict` only when a value is stored and its revision differs.

## 0.6.0

### Minor Changes

- 330d782: Add the optional `@richardmcquiston01/storage-adapters/yaml-file` and `@richardmcquiston01/storage-adapters/ini-file` entry points with `yamlFileAdapter({ path, fileSystem, yaml })` and `iniFileAdapter({ path, fileSystem, ini })`: `StorageAdapter`s that keep every key in one hand-editable file, `key: value` in YAML and `key=value` in INI. No parser is bundled; pass in the `yaml` or `ini` package (anything with `parse` and `stringify`). There is no revision in the file: the revision is a fingerprint of the value, so a hand edit is noticed as a new revision and a layout or comment change is not. A value is text (a string, `true`/`false`, or a whole number); anything else is `corrupt` for that key and is kept as it is when other keys are written. A key or value the format would not read back as the same text, such as the INI value `null` or key `a=b`, is refused with `invalid` before anything is written. Like `jsonFileAdapter`: cached reads, queued writes that replace the file atomically, a broken file is never overwritten, outside edits noticed when the file system can watch, `cache` and `watch` options. Comments and layout are not kept when the adapter writes. Safe within one process only. The main entry stays free of I/O.

### Patch Changes

- 330d782: Fix `jsonFileAdapter` serving a stale value after a conflict. When `set` found that the file had changed outside (a revision conflict, or a refused write), it left its cached copy as it was, so a caller that re-read with `get` and retried got the old value and the old revision, and conflicted again until something else refreshed the cache. Now every fresh read of the file updates what `get` returns, and subscribers are told about any outside change found while writing instead of missing it.

## 0.5.0

### Minor Changes

- 01bc4a4: Add `sessionStorageAdapter()` to the `@richardmcquiston01/storage-adapters/browser` entry point: a `StorageAdapter` over `sessionStorage` for data that lasts as long as the tab. It shares its code, revisioned envelope, options (`storage`, `events`) and error mapping with `localStorageAdapter()`, and names `sessionStorage` in its errors. Each tab has its own `sessionStorage`, so `subscribe` hears about writes from other documents in the same tab, such as same-origin iframes.
  
  Also fix `subscribe` in both browser adapters: a `storage` event now carries which storage changed, and a change to the other kind of storage under the same key no longer reaches the subscriber. Before, a `sessionStorage` write in an iframe could wrongly notify a `localStorageAdapter()` subscriber for the same key. `StorageChangeEvent` gains an optional `storageArea` field, and an event without one is still accepted.
- 8fa67a1: Add the optional `@richardmcquiston01/storage-adapters/json-file` entry point with `jsonFileAdapter({ path, fileSystem })`: a `StorageAdapter` that keeps every key in one readable JSON file, `{ "<key>": { "r": "1", "v": "..." } }`, sorted by key. The file is read once and cached; each write re-reads it, changes one entry and replaces the whole file through a temporary file and a rename, and writes are queued so `set` with `ifRevision` returns `conflict` when another write in the same process got there first. Any string is a valid key. A file that is not a JSON object is never overwritten: every call returns `corrupt` until it is fixed. An invalid entry is `corrupt` for its own key only. With a `FileSystemLike` that can watch, an outside edit, in place or by an editor that replaces the file, is noticed and reported to subscribers of the keys that changed (`watch: false` turns that off; `cache: false` reads the file on every `get`). Maps a full disk to `quota`, permission errors to `forbidden` and anything else to `unavailable`, and never throws. Safe within one process only, like the file adapter. The main entry stays free of I/O.
  
  `FileSystemLike` (from `/file`) gains an optional `watch(path, onChange)` method, and `nodeFileSystem()` (from `/file/node`) implements it with `fs.watch` on the file's folder, so a file replaced by a rename is still noticed. The watcher does not keep the program running.
- 9c9337e: Add the optional `@richardmcquiston01/storage-adapters/file` entry point with `fileAdapter({ directory, fileSystem })`: a `StorageAdapter` that keeps one file per key in a directory. It imports no file system module; pass in a `FileSystemLike`, or use `nodeFileSystem()` from the new `@richardmcquiston01/storage-adapters/file/node` entry point (built on `node:fs/promises`, for Node, Bun and Deno). Keys are encoded into file names that are safe on every common file system, including case-insensitive ones, and cannot leave the directory. Writes go to a temporary file that is renamed into place, and writes to one key are queued, so `set` with `ifRevision` returns `conflict` when another write in the same process got there first. Maps a full disk to `quota`, permission errors to `forbidden`, a bad file to `corrupt`, an unusable key to `invalid` and anything else to `unavailable`, and never throws. Safe within one process only: separate processes writing one directory can lose updates, so use the SQLite adapter for that. The main entry stays free of I/O.

## 0.4.0

### Minor Changes

- 9bf72da: Add the optional `@richardmcquiston01/storage-adapters/indexeddb` entry point with `indexedDbAdapter()`: a `StorageAdapter` over IndexedDB for values too large or too many for `localStorage`. Values carry counter revisions, and the revision check and the write run in one transaction, so `set` with `ifRevision` returns `conflict` when another tab wrote first. `subscribe` reports changes made by other tabs through a `BroadcastChannel`. Maps `QuotaExceededError` to `quota`, `SecurityError` to `forbidden` and anything else to `unavailable`, and never throws. Accepts `factory`, `databaseName`, `storeName` and `channel` options. The main entry stays free of I/O.
- 298ac4b: Add the optional `@richardmcquiston01/storage-adapters/sqlite` entry point with `sqliteAdapter({ database })`: a `StorageAdapter` over SQLite for servers, scripts and desktop apps. It imports no driver; pass in a `node:sqlite` or `bun:sqlite` database, or any driver with `exec` and `prepare`. Each key is a row in a `storage_entry` table (UUID id, counter revision, `created_at` and `updated_at`) created on first use. The revision check and the write are one statement, so `set` with `ifRevision` returns `conflict` when another connection wrote first. Maps a full disk to `quota`, a read-only database to `forbidden`, a damaged file to `corrupt` and anything else to `unavailable`, and never throws. `subscribe` reports changes made through the same adapter. The main entry stays free of I/O.

## 0.3.0

### Minor Changes

- e7c2156: Add the optional `@richardmcquiston01/storage-adapters/browser` entry point with `localStorageAdapter()`: a `StorageAdapter` over `localStorage` with counter revisions (`set` with `ifRevision` returns `conflict` when another tab wrote first), `subscribe` for changes made in other tabs, `quota` / `forbidden` / `unavailable` error mapping, and no throws. Accepts `storage` and `events` options for non-global storage. The main entry stays free of I/O. Extracted from `chat-and-react`.

## 0.2.0

### Minor Changes

- c64f011: Add `createPersistence<T>(adapter, { parse, ... })`: typed persistence over any `StorageAdapter` with a versioned envelope, tolerant reads (`parse` repairs, and also reads a bare value), a size limit, revision tracking, a conflict policy (`'ask'`, `'overwrite'`, `'keep-theirs'` or a merge function), saves serialized per key (rapid saves collapse into the newest), `remove` and `watch`. Generalised from the toolkit's layout persistence.

## 0.1.0

### Minor Changes

- f3ac32a: First feature release: the `StorageAdapter` contract (`StoredValue`, `StoreResult`, `StoreErrorCode`) and the composable wrappers `memoryAdapter`, `withPrefix`, `withFallback`, `withReadCache`, `readOnly`, `withRetry`, `withEncoding` and `withLogging`, plus `utf8Length`. Moved from `dashboard-widgets-toolkit` unchanged.
