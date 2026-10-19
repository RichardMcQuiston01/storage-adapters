---
'@richardmcquiston01/storage-adapters': patch
---

Tag the `pollIntervalMs` and `onPollError` options of `mysqlAdapter` `@experimental`, the same as Postgres's `listener` option: they are new and have only been tested against MariaDB, so they may change in a minor release. The README's Stability section now links to the versioning policy.
