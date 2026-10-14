---
'@richardmcquiston01/storage-adapters': minor
---

Add the optional `@richardmcquiston01/storage-adapters/browser` entry point with `localStorageAdapter()`: a `StorageAdapter` over `localStorage` with counter revisions (stored as `{ "r": revision, "v": value }`), `conflict` detection with `ifRevision`, cross-tab `subscribe` via `storage` events, typed errors (`quota`, `forbidden`, `corrupt`, `unavailable`) and abort support. Nothing throws, and a blocked `localStorage` is reported as `unavailable`. Also exports the types `LocalStorageAdapterOptions`, `WebStorageLike`, `StorageEventTarget` and `StorageChangeEvent`. The root entry stays I/O-free.
