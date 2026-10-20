---
'@richardmcquiston01/storage-adapters': minor
---

Add the `/neo4j` entry point with `neo4jAdapter()`, an adapter over a `neo4j-driver` `Driver`. It stores each entry as a node with a uniqueness constraint on `key` and a counter revision, takes the node's lock inside one Cypher statement so `ifRevision` is checked atomically across processes, retries lock conflicts, lists with one query, and can find changes made by other processes with `pollIntervalMs`. Tested against a real Neo4j server in CI.
