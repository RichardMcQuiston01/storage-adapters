---
'@richardmcquiston01/storage-adapters': minor
---

`mysqlAdapter` can now report writes made by other processes. MySQL has no `LISTEN`/`NOTIFY`, so give it `pollIntervalMs` (at least 50) and, if you like, `onPollError`: while any key is subscribed, one query every interval reads all the subscribed keys (100 at a time) and each key whose value or revision changed is reported once. With nothing subscribed there is no query and no timer, and the timer does not keep a program running. What is stored when you subscribe is not a change; your own writes are reported at once and not again; a key removed and recreated with the same revision between polls is still noticed because the value is compared too; a failing poll is reported once per run of failures and polling carries on. Without `pollIntervalMs` nothing changes.
