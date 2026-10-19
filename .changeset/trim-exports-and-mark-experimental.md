---
'@richardmcquiston01/storage-adapters': minor
---

Prepare the public surface for 1.0. **Breaking:** `utf8Length` (from the main entry point), `firestoreDocumentId` and `firestorePrefixUpperBound` (from `/firebase`), and `realtimeNodeKey` and `keyFromRealtimeNodeKey` (from `/firebase/realtime`) are no longer exported. They were implementation details of key encoding and size checks. The adapters behave as before. `/firebase`, `/firebase/realtime`, `/supabase`, `/react` and Postgres's `listener` option are tagged `@experimental` in the type definitions: they may change in a minor release until they have run against the real service. `compareKeys`, `keysWithPrefix` and `DEFAULT_MAX_BYTES` stay public and are now documented in the README, which also has a new Stability section.
