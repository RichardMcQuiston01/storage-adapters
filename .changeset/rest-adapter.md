---
'@richardmcquiston01/storage-adapters': minor
---

Add a REST adapter as the optional `@richardmcquiston01/storage-adapters/rest` entry point. `restAdapter({ baseUrl, fetch, headers?, name? })` keeps each key behind a small JSON API (`GET`, `PUT` and `DELETE` on `{baseUrl}/{key}`, and `GET {baseUrl}?prefix=` for `list`), with the revision in the JSON or an `ETag` and `If-Match` for `ifRevision`. A server that answers 404 or 412 for a key with nothing stored is asked again with `If-None-Match: *`, so the key is created as the contract says. You pass in the `fetch`, so the package still makes no request itself; `headers` can be a function, to refresh a token. HTTP statuses map to `forbidden`, `quota`, `invalid` and `unavailable`, a reply that is not the documented shape is `corrupt`, and messages carry the status and the server's own words. `subscribe` reports changes made through the same adapter.
