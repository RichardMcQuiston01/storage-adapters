# CHANGELOG

## 0.16.0

### Minor Changes

- 5f601da: `mysqlAdapter` can now report writes made by other processes. MySQL has no `LISTEN`/`NOTIFY`, so give it `pollIntervalMs` (at least 50) and, if you like, `onPollError`: while any key is subscribed, one query every interval reads all the subscribed keys (100 at a time) and each key whose value or revision changed is reported once. With nothing subscribed there is no query and no timer, and the timer does not keep a program running. What is stored when you subscribe is not a change; your own writes are reported at once and not again; a key removed and recreated with the same revision between polls is still noticed because the value is compared too; a failing poll is reported once per run of failures and polling carries on. Without `pollIntervalMs` nothing changes.
- 5d6dc6b: Prepare the public surface for 1.0. **Breaking:** `utf8Length` (from the main entry point), `firestoreDocumentId` and `firestorePrefixUpperBound` (from `/firebase`), and `realtimeNodeKey` and `keyFromRealtimeNodeKey` (from `/firebase/realtime`) are no longer exported. They were implementation details of key encoding and size checks. The adapters behave as before. `/firebase`, `/firebase/realtime`, `/supabase`, `/react` and Postgres's `listener` option are tagged `@experimental` in the type definitions: they may change in a minor release until they have run against the real service. `compareKeys`, `keysWithPrefix` and `DEFAULT_MAX_BYTES` stay public and are now documented in the README, which also has a new Stability section.

## 0.15.0

### Minor Changes

- 4ba153a: `yamlFileAdapter` now keeps the comments, key order and blank lines of the file when it writes. When the YAML library has `parseDocument` (the `yaml` package does), a write changes only the entry it is about: a new key is added at the end, a removed key takes its own comments with it, and a number or boolean stays one when the new text still reads as one. The result is read back and checked, and if keeping the layout would change another entry (an anchor and its alias, for example) the file is written fresh, without comments, as before. New option `keepComments` (default `true`; `false` writes the file fresh, sorted by key, as before) and exported type `YamlDocumentLike`; `parseDocument` is an optional member of `YamlLike`. A YAML file that holds only comments is now an empty document instead of `corrupt`. `iniFileAdapter` is unchanged and still drops comments. Existing files written by this adapter keep working; the visible difference is that YAML files are no longer re-sorted on every write.
- 4394998: New optional `/react` entry point with the `useStoredValue(adapter, key)` hook. It returns `{ status, value, revision, error, set, remove, refresh }`: it reads the key, follows changes other tabs or processes make when the adapter can `subscribe` (a change heard during the first read wins over that read), and its `set`, `remove` and `refresh` resolve with the adapter's `StoreResult`. Unmounting stops the listener and cancels the read; stale answers for an old key are ignored; an adapter that rejects is reported as an `unavailable` error instead of throwing into the component. React 18 or later is an optional peer dependency of this entry point only; the rest of the package is unchanged.

## 0.14.0

### Minor Changes

- 78b6a00: `postgresAdapter` can now hear writes made by other processes. Pass a dedicated `pg` `Client` as `listener` (and optionally `onListenError`): the first `subscribe` creates a `<table>_notify` function and trigger that send a `NOTIFY` after every insert, update and delete, and runs `LISTEN` on that connection. `subscribe` then reports other processes' changes, plain SQL included, once each; what is stored when you subscribe is not reported, and a key too long for a notification still works. The last unsubscribe runs `UNLISTEN`. New exported types `PostgresListenClientLike` and `PostgresNotificationLike`. Without `listener`, nothing changes. `subscribe` on a watched key no longer repeats a notification for a revision it already reported.

## 0.13.0

### Minor Changes

- 7d30b71: New `/firebase/realtime` entry point with `realtimeDatabaseAdapter()` for the Firebase Realtime Database, plus `realtimeStoreFromAdmin()` (Admin SDK) and `realtimeStoreFromWebSdk()` (web SDK) wrappers. One child node per key, transactional writes with `ifRevision` conflict detection, `list(prefix)` and `subscribe` that reports other clients' changes. Tested against the Realtime Database emulator through both SDKs in CI.

### Patch Changes

- c4339ab: `supabaseAdapter`'s `list` now stops as soon as a page brings no key it has not already seen, as well as on an empty page. Before, a client or proxy that ignored the `range` it was asked for sent the same rows for ever and `list` never returned (and grew without limit). PostgREST honours the range, so nothing changes against Supabase itself.

## 0.12.0

### Minor Changes

