---
'@richardmcquiston01/storage-adapters': minor
---

Add the `/memcached` entry point with `memcachedAdapter()` and `memcachedFromMemcacheClient()`, an adapter over Memcached for cache-style storage. It keeps a counter revision with each value and uses Memcached's `add` and `cas` so `ifRevision` is atomic across processes, escapes keys Memcached would refuse, and supports a `ttlSeconds` expiry. It has no `list` (Memcached cannot list keys) and its `subscribe` reports only writes made through the same adapter. Tested against a real Memcached server in CI.
