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

#### PostgreSQL storage

For servers that already run PostgreSQL, use `postgresAdapter` from the optional
`/postgres` entry point. It imports no driver: you connect and pass the client in.
Anything with a `query(sql, parameters)` that resolves `{ rows }` works, which
covers `pg` (a `Pool` or a `Client`) and PGlite.

```ts
import { Pool } from 'pg';
import { postgresAdapter } from '@richardmcquiston01/storage-adapters/postgres';

const adapter: StorageAdapter = postgresAdapter({
  client: new Pool({ connectionString: process.env.DATABASE_URL }),
});
```

The table `storage_entry` (or the one you name with `table`) is created on first
use, with a native `uuid` id, the key, the value, a counter revision, and
`created_at` and `updated_at` timestamps. It needs PostgreSQL 13 or later. The
revision check and the write are one `INSERT ... ON CONFLICT ... WHERE ...
RETURNING` statement, so two connections racing with the same `ifRevision` cannot
both win: one gets `conflict`. A key with nothing stored is created. A full disk is
`quota`, a missing privilege is `forbidden`, a value PostgreSQL cannot store (such as
a NUL character) is `invalid`, and nothing throws. `subscribe` reports changes made
through the same adapter; it does not listen for writes made by other processes.

#### MySQL storage

For servers that run MySQL or MariaDB, use `mysqlAdapter` from the optional `/mysql`
entry point. It imports no driver: you connect and pass the client in. Anything
whose `query(sql, parameters)` resolves `[result, ...]` works, which is how
`mysql2/promise` (a `Pool` or a `Connection`) behaves. Connect with the `utf8mb4`
character set so emoji and other four-byte characters are kept.

```ts
import { createPool } from 'mysql2/promise';
import { mysqlAdapter } from '@richardmcquiston01/storage-adapters/mysql';

const adapter: StorageAdapter = mysqlAdapter({
  client: createPool({ uri: process.env.DATABASE_URL, charset: 'utf8mb4' }),
});
```

The table is the same as for PostgreSQL, with the id kept as `CHAR(36)`. MySQL has
no `RETURNING`, so each write sets `revision = LAST_INSERT_ID(revision + 1)` and
reads the new revision back from that statement's own result. A conditional write
is an `UPDATE ... WHERE revision = ?`; when it matches nothing, a plain `INSERT`
either creates the key or fails with "duplicate entry", which is reported as
`conflict`. Every step is a single statement, so it is safe on a pool. Keys are
compared exactly (case and trailing spaces count) and can be up to 1024 bytes of
UTF-8; a longer key is `invalid`. `subscribe` reports changes made through the same
adapter; it does not listen for writes made by other processes.

#### S3 and DigitalOcean Spaces storage

To keep values in a bucket, use `s3Adapter` from the optional `/s3` entry point. It
works with Amazon S3 and with S3-compatible services such as DigitalOcean Spaces,
MinIO and Cloudflare R2. It imports no SDK: `awsSdkObjectStore` wraps a client from
the AWS SDK for JavaScript v3, and you pass in the client and the three command
classes it uses.

```ts
import * as sdk from '@aws-sdk/client-s3';
import {
  awsSdkObjectStore,
  s3Adapter,
} from '@richardmcquiston01/storage-adapters/s3';

const client = new sdk.S3Client({
  region: 'us-east-1',
  // For Spaces, MinIO and the like, name the service:
  // endpoint: 'https://nyc3.digitaloceanspaces.com',
});

const adapter: StorageAdapter = s3Adapter({
  store: awsSdkObjectStore({ client, bucket: 'my-bucket', commands: sdk }),
  prefix: 'settings/',
  name: 'Amazon S3', // used in error messages
});
```

Each key is one object, `prefix` plus the key, and its ETag is the revision. S3 makes
the ETag from the content, so a value written again unchanged keeps its revision.
`set` with `ifRevision` is a conditional write (`If-Match`), so two writers holding
the same revision cannot both win: one gets `conflict`. A key with nothing stored is
created with `If-None-Match: *`, so a race to create it has one winner too. Keys can
be up to 1024 bytes of UTF-8 including the prefix, and a key with a `.` or `..` path
segment is `invalid`, because URL handling would turn it into a different key.

Some S3-compatible services ignore `If-Match` and would silently lose the conflict
check. Before the first write that uses `ifRevision`, the adapter checks once, on a
throwaway object under the prefix (three conditional writes and a delete), that the
store really refuses a second create and a write with the wrong ETag. If it does not,
that write is refused with `invalid` and a message saying so, and plain writes keep
working. Amazon S3 enforces conditions; set `verifyConditionalWrites: false` to skip
the check if you know your service does too. A permission error is `forbidden`, a
storage quota is `quota`, throttling and network errors are `unavailable`, and
nothing throws. `subscribe` reports changes made through the same adapter; it does
not listen for writes made by other processes.

To see how a particular service behaves before you rely on it, run the check from a
clone of this repository. It tries each conditional write step by step against your
bucket, runs the adapter, prints whether the service enforces conditions, and deletes
everything it wrote. Credentials come from the environment and are never printed.

