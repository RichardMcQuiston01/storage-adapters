---
'@richardmcquiston01/storage-adapters': minor
---

New optional `/react` entry point with the `useStoredValue(adapter, key)` hook. It returns `{ status, value, revision, error, set, remove, refresh }`: it reads the key, follows changes other tabs or processes make when the adapter can `subscribe` (a change heard during the first read wins over that read), and its `set`, `remove` and `refresh` resolve with the adapter's `StoreResult`. Unmounting stops the listener and cancels the read; stale answers for an old key are ignored; an adapter that rejects is reported as an `unavailable` error instead of throwing into the component. React 18 or later is an optional peer dependency of this entry point only; the rest of the package is unchanged.
