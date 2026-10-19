# Versioning, support and deprecation

> **Draft defaults.** The numbers on this page (support windows, deprecation period, supported environments) are proposed defaults for review. They take effect at 1.0.0. Until then the package is 0.x and a minor release may break things, as the changelog shows.

This page says what you can rely on from 1.0.0 onward. Which entry points are Stable and which are Experimental is decided in the [export audit](export-audit.md).

## What is public

A change to any of these that could break working code is a breaking change.

- **The contract.** `StorageAdapter`, `StoredValue`, `StoreResult` and `StoreErrorCode`, and what each method promises: every operation returns a `StoreResult`, nothing throws, error messages name the key, an aborted `signal` returns `unavailable` without touching the backend, and `set` with `ifRevision` returns `conflict` when the stored revision differs.
- **The exports of every Stable entry point**, with their documented parameters, return values and behavior: the main entry (the wrappers `withPrefix`, `withFallback`, `withReadCache`, `withRetry`, `withEncoding`, `withLogging` and `readOnly`, `memoryAdapter`, `createPersistence`, `compareKeys`, `keysWithPrefix`, `DEFAULT_MAX_BYTES`), and `/browser`, `/indexeddb`, `/sqlite`, `/file`, `/file/node`, `/json-file`, `/yaml-file`, `/ini-file`, `/postgres`, `/mysql`, `/redis`, `/s3` and `/rest`.
- **The structural driver types**, such as `PostgresClientLike` and `FileSystemLike`. They are the contract between an adapter and a driver. Adding a required member to one is a breaking change, because code written against the old shape stops compiling. The real driver's own type must keep fitting without a cast.
- **Documented stored layouts.** Where the README describes how an adapter stores data (the `storage_entry` table and its columns, the Realtime Database and Firestore node and document names, file names, S3 object keys, the `createPersistence` envelope), data written by one release is read by every later release of the same major version. Changing a documented layout without a migration is breaking.

Not public, and free to change in any release: anything not exported, the text of error messages (the `code` is public, the wording is not), the exact value of a `revision` (it is opaque: compare it for equality, never parse it), and the files in `dist/`.

## Experimental

An export tagged `@experimental` in the type definitions, and the entry points listed as Experimental in the export audit, are **not covered** by the rules on this page. They may change in a minor release. The changelog says so under the release that changes them.

An entry point leaves Experimental, in a minor release, when its conformance suite has run against the real service (not an emulator or a fake) and one major version of its vendor SDK has gone through without breaking it. For `/react`, that means running in a real React app.

## Version numbers

The package follows [Semantic Versioning](https://semver.org/).

| Change                                                                                                                                                                                                                   | Example                                     | Bumps     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | --------- |
| Removing or renaming a Stable export; changing behavior in a way that can break callers; adding a required member to a driver type; changing a documented stored layout without migration; requiring a newer environment | dropping `list` from an adapter that has it | **major** |
| Adding an export, an entry point, an option, or an optional member to a driver type; adding a new `StoreErrorCode`                                                                                                       | a new backend as a new entry point          | **minor** |
| A bug fix, a documentation change, or an internal change                                                                                                                                                                 | fixing a cache that went stale              | **patch** |

A new `StoreErrorCode` is a minor change, so code that handles errors should treat an unknown code as a failure rather than assume the list is closed.

A bug fix can change behavior that someone relied on. If the old behavior contradicted the documentation, it is a bug fix. If the documentation described it, it is a breaking change.

## Support

The maintainer supports each release line on a best-effort basis:

| Line                                  | Gets                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| The latest minor of the current major | Bug fixes and security fixes                                                             |
| The last minor of the previous major  | Security fixes and critical bug fixes, for **6 months** after the next major is released |
| Anything older                        | Nothing. Upgrade                                                                         |

Fixes are released as patch versions. There is no guaranteed response time. To report a security problem, see [SECURITY.md](../SECURITY.md).

## Deprecation

Within a major version, something is deprecated before it is removed.

1. **Announce.** The release that deprecates it marks it `@deprecated` in the type definitions, with what to use instead, and lists it in the changelog.
2. **Keep.** It keeps working, unchanged, for at least **3 months and one minor release**.
3. **Remove.** It is removed in the next major version, not before.

The exception is a security fix. If something cannot be kept safe, it can change in a minor or patch release, and the changelog says why.

## Environments

- **Node.js** 18 or later and **Bun** 1.3 or later (the `engines` field). Dropping a Node.js version after it leaves long-term support is not treated as breaking, and the changelog announces it.
- **Deno** is tested in CI.
- **Browsers:** the browser adapters are tested in Chromium, Firefox and WebKit. A browser version that those engines no longer support may be dropped in a minor release.
- **React** 18 or later is an optional peer dependency of `/react` only.
- **Drivers** (`pg`, `mysql2`, `ioredis`, the AWS SDK, the Firebase SDKs, `supabase-js` and the others) are optional. The adapters accept them through structural types, so no driver is bundled. A driver major version that breaks one of those types is fixed in this package and, if the fix changes a public type, released as a major version.

## Prereleases

Before a major version, release candidates (`1.0.0-rc.1`) let you try the change. A release candidate is not covered by this page and can change before the release. It is published under the `next` npm tag, never `latest`.
