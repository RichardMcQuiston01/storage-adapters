---
'@richardmcquiston01/storage-adapters': minor
---

Add the `/rabbitmq` entry point with `rabbitMqAdapter()`, an adapter that keeps its data as an append-only log in a RabbitMQ stream. It takes an `amqplib` confirm channel (or a function that opens one), appends every write and removal as a message, and replays the stream into a table in memory. Because every process applies the same messages in the same order, `ifRevision` is decided by the log and is atomic across processes, and `subscribe` hears changes from any process without polling. Revisions are stream offsets. `get` and `list` are current by default (a marker goes through the stream first) or read the local copy with `readConsistency: 'local'`. All entries are held in memory and the stream must never expire, so it suits settings and state. Tested against a real RabbitMQ broker in CI.
