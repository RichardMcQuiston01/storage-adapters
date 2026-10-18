---
'@richardmcquiston01/storage-adapters': patch
---

`supabaseAdapter`'s `list` now stops as soon as a page brings no key it has not already seen, as well as on an empty page. Before, a client or proxy that ignored the `range` it was asked for sent the same rows for ever and `list` never returned (and grew without limit). PostgREST honours the range, so nothing changes against Supabase itself.
