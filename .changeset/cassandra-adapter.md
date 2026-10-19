---
'@richardmcquiston01/storage-adapters': minor
---

Add the `/cassandra` entry point with `cassandraAdapter()`, an adapter over a `cassandra-driver` `Client`. It stores each entry as a row, uses lightweight transactions so `ifRevision` is checked atomically, reads at SERIAL consistency, lists by scanning the table, and can find changes made by other processes with `pollIntervalMs`. Tested against a real Cassandra node in CI. The change polling now shared with the ArangoDB adapter lives in one internal helper.