- be94f0b: Add a Supabase adapter as the optional `@richardmcquiston01/storage-adapters/supabase` entry point. `supabaseAdapter({ client, table?, schema?, onWatchError? })` keeps each key as a row in a PostgreSQL table, reached through the `supabase-js` client, with a counter `revision`. `supabaseSetupSql({ table?, schema? })` returns the SQL to run once: the table (UUID id, value, revision, timestamps), row-level security turned on with no policies, the key's unique index as the replica identity (so a Realtime delete carries the key and nothing else), the table in the `supabase_realtime` publication, and two functions the adapter calls through `rpc`: `<table>_set`, which checks the revision and writes in one statement (so two writers holding the same revision cannot both win, and a key with nothing stored is created), and `<table>_list`. No SDK is bundled; the real `supabase-js` client type-checks against `SupabaseClientLike` without casts. `list` pages through the results until the server has nothing more, so it works under the project's row limit. `subscribe` reports your own writes and, through one Realtime `postgres_changes` channel on the table, changes other clients make, once each. PostgREST errors map to `forbidden` (including row-level security and bad keys), `quota`, `invalid` (a missing table or function says to run the setup SQL; text PostgreSQL cannot hold) and `unavailable`, and messages name the key. Row-level security policies stay your job.

## 0.11.0

### Minor Changes

- 9c1d378: Add a Firestore adapter as the optional `@richardmcquiston01/storage-adapters/firebase` entry point. `firestoreAdapter({ store, now?, onWatchError? })` keeps each key as one document (`key`, `value`, a counter `revision`, `created_at`, `updated_at`) in a collection, with the key's characters other than letters, digits and `-` escaped in the document id, since Firestore ids cannot hold `/`, `.`, `..` or `__name__`. A transaction reads then writes the document, so `set` with `ifRevision` is atomic across clients (a key with nothing stored is created). No SDK is bundled: `firestoreStoreFromAdmin({ firestore, collection? })` wraps `@google-cloud/firestore` or `firebase-admin`, and `firestoreStoreFromWebSdk({ firestore, sdk, collection? })` wraps `firebase/firestore`; or pass your own `FirestoreStoreLike`. `subscribe` listens to the document with `onSnapshot`, so it reports other clients' changes as well as your own, once each. `list` is a range query on `key`. SDK errors map to `forbidden`, `quota`, `invalid` and `unavailable`, a document that is not a stored entry is `corrupt`, and messages name the key. Writes to one key through one adapter run in turn, so many at once do not pile up on Firestore's transaction locks. Security rules stay your job.

## 0.10.0

### Minor Changes

