# CHANGELOG

## 0.2.0

### Minor Changes

- c64f011: Add `createPersistence<T>(adapter, { parse, ... })`: typed persistence over any `StorageAdapter` with a versioned envelope, tolerant reads (`parse` repairs, and also reads a bare value), a size limit, revision tracking, a conflict policy (`'ask'`, `'overwrite'`, `'keep-theirs'` or a merge function), saves serialized per key (rapid saves collapse into the newest), `remove` and `watch`. Generalised from the toolkit's layout persistence.

## 0.1.0

### Minor Changes

- f3ac32a: First feature release: the `StorageAdapter` contract (`StoredValue`, `StoreResult`, `StoreErrorCode`) and the composable wrappers `memoryAdapter`, `withPrefix`, `withFallback`, `withReadCache`, `readOnly`, `withRetry`, `withEncoding` and `withLogging`, plus `utf8Length`. Moved from `dashboard-widgets-toolkit` unchanged.
