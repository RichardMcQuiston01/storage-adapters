# ROADMAP

## Shipped

- **0.1.0**: the `StorageAdapter` contract and wrappers, moved from
  `dashboard-widgets-toolkit`.
- **0.2.0**: `createPersistence<T>`: typed persistence with a versioned
  envelope, conflict policies, serialized saves and `watch`.

## Next

1. **Switch the toolkit** to depend on this package; it keeps re-exporting
   the wrappers so its public API and tests are unchanged.

## Later

- More optional adapter subpaths (IndexedDB, REST); the core stays I/O-free.
  Browser storage (`/browser`, `localStorageAdapter`) is built and ships with
  the next release.
- Optional React hook (`useStoredValue`).
