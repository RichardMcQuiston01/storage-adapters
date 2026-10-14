---
'@richardmcquiston01/storage-adapters': patch
---

Fix `jsonFileAdapter` serving a stale value after a conflict. When `set` found that the file had changed outside (a revision conflict, or a refused write), it left its cached copy as it was, so a caller that re-read with `get` and retried got the old value and the old revision, and conflicted again until something else refreshed the cache. Now every fresh read of the file updates what `get` returns, and subscribers are told about any outside change found while writing instead of missing it.
