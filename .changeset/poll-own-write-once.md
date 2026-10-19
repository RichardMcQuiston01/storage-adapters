---
'@richardmcquiston01/storage-adapters': patch
---

Fix polling (`pollIntervalMs`) in the MySQL, ArangoDB and Cassandra adapters so a subscriber hears its own adapter's write once. A poll that read the new value before the write had been announced could report it a second time. Polls now leave a key alone while a write to it through the adapter is under way.
