---
'@richardmcquiston01/storage-adapters': minor
---

Add the `/arangodb` entry point with `arangoDbAdapter()`, an adapter over ArangoDB's HTTP API. It takes a `fetch`, uses the document `_rev` as the revision so `ifRevision` becomes ArangoDB's own `If-Match` check, creates or replaces a document in one request, lists with an AQL query, and can find changes made by other processes with `pollIntervalMs`. Tested against a real ArangoDB server in CI.