```sh
TEST_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com \
TEST_S3_BUCKET=my-space \
TEST_S3_ACCESS_KEY_ID=... TEST_S3_SECRET_ACCESS_KEY=... \
bun run check:s3
```

To use another client, give `s3Adapter` your own `ObjectStoreLike`: `getObject`,
`putObject` (with optional `ifMatch` and `ifNoneMatch`) and `deleteObject`.

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
holding the old revision will not see a conflict. (The YAML and INI adapters below
work out the revision from the value, so they have no such step.)

A file that is not a JSON object is never overwritten: every call returns
`corrupt`, naming the file, until you fix it, and the file is left exactly as it
was. One entry that is not valid is `corrupt` for that key only, and the next
`set` replaces just that entry. A full disk is `quota`, a permission error is
`forbidden`, and nothing throws.

Choose by how much data you have and who writes it:

| Adapter | Good for | Limit |
| --- | --- | --- |
| `jsonFileAdapter` | Settings a person may edit by hand | Rewrites the whole file on each write; one process |
| `yamlFileAdapter`, `iniFileAdapter` | Settings a person edits by hand in YAML or INI | Rewrites the whole file and drops comments; one process |
| `fileAdapter` | Many or large values | One process per directory |
| `sqliteAdapter` | Several processes writing | Needs a SQLite driver |
| `postgresAdapter`, `mysqlAdapter` | Several servers sharing one database | Needs a driver and a running server |
| `s3Adapter` | Values shared by many servers, no database to run | One or more requests per call; `ifRevision` needs a store that enforces conditional writes |

#### YAML and INI file storage

For settings that people edit by hand in a format they already know, use
`yamlFileAdapter` from `/yaml-file` or `iniFileAdapter` from `/ini-file`. They work
like the JSON file adapter: one file holds every key, read once and cached, written
through a temporary file and a rename, queued, never overwriting a broken file, and
watched for outside edits when the file system can watch. No parser is bundled. You
pass in the library you use, so it is also the one that decides the exact syntax.

```ts
import YAML from 'yaml';
import * as ini from 'ini';
import { nodeFileSystem } from '@richardmcquiston01/storage-adapters/file/node';
import { iniFileAdapter } from '@richardmcquiston01/storage-adapters/ini-file';
import { yamlFileAdapter } from '@richardmcquiston01/storage-adapters/yaml-file';

const settings: StorageAdapter = yamlFileAdapter({
  path: './config/settings.yaml',
  fileSystem: nodeFileSystem(),
  yaml: YAML,
});
const legacy: StorageAdapter = iniFileAdapter({
  path: './config/app.ini',
  fileSystem: nodeFileSystem(),
  ini,
});
```

Install the library you pass in (`yaml` or `ini`). The `ini` package ships no types,
so a TypeScript project also needs `@types/ini`.

The file stays as plain as you would write it, one entry per key:

```yaml
name: dark
port: "8080"
```

```ini
name=dark
port=8080
```

There is no revision stored in the file. The revision is a fingerprint of the value,
so changing a value by hand is noticed as a new revision, and a writer holding the
old one gets `conflict`, while retyping the layout or a comment changes nothing.
The same text always has the same revision.

A value is text. A string is taken as it is, `true` and `false` as that text, and in
YAML a whole number such as `8080` as that text. Anything else is `corrupt` for
that key and left alone when the adapter writes other keys: a decimal (`1.10` is
already `1.1` by the time it is parsed, so write `"1.10"`), a list, a nested block,
a section, or an empty or `null` value. A key or value the format would not read
back as the same text is refused with `invalid` before anything is written. In INI
that means the value `null` and keys such as `a=b`, `a[]`, `__proto__` and the empty
key; YAML holds everything, including multi-line text. Use a parser that does not run
code (the `yaml` package's `parse` is safe).

**The adapter rewrites the whole file when it writes, and does not keep comments or
layout.** Comments are safe only while the program just reads the file; the first
write removes them. Like the other file adapters, it is safe within one process only.

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

See `test/adapters.test.ts` for each wrapper in use, `test/browser.test.ts` for the browser adapters (localStorage and sessionStorage), `test/indexeddb.test.ts` for the IndexedDB adapter `test/sqlite.test.ts` for the SQLite adapter, `test/postgres.test.ts`, `test/mysql.test.ts` and `test/databases.test.ts` for the PostgreSQL and MySQL adapters (set `TEST_POSTGRES_URL` and `TEST_MYSQL_URL` to also run them against real servers), `test/s3.test.ts` and `test/s3-server.test.ts` for the S3 adapter (set `TEST_S3_ENDPOINT`, `TEST_S3_BUCKET` and the two key variables to also run it against an S3-compatible server) and `test/file.test.ts` for the file adapter `test/json-file.test.ts` for the JSON file adapter and `test/yaml-ini-file.test.ts` for the YAML and INI adapters.

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
