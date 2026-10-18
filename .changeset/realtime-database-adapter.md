---
'@richardmcquiston01/storage-adapters': minor
---

New `/firebase/realtime` entry point with `realtimeDatabaseAdapter()` for the Firebase Realtime Database, plus `realtimeStoreFromAdmin()` (Admin SDK) and `realtimeStoreFromWebSdk()` (web SDK) wrappers. One child node per key, transactional writes with `ifRevision` conflict detection, `list(prefix)` and `subscribe` that reports other clients' changes. Tested against the Realtime Database emulator through both SDKs in CI.