- 3c00d43: Add a REST adapter as the optional `@richardmcquiston01/storage-adapters/rest` entry point. `restAdapter({ baseUrl, fetch, headers?, name? })` keeps each key behind a small JSON API (`GET`, `PUT` and `DELETE` on `{baseUrl}/{key}`, and `GET {baseUrl}?prefix=` for `list`), with the revision in the JSON or an `ETag` and `If-Match` for `ifRevision`. A server that answers 404 or 412 for a key with nothing stored is asked again with `If-None-Match: *`, so the key is created as the contract says. You pass in the `fetch`, so the package still makes no request itself; `headers` can be a function, to refresh a token. HTTP statuses map to `forbidden`, `quota`, `invalid` and `unavailable`, a reply that is not the documented shape is `corrupt`, and messages carry the status and the server's own words. `subscribe` reports changes made through the same adapter.
- 3c00d43: Add an optional `list(prefix, { signal })` to `StorageAdapter`: it resolves the keys that start with `prefix` (`''` for all), sorted in code-unit order, as plain text (never a pattern), to list or clear a namespace. `memoryAdapter`, the browser adapters, IndexedDB, SQLite, PostgreSQL, MySQL, Redis (`SCAN`), S3 (`ListObjectsV2`), the file adapter and the JSON, YAML and INI adapters all have it, and the wrappers pass it through (`withPrefix` strips its prefix, `withFallback` merges both stores, `withRetry` retries it, `withLogging` reports it as operation `list` with the prefix as `key`). An adapter that cannot list answers `invalid` and says what it lacks. New optional pieces of the interfaces they sit on: `FileSystemLike.listFiles` (`nodeFileSystem()` has it), `SqliteStatementLike.all`, `WebStorageLike.length` and `key()`, `IdbObjectStoreLike.getAllKeys`, `ObjectStoreLike.listKeys` and `AwsSdkCommands.ListObjectsV2Command`. Also exports `compareKeys` and `keysWithPrefix` for adapters of your own.
- 6439fd2: Add cross-process locking to the file adapters. Pass `lock: { sleep, staleMs?, timeoutMs?, retryMs? }` to `fileAdapter`, `jsonFileAdapter`, `yamlFileAdapter` or `iniFileAdapter` and every write and removal first takes a lock file (`<key>.json.lock` beside the key's file, or `<file>.lock` beside the document) made with the file system's exclusive create, so several processes can share one directory or document without losing updates, and `ifRevision` is checked against what another process just wrote. With four real processes each adding to a shared counter 25 times, 66 of 100 additions were lost without the lock and none with it. A lock that cannot be had within `timeoutMs` gives `unavailable` naming the lock file and writes nothing; a lock older than `staleMs` is taken to be left by a dead process and is broken, and a lock is only released if it is still the one that write took. You pass `sleep`, so the library still has no timers. It needs a `FileSystemLike` with `writeNewFile` (`nodeFileSystem()` has it) and a file system where exclusive create is atomic, and it is advisory: it protects writers that all use it. Without `lock` nothing changes.

### Patch Changes

- `nodeFileSystem()` retries a rename that fails with `EPERM`, `EACCES` or `EBUSY` for up to about half a second before giving up. On Windows, replacing a file fails this way while another process has it open, which made a write fail when a second process was reading the same file.

## 0.9.0

### Minor Changes

- cf307d4: `fileAdapter` now reports changes made by other processes to its files. While something is subscribed, it watches the directory through the new optional `FileSystemLike.watchDirectory(directory, onChange)` (which `nodeFileSystem()` provides), re-reads the file that changed and tells the subscribers of that key if its value or revision is different. Its own writes are reported once, temporary files and half-written files are ignored, and the watcher stops when the last subscriber leaves. A file system without `watchDirectory` behaves as before. Hearing about another process's write does not make two writers safe; the one-process-per-directory warning stands.
- 030fd95: Add a Redis adapter as the optional `@richardmcquiston01/storage-adapters/redis` entry point. `redisAdapter({ client, prefix?, ttlSeconds?, subscriber?, onSubscriberError?, subscriberRetryMs? })` keeps each key as a Redis hash holding a counter revision and the value, and works with Redis, Valkey, KeyDB and Dragonfly. A Lua script checks the revision, writes, sets the expiry and announces the change in one step, so `set` with `ifRevision` is atomic across processes (a key with nothing stored is created). No client is bundled: `redisCommandsFromIoredis(client)` and `redisCommandsFromNodeRedis(client)` wrap `ioredis` and node-redis, or pass anything with `command(args)`. `ttlSeconds` expires keys after each write for cache-style data. `subscribe` reports changes made through the same adapter, and, given a `subscriber` connection (`redisSubscriberFromIoredis`, `redisSubscriberFromNodeRedis`), changes other processes make with the same prefix, over Pub/Sub. The channel carries only the key, never the value; a listener reads the hash, so a forged `PUBLISH` cannot deliver a value and a subscriber to the channel learns none. A subscriber that fails to start is retried while anyone is subscribed.

### Patch Changes

- 898da6b: Fix bugs found in review. `memoryAdapter` no longer rejects a write that succeeded when a subscriber throws. `withRetry` returns an `unavailable` result naming the key when its `sleep` rejects, and starts no attempt after an abort during the wait. `withFallback` checks `ifRevision` on the secondary when the primary could not take the write, so a stale revision is a `conflict` instead of an overwrite. `withReadCache` no longer stores a read that a later write, removal or change notice overtook, so a removed value is not brought back. `withEncoding` reports a value that cannot be decoded to the new optional `onSubscribeError(key, message)` instead of dropping it, and delivers changes in order. `createPersistence` throws for the envelope's own field names `v` and `savedAt` (they made saved values unreadable); a merge function runs once and a second conflict returns `outcome: 'conflict'` instead of merging again and again; a queued forced save no longer makes the save that replaced it forced; and a failed `remove` no longer forgets the tracked revision or a failed save the text it echo-filters. Uncached `documentFileAdapter` reads (JSON, YAML, INI with `cache: false`) go through the write queue, so one that finishes late cannot report the document as it was before a write. The file adapters write temporary files with a random name and an exclusive create (`FileSystemLike.writeNewFile`, provided by `nodeFileSystem`), skip a name that exists instead of writing through it, and only remove a file they created. The browser storage adapters read a key back after writing and report `conflict` if another tab's write landed after theirs; the docs now say plainly that the check is not atomic between tabs and point to `indexedDbAdapter`.

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
