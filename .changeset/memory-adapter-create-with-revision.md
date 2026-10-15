---
'@richardmcquiston01/storage-adapters': patch
---

`memoryAdapter()` now creates a key that has nothing stored when `set` is given `ifRevision`, like every other adapter. Before, it returned `conflict`. The `StorageAdapter.set` documentation now states the rule: `conflict` only when a value is stored and its revision differs.
