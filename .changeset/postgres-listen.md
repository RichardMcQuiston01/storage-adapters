---
'@richardmcquiston01/storage-adapters': minor
---

`postgresAdapter` can now hear writes made by other processes. Pass a dedicated `pg` `Client` as `listener` (and optionally `onListenError`): the first `subscribe` creates a `<table>_notify` function and trigger that send a `NOTIFY` after every insert, update and delete, and runs `LISTEN` on that connection. `subscribe` then reports other processes' changes, plain SQL included, once each; what is stored when you subscribe is not reported, and a key too long for a notification still works. The last unsubscribe runs `UNLISTEN`. New exported types `PostgresListenClientLike` and `PostgresNotificationLike`. Without `listener`, nothing changes. `subscribe` on a watched key no longer repeats a notification for a revision it already reported.
