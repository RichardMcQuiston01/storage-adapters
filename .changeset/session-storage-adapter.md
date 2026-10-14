---
'@richardmcquiston01/storage-adapters': minor
---

Add `sessionStorageAdapter()` to the `@richardmcquiston01/storage-adapters/browser` entry point: a `StorageAdapter` over `sessionStorage` for data that lasts as long as the tab. It shares its code, revisioned envelope, options (`storage`, `events`) and error mapping with `localStorageAdapter()`, and names `sessionStorage` in its errors. Each tab has its own `sessionStorage`, so `subscribe` hears about writes from other documents in the same tab, such as same-origin iframes.

Also fix `subscribe` in both browser adapters: a `storage` event now carries which storage changed, and a change to the other kind of storage under the same key no longer reaches the subscriber. Before, a `sessionStorage` write in an iframe could wrongly notify a `localStorageAdapter()` subscriber for the same key. `StorageChangeEvent` gains an optional `storageArea` field, and an event without one is still accepted.
