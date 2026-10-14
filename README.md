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

For data that should last only as long as the tab, such as a half-finished form,
use `sessionStorageAdapter` from the same entry point. It stores the same
revisioned envelope, takes the same options, and reports the same errors, naming
`sessionStorage` instead of `localStorage`.

```ts
import { sessionStorageAdapter } from '@richardmcquiston01/storage-adapters/browser';

const draft: StorageAdapter = sessionStorageAdapter();
```

Each tab has its own `sessionStorage`, so `subscribe` only hears about writes
from other documents in the same tab, such as same-origin iframes. Both adapters
ignore a change made to the other kind of storage under the same key.

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

#### File storage

For small servers, scripts and tools that want plain files, use `fileAdapter` from
the optional `/file` entry point. It keeps one file per key in a directory. It
imports no file system module, so you pass one in. `nodeFileSystem()` from
`/file/node` is built on `node:fs/promises`; it works on Node and Bun, and Deno
provides the same module.

```ts
import { fileAdapter } from '@richardmcquiston01/storage-adapters/file';
import { nodeFileSystem } from '@richardmcquiston01/storage-adapters/file/node';

const adapter: StorageAdapter = fileAdapter({
  directory: './data',
  fileSystem: nodeFileSystem(),
});
```

A key becomes a safe file name: `a-z`, `0-9` and `-` stay as they are, an uppercase
letter becomes `_` and its lowercase form, and every other byte becomes `~` and two
hex digits. So `Layout/1` is stored as `_layout~2f1.json`, keys that differ only in
case never share a file even on a case-insensitive disk, and no key can leave the
directory. A key must be 1 to 200 characters after encoding and valid Unicode, or
the call returns `invalid`. Each file holds the value and a counter revision as
`{ "r": "1", "v": "..." }`.

A write goes to a temporary file that is renamed over the real one, so a reader
sees the old value or the new one, never half of a write. Writes to the same key
are queued, so `set` with `ifRevision` returns `conflict` when another write got
there first. A full disk is `quota`, a permission error is `forbidden`, a file that
is not an entry is `corrupt`, and nothing throws. A crash can leave a `*.tmp` file
behind; it is safe to delete.

**Use one process per directory.** The queue lives in the process, so two
processes writing the same directory can lose updates. In a test with four
processes each adding 1 to a shared counter 40 times, about half of the additions
were lost. Use the SQLite adapter when more than one process writes. The adapter
does not `fsync`, so a power failure shortly after a write can lose it.
`subscribe` reports changes made through adapters in this process.

#### JSON file storage

For small amounts of data that a person might open and edit, such as settings,
use `jsonFileAdapter` from the optional `/json-file` entry point. It keeps every
key in one JSON file. Like the file adapter, it imports no file system module:
pass `nodeFileSystem()` from `/file/node`, or your own `FileSystemLike`.

```ts
import { nodeFileSystem } from '@richardmcquiston01/storage-adapters/file/node';
import { jsonFileAdapter } from '@richardmcquiston01/storage-adapters/json-file';

const settings: StorageAdapter = jsonFileAdapter({
  path: './config/settings.json',
  fileSystem: nodeFileSystem(),
});
```

The file is readable and sorted by key, one entry per key:

```json
{
  "theme": { "r": "3", "v": "dark" }
}
```

`r` is the counter revision and `v` is the value. The file is read once and kept
in memory. Every write starts from the file again, changes one entry, and replaces
the whole file through a temporary file and a rename, so a reader never sees half
of a write and an edit made outside to another key is kept. Writes are queued, so
`set` with `ifRevision` returns `conflict` when another write got there first. The
folder is created on first write. Any string is a valid key.

When something is subscribed and the file system can watch (`nodeFileSystem()`
can), the file is watched, and an edit made outside, in place or by an editor that
replaces the file, is picked up and reported to subscribers of the keys that
changed. Pass `watch: false` to turn that off. Without a watcher, an outside edit
is not seen by `get` until the next write; pass `cache: false` to read the file on
every `get` instead. If you edit a value by hand, change its `r` too, or a writer
holding the old revision will not see a conflict.

A file that is not a JSON object is never overwritten: every call returns
`corrupt`, naming the file, until you fix it, and the file is left exactly as it
was. One entry that is not valid is `corrupt` for that key only, and the next
`set` replaces just that entry. A full disk is `quota`, a permission error is
`forbidden`, and nothing throws.

Choose by how much data you have and who writes it:

| Adapter | Good for | Limit |
| --- | --- | --- |
| `jsonFileAdapter` | Settings a person may edit by hand | Rewrites the whole file on each write; one process |
| `fileAdapter` | Many or large values | One process per directory |
| `sqliteAdapter` | Several processes writing | Needs a SQLite driver |

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

See `test/adapters.test.ts` for each wrapper in use, `test/browser.test.ts` for the browser adapters (localStorage and sessionStorage), `test/indexeddb.test.ts` for the IndexedDB adapter `test/sqlite.test.ts` for the SQLite adapter and `test/file.test.ts` for the file adapter and `test/json-file.test.ts` for the JSON file adapter.

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
