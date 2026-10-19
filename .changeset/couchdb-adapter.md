---
'@richardmcquiston01/storage-adapters': minor
---

Add the `/couchdb` entry point with `couchDbAdapter()`, an adapter over Apache CouchDB's HTTP API. It takes a `fetch`, uses the document `_rev` as the revision so `ifRevision` becomes CouchDB's own conflict check, lists with `_all_docs`, and follows the `_changes` feed with long polling for `subscribe`, so it hears writes from other processes. Tested against a real CouchDB server in CI.
