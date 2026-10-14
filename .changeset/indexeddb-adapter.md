---
'@richardmcquiston01/storage-adapters': minor
---

Add the optional `@richardmcquiston01/storage-adapters/indexeddb` entry point with `indexedDbAdapter()`: a `StorageAdapter` over IndexedDB for values too large or too many for `localStorage`. Values carry counter revisions, and the revision check and the write run in one transaction, so `set` with `ifRevision` returns `conflict` when another tab wrote first. `subscribe` reports changes made by other tabs through a `BroadcastChannel`. Maps `QuotaExceededError` to `quota`, `SecurityError` to `forbidden` and anything else to `unavailable`, and never throws. Accepts `factory`, `databaseName`, `storeName` and `channel` options. The main entry stays free of I/O.
