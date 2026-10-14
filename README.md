# @richardmcquiston01/storage-adapters

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [Buy Me a Coffee](#buy-me-a-coffee) | [License](#license) | [Copyright](#copyright) |

## Overview

Tiny, runtime-neutral storage adapter layer for TypeScript: an async key-value contract with typed errors and revisions, composable wrappers (prefix, fallback, retry, cache, encoding), and a generic persistence helper with conflict handling. No I/O in the core.

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

Node 18+ or Bun 1.3+. TypeScript is optional but recommended; the package
ships declarations for ESM and CommonJS.

### Installation

```bash
bun add @richardmcquiston01/storage-adapters
# or: npm install @richardmcquiston01/storage-adapters
```

### Usage

An adapter is an async key-value store with typed errors and optional
revisions for conflict detection. Results are values you check, never
thrown errors.

```ts
import {
  memoryAdapter,
  withFallback,
  withPrefix,
  type StorageAdapter,
} from '@richardmcquiston01/storage-adapters';

const adapter: StorageAdapter = withPrefix(
  withFallback(myBrowserAdapter, memoryAdapter()),
  'my-app:'
);

const signal: AbortSignal = new AbortController().signal;
const saved = await adapter.set('theme', 'dark', { signal });
if (!saved.ok) {
  console.error(saved.code, saved.error); // names the key and the cause
}
```

Wrappers: `withPrefix`, `withFallback`, `withReadCache`, `readOnly`,
`withRetry` (you pass `sleep`, so there are no timers), `withEncoding`
(compression or encryption, with your own functions) and `withLogging`
(keys and outcomes, never values). Implement `get`, `set` and optionally
`remove` and `subscribe` for localStorage, IndexedDB, REST or a database.

#### Browser storage

The core does no I/O. `localStorageAdapter` lives in the optional `/browser`
entry point, so importing the main entry never touches a browser global.

```ts
import { withFallback, memoryAdapter } from '@richardmcquiston01/storage-adapters';
import { localStorageAdapter } from '@richardmcquiston01/storage-adapters/browser';

const adapter: StorageAdapter = withFallback(localStorageAdapter(), memoryAdapter());
```

Each value is stored with a counter revision, so `set` with `ifRevision`
returns `conflict` when another tab wrote first, and `subscribe` reports
changes made in other tabs. A full store is `quota`, blocked storage is
`forbidden`, and nothing throws. Pass `storage` or `events` to use something
other than the global `localStorage` and `window`.

#### IndexedDB storage

For values too large or too many for `localStorage`, use `indexedDbAdapter` from
the optional `/indexeddb` entry point.

```ts
import { createPersistence } from '@richardmcquiston01/storage-adapters';
import { indexedDbAdapter } from '@richardmcquiston01/storage-adapters/indexeddb';

const adapter: StorageAdapter = indexedDbAdapter({ databaseName: 'my-app' });
```

It uses the same counter revisions as `localStorageAdapter`, and the revision
check and the write run in one transaction, so two tabs racing with the same
`ifRevision` cannot both win: one gets `conflict`. `subscribe` reports changes
made by other tabs through a `BroadcastChannel`, and does nothing where there is
none. A full disk is `quota`, blocked storage is `forbidden`, and nothing
throws. Pass `factory`, `storeName` or `channel` to use something other than
the global `indexedDB` and `BroadcastChannel`.

#### SQLite storage

For servers, scripts and desktop apps, use `sqliteAdapter` from the optional
`/sqlite` entry point. It imports no driver: you open the database and pass it
in, so it works with `node:sqlite` (Node 22.5 and later), Bun's `bun:sqlite`, or
any driver with the same `exec` and `prepare` methods.

```ts
import { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from '@richardmcquiston01/storage-adapters/sqlite';

const adapter: StorageAdapter = sqliteAdapter({
  database: new DatabaseSync('app.db'),
});
```

The table `storage_entry` is created on first use, with a UUID id, the key, the
value, a counter revision, and `created_at` and `updated_at` timestamps. The
revision check and the write are one SQL statement, so two connections racing
with the same `ifRevision` cannot both win: one gets `conflict`. A full disk is
`quota`, a read-only database is `forbidden`, a damaged file is `corrupt`, and
nothing throws. `subscribe` reports changes made through the same adapter, like
`memoryAdapter`; SQLite cannot announce writes made by other processes.

#### Typed persistence

`createPersistence<T>` stores one kind of value with a versioned envelope, a
size limit, revision tracking and a conflict policy. Rapid saves to a key
collapse into the newest, and every caller gets a result.

```ts
import {
  createPersistence,
  type Persistence,
} from '@richardmcquiston01/storage-adapters';

interface Preferences {
  readonly theme: string;
}

const preferences: Persistence<Preferences> = createPersistence(adapter, {
  // Repairs what it can; throw for a payload that can't be read.
  parse: (raw: unknown): Preferences => ({
    theme:
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { theme?: unknown }).theme === 'string'
        ? (raw as { theme: string }).theme
        : 'light',
  }),
  label: 'preferences', // used in error messages
  onConflict: (mine, theirs) => ({ ...theirs, theme: mine.theme }),
});

const saved = await preferences.save('user-42:prefs', { theme: 'dark' });
if (saved.ok && saved.value.outcome === 'conflict') {
  // Someone else saved first; saved.value.value is what is stored.
}
```

Conflict policies: `'ask'` (default; returns `outcome: 'conflict'`, then
save again with `force: true`), `'overwrite'`, `'keep-theirs'`, or a merge
function. `watch(key, onChange)` reports changes from elsewhere when the
adapter has `subscribe`. Pass `field` and `version` to match an existing
envelope.

### Examples

See `test/adapters.test.ts` for each wrapper in use, and `test/browser.test.ts` for the browser adapter `test/indexeddb.test.ts` for the IndexedDB adapter and `test/sqlite.test.ts` for the SQLite adapter.

[Back to Top](#table-of-contents)

## Buy Me a Coffee

If this app, code, or repository has helped you or someone you know, please consider donating. I appreciate any help to offset the costs of development and/or AI Credits.

[**Donate via Stripe**](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800), or scan:

[![Donate via Stripe](./donate.svg)](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800)

[Back to Top](#table-of-contents)

## License

Apache 2

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
