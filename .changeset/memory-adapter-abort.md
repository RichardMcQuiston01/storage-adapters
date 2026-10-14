---
'@richardmcquiston01/storage-adapters': patch
---

`memoryAdapter()` now honours an aborted signal like every other adapter: `get`, `set` and `remove` return an `unavailable` result that names the key, and leave the stored data untouched. Before, they ignored the signal.
