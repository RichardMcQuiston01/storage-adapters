---
'@richardmcquiston01/storage-adapters': minor
---

Add the optional `@richardmcquiston01/storage-adapters/sqlite` entry point with `sqliteAdapter({ database })`: a `StorageAdapter` over SQLite for servers, scripts and desktop apps. It imports no driver; pass in a `node:sqlite` or `bun:sqlite` database, or any driver with `exec` and `prepare`. Each key is a row in a `storage_entry` table (UUID id, counter revision, `created_at` and `updated_at`) created on first use. The revision check and the write are one statement, so `set` with `ifRevision` returns `conflict` when another connection wrote first. Maps a full disk to `quota`, a read-only database to `forbidden`, a damaged file to `corrupt` and anything else to `unavailable`, and never throws. `subscribe` reports changes made through the same adapter. The main entry stays free of I/O.
