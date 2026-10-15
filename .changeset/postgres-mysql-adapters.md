---
'@richardmcquiston01/storage-adapters': minor
---

Add PostgreSQL and MySQL adapters as optional entry points. `postgresAdapter()` from `/postgres` takes any client with `query(sql, parameters)` that resolves `{ rows }` (`pg`, PGlite), and `mysqlAdapter()` from `/mysql` takes a `mysql2/promise` pool or connection. Both keep a `storage_entry` table (a `table` option names another) with a UUID id, the value, a counter revision and `created_at`/`updated_at`, create it on first use, and make the `ifRevision` check atomic, so two connections racing with the same revision cannot both win. Neither bundles a driver. `subscribe` reports changes made through the same adapter.
