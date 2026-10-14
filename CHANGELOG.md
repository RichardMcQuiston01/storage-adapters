# CHANGELOG

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
