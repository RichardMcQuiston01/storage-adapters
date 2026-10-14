# ROADMAP

## Next

1. **Generic `createPersistence<T>`**: codec, normalize hook, size limit,
   serialized saves, conflict policy and `watch`, replacing the
   layout-specific persistence helper.
2. **Switch the toolkit** to depend on this package; it keeps re-exporting
   the wrappers so its public API and tests are unchanged.

## Later

- Optional adapter subpaths (browser storage, IndexedDB, REST); the core
  stays I/O-free.
- Optional React hook (`useStoredValue`).
