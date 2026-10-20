---
'@richardmcquiston01/storage-adapters': minor
---

Add the `/rethinkdb` entry point with `rethinkDbAdapter()`, an adapter over a `rethinkdb-ts` connection. It stores each entry as a document keyed by the entry's key (at most 127 bytes, RethinkDB's primary key limit) with a counter revision, writes with one atomic `replace` function so `ifRevision` is checked across processes, lists with a primary-key range query, and uses a changefeed for `subscribe` so it hears changes made by any process, reconnecting if the feed ends. Verified against a real RethinkDB server in CI.
