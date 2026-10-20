---
'@richardmcquiston01/storage-adapters': minor
---

Add the `/clickhouse` entry point with `clickHouseAdapter()`, a best-effort adapter over ClickHouse's HTTP interface. It takes a `fetch`, appends a row to a `ReplacingMergeTree` table for every write and reads the row with the highest revision, removes by appending a row marked deleted, and can find changes made by other processes with `pollIntervalMs`. ClickHouse has no transactions, so `ifRevision` is one insert-if-the-revision-matches statement followed by a read to see whether the write won: writers sharing one adapter take turns, but two processes writing a key at the same instant can both be told they succeeded. Tested against a real ClickHouse server in CI.
