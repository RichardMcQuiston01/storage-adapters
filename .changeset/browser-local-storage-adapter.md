---
'@richardmcquiston01/storage-adapters': minor
---

Add the optional `@richardmcquiston01/storage-adapters/browser` entry point with `localStorageAdapter()`: a `StorageAdapter` over `localStorage` with counter revisions (`set` with `ifRevision` returns `conflict` when another tab wrote first), `subscribe` for changes made in other tabs, `quota` / `forbidden` / `unavailable` error mapping, and no throws. Accepts `storage` and `events` options for non-global storage. The main entry stays free of I/O. Extracted from `chat-and-react`.
