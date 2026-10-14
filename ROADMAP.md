# ROADMAP

## Next

1. **Move the generic adapter code** out of `dashboard-widgets-toolkit`
   (`src/core/storage.ts`): `StorageAdapter`, `StoredValue`, `StoreResult`,
   `StoreErrorCode`, `utf8Length`, `memoryAdapter`, `withPrefix`,
   `withFallback`, `withReadCache`, `readOnly`, `withRetry`, `withEncoding`,
   `withLogging` and their tests.
2. **Generic `createPersistence<T>`**: codec, normalize hook, size limit,
   serialized saves, conflict policy and `watch`, replacing the
   layout-specific persistence helper.
3. **Switch the toolkit** to depend on this package; it keeps re-exporting
   the wrappers so its public API and tests are unchanged.

## Later

- Optional adapter subpaths (browser storage, IndexedDB, REST); the core
  stays I/O-free.
- Optional React hook (`useStoredValue`).
