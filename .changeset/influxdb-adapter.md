---
'@richardmcquiston01/storage-adapters': minor
---

Add the `/influxdb` entry point with `influxDbAdapter()`, a best-effort adapter over InfluxDB 2.x's HTTP API. It takes a `fetch`, stores each entry as a point at one fixed timestamp so a new write replaces the old one, escapes keys and values so they come back exactly, lists with a Flux query, removes with the delete API, and can find changes made by other processes with `pollIntervalMs`. InfluxDB cannot compare and write in one step, so `ifRevision` is checked by a read before the write: writers sharing one adapter take turns, but two processes can both win. The bucket must keep data forever. Tested against a real InfluxDB server in CI.
