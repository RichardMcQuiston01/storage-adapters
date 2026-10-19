---
'@richardmcquiston01/storage-adapters': minor
---

Add the `/nats` entry point with `natsKvAdapter()`, an adapter over a NATS JetStream key-value bucket. It uses the server's own sequence check for `ifRevision`, watches keys for `subscribe` so it hears writes from other processes, and escapes keys the bucket would refuse. Tested against a real NATS server in CI.
