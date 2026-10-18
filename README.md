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
`remove`, `list` and `subscribe` for localStorage, IndexedDB, REST or a database.

#### Listing keys

`list(prefix, { signal })` is an optional method that resolves the keys that start
with `prefix` (`''` for every key), sorted in plain code-unit order. Every adapter in
this package has it, and the wrappers pass it through (`withPrefix` strips its prefix
from the keys, `withFallback` merges both stores).

```ts
const keys = await adapter.list?.('draft:', { signal });
if (keys?.ok) {
  for (const key of keys.value) await adapter.remove?.(key, { signal }); // clear a namespace
}
```

It returns every matching key at once and reads no values, so it suits small stores
or narrow prefixes; a prefix is matched as plain text, never as a pattern. An adapter
that cannot list answers `invalid` and says why: the file adapter needs a
`FileSystemLike` with `listFiles` (`nodeFileSystem()` has it), SQLite needs a statement
with `all()`, the browser adapters need a storage with `length` and `key()` (the real
ones have both), IndexedDB needs `getAllKeys`, and S3 needs an object store with
`listKeys` (`awsSdkObjectStore` has it when you also pass `ListObjectsV2Command`), and Firestore needs a store with `listKeys` (both wrappers have it), and Supabase needs the `<table>_list` function from the setup SQL. The
browser adapters list only keys that hold one of their own envelopes, since the
storage is shared with the page; Redis lists every key under its `prefix`, so give it
one. Keys the adapter holds are the same as `get` would find: a corrupt document entry
is not listed.

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
changes made in other tabs. The check is exact within one tab but not atomic
between tabs, because Web Storage has no compare-and-set: after writing, the
adapter reads the key back and reports `conflict` if another tab's write landed
after its own, which narrows the gap but cannot close it. Use `indexedDbAdapter`
when writers in several tabs must never overwrite each other. A full store is
`quota`, blocked storage is `forbidden`, and nothing throws. Pass `storage` or `events` to use something
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

#### Redis storage

For servers that already run Redis (or Valkey, KeyDB, Dragonfly), use `redisAdapter`
from the optional `/redis` entry point. It imports no client: you connect and pass it
in. A small wrapper turns `ioredis` or node-redis (the `redis` package) into the one
thing the adapter needs, a way to send a command.

```ts
import { Redis } from 'ioredis';
import {
  redisAdapter,
  redisCommandsFromIoredis,
  redisSubscriberFromIoredis,
} from '@richardmcquiston01/storage-adapters/redis';

const adapter: StorageAdapter = redisAdapter({
  client: redisCommandsFromIoredis(new Redis(process.env.REDIS_URL)),
  prefix: 'app:', // default "storage:"
  ttlSeconds: 3600, // optional: expire keys an hour after each write
  // Optional: a second connection, to hear about other processes' writes.
  subscriber: redisSubscriberFromIoredis(new Redis(process.env.REDIS_URL)),
});
```

With node-redis use `redisCommandsFromNodeRedis(client)` and
`redisSubscriberFromNodeRedis(client.duplicate())` (connected). Anything with
`command(args: string[])` resolving the reply works too.

Each key is one hash, `prefix` plus the key, holding `r` (the revision, a counter
from 1) and `v` (the value). A short Lua script checks the revision, writes, sets the
expiry and announces the change in one step, so two processes racing with the same
`ifRevision` cannot both win: one gets `conflict`. A key with nothing stored is
created. An expired key reads as missing and its revision starts again at 1. Running
out of memory is `quota`, a refused login or command is `forbidden`, a key that holds
something other than a stored entry is `corrupt`, an unreachable server is
`unavailable`, and nothing throws.

`subscribe` reports changes made through the same adapter. Given a `subscriber`
connection (Redis does not let a subscribed connection run other commands, so it must
be separate) it also reports changes other processes make with the same `prefix`,
using Pub/Sub, which needs no server settings. The channel carries only the key,
never the value: on a notice the adapter reads the hash and reports what Redis holds,
so someone who can `PUBLISH` on the channel cannot forge a value, and someone who can
`SUBSCRIBE` to it learns no values. Notices for the same key close together report
the latest state. If the subscriber cannot start, writes still work, the failure goes
to `onSubscriberError`, and the adapter tries again every `subscriberRetryMs`
(default 5000, `0` for never) while anyone is subscribed.

#### Firestore storage

For apps on Firebase, use `firestoreAdapter` from the optional `/firebase` entry
point. It imports no SDK: you connect with the Firebase Admin SDK
(`@google-cloud/firestore`) or the web SDK (`firebase/firestore`) and wrap the
connection.

```ts
import { Firestore } from '@google-cloud/firestore';
import {
  firestoreAdapter,
  firestoreStoreFromAdmin,
} from '@richardmcquiston01/storage-adapters/firebase';

const adapter: StorageAdapter = firestoreAdapter({
  store: firestoreStoreFromAdmin({
    firestore: new Firestore(),
    collection: 'storage_entry', // the default
  }),
});
```

With the web SDK (a browser, or Node), pass the module along with your `Firestore`:

```ts
import { getFirestore } from 'firebase/firestore';
import * as firestoreSdk from 'firebase/firestore';
import { firestoreStoreFromWebSdk } from '@richardmcquiston01/storage-adapters/firebase';

const store = firestoreStoreFromWebSdk({
  firestore: getFirestore(app),
  sdk: firestoreSdk,
});
```

Each key is one document in the collection, with the fields `key`, `value`, `revision`
(a counter from 1), `created_at` and `updated_at` (ISO text). The document id is the
key with every character except letters, digits and `-` written as `%XX`, because
Firestore ids cannot hold `/`, `.`, `..` or `__name__`; the key itself is kept in the
`key` field, which is what `list` queries. A write is a transaction that reads the
document and then writes it, so two clients racing with the same `ifRevision` cannot
both win: one gets `conflict`. Writes to one key through one adapter run in turn (transactions that read and write the same document wait on each other's locks and retry with a back-off, so many at once can take seconds); writers in other processes still race, and the SDK retries those. A key with nothing stored is created. Rules or IAM that
refuse the call are `forbidden`, a quota or rate limit is `quota`, a key or value
Firestore cannot hold is `invalid` (an empty key, an id over 1,500 bytes, a value near
1 MiB), a document that is not a stored entry is `corrupt`, anything else, a network
failure included, is `unavailable`, and nothing throws.

`subscribe` listens to the document with `onSnapshot`, so it reports changes other
clients make as well as your own, once each. What is stored when the listener starts is
not reported as a change. If a listener stops (for example, rules that refuse reads),
`onWatchError(key, message)` says which key; that subscriber hears nothing more until it
subscribes again. `list(prefix)` is a range query on `key`, so it needs no index.
Security rules stay your job; the adapter only needs to read, write and delete
documents in its collection, and to query it for `list`.

#### Realtime Database storage

For apps on the Firebase Realtime Database, use `realtimeDatabaseAdapter` from the
optional `/firebase/realtime` entry point. Like Firestore, it imports no SDK: connect
with the Admin SDK (`firebase-admin`) or the web SDK (`firebase/database`) and wrap
the connection.

```ts
import { getDatabase } from 'firebase-admin/database';
import {
  realtimeDatabaseAdapter,
  realtimeStoreFromAdmin,
} from '@richardmcquiston01/storage-adapters/firebase/realtime';

const adapter: StorageAdapter = realtimeDatabaseAdapter({
  store: realtimeStoreFromAdmin({
    database: getDatabase(app),
    path: 'storage_entry', // the default parent node
  }),
});
```

With the web SDK, pass the module along with your `Database`:

```ts
import { getDatabase } from 'firebase/database';
import * as databaseSdk from 'firebase/database';
import { realtimeStoreFromWebSdk } from '@richardmcquiston01/storage-adapters/firebase/realtime';

const store = realtimeStoreFromWebSdk({
  database: getDatabase(app),
  sdk: databaseSdk,
});
```

Each key is one child of the parent node, with the fields `entry_key`, `entry_value`,
`revision` (a counter from 1), `created_at` and `updated_at` (ISO text). The child's
name is `k` followed by the key with every character the database refuses in a name
(`. $ # [ ] /`, control characters) and `%` written as `%XX`. The `k` keeps a name from
looking like an integer, which the database treats specially. A write is a transaction
that reads the child and then writes it (with `applyLocally` off, so nobody sees a
value that may be run again), so two clients racing with the same `ifRevision` cannot
both win: one gets `conflict`. Writes to one key through one adapter run in turn. A key
with nothing stored is created; deleting a key forgets its counter, so the next write
starts again at revision 1. Rules that refuse the call are `forbidden`, a value over
the database's 10 MB string limit or a key it cannot hold (a lone surrogate, a name
over 768 bytes) is `invalid`, a child that is not a stored entry is `corrupt`, anything
else, a network failure included, is `unavailable`, and nothing throws.

`subscribe` listens to the child with `onValue`, so it reports changes other clients
make as well as your own, once each; what is stored when the listener starts is not
reported. If a listener stops (rules that refuse reads, for example),
`onWatchError(key, message)` says which key. `list(prefix)` reads the children in order
from the prefix, 500 at a time, until one no longer starts with it. The database cannot
send names alone, so `list` also transfers the values; keep large values out of a
parent that you list often. Rules stay your job (the Admin SDK ignores them).

#### Supabase storage

For apps on Supabase, use `supabaseAdapter` from the optional `/supabase` entry point.
Supabase is PostgreSQL behind PostgREST, so this is the table and the atomic revision
check of `postgresAdapter`, reached through the `supabase-js` client instead of a
direct connection. It imports no SDK: create the client and pass it in.

Run the setup SQL once, in the SQL editor or as a migration. `supabaseSetupSql()`
returns it as text (print it, or save it into `supabase/migrations`):

```ts
import { supabaseSetupSql } from '@richardmcquiston01/storage-adapters/supabase';

console.log(supabaseSetupSql()); // or supabaseSetupSql({ table: 'app_setting' })
```

It creates the table (one row per key, with a UUID id, the value, a counter `revision`
and `created_at` and `updated_at`), turns on row-level security with no policies,
makes the key's unique index the replica identity and adds the table to the
`supabase_realtime` publication (both for `subscribe`), and creates two functions that the adapter calls
through `rpc`: `<table>_set`, which checks the revision and writes in one statement,
and `<table>_list`. It is safe to run again.

```ts
import { createClient } from '@supabase/supabase-js';
import { supabaseAdapter } from '@richardmcquiston01/storage-adapters/supabase';

const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const adapter: StorageAdapter = supabaseAdapter({
  client,
  table: 'storage_entry', // the default; the table made by the setup SQL
  schema: 'public', // the default; used for Realtime
  onWatchError: (message) => console.warn(message), // optional
});
```

Two writers racing with the same `ifRevision` cannot both win: the function writes
only if the stored revision matches, so one gets `conflict`, and a key with nothing
stored is created. Row-level security stays your job. With the service-role key (on a
server) policies are bypassed; with the anon or a user's key you need policies on the
table, for example `using (entry_key like 'user:' || auth.uid() || ':%')`. Without a
select policy a read looks like nothing stored, and a write without an insert or
update policy is `forbidden`. An expired or wrong key is `forbidden`, a quota or rate
limit is `quota`, a table or function that is not there is `invalid` and says to run
`supabaseSetupSql()`, text PostgreSQL cannot hold (a NUL) is `invalid`, and anything
else, a network failure included, is `unavailable`. Nothing throws. `supabase-js`
itself retries a failed read a few times with a back-off; pass `db: { retry: false }`
to `createClient` if you want failures at once.

`list` calls `<table>_list` and keeps asking from where the last answer ended until
the server has nothing more, so it works whatever the project's row limit (Supabase's
is 1000 per response).

`subscribe` reports your own writes and, through one Realtime `postgres_changes`
channel on the table, changes other clients make, for as long as anyone is
subscribed; the channel closes with the last subscriber. Each change is reported once.
Every client that can read the table receives every change to it (a delete tells
them only the key, because Realtime does not apply row-level security to deletes), so
this suits small stores such as settings, not a busy table. If the channel cannot join (usually the
table is not in the `supabase_realtime` publication) or a delete arrives without its
key (the replica identity is not the key's index), `onWatchError(message)` says so; writes
through the adapter are still reported.

#### REST storage

To keep values behind your own HTTP API, use `restAdapter` from the optional `/rest`
entry point. It imports nothing and never touches the network itself: you pass in the
`fetch` to use (the global one fits).

```ts
import { restAdapter } from '@richardmcquiston01/storage-adapters/rest';

const adapter: StorageAdapter = restAdapter({
  baseUrl: 'https://api.example.com/storage',
  fetch,
  headers: () => ({ Authorization: `Bearer ${currentToken()}` }), // or a plain object
  name: 'Settings API', // used in error messages
});
```

The API it talks to is small. Keys are URL-encoded in the path, and bodies are JSON:

| Request | Answer |
| --- | --- |
| `GET {baseUrl}/{key}` | `200 {"value": "...", "revision": "..."}`, or `404` when nothing is stored |
| `PUT {baseUrl}/{key}` with `{"value": "..."}` | `200`, `201` or `204`, with the new `revision` in the JSON or an `ETag` header |
| `PUT` with `If-Match: <revision>` | the same, or `412` (or `409`) when the stored revision differs |
| `DELETE {baseUrl}/{key}` | `200`, `202`, `204` or `404` |
| `GET {baseUrl}?prefix=...` (optional) | `200 {"keys": ["...", ...]}` |

The revision is opaque and is sent back exactly as the server gave it (a JSON
`revision` wins over an `ETag`). A key with nothing stored has no revision to differ,
so `set` with `ifRevision` must create it. A server that cannot do that and answers
`404` or `412` is asked what it holds: if nothing, the adapter retries with
`If-None-Match: *`; otherwise it is a `conflict` that names both revisions. A
server without revisions still works; `ifRevision` is then not enforced. Status codes
map to results: `401` and `403` are `forbidden`, `413` and `507` are `quota`, `400`
and `422` are `invalid`, a body that is not the documented shape is `corrupt`, and
everything else, a network failure included, is `unavailable`. Messages carry the
status and what the server said. `subscribe` reports changes made through the same
adapter.

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

Some S3-compatible services do not handle conditional writes correctly: one may
ignore `If-Match` and silently lose the conflict check, another may refuse a write
even when the ETag is right, so every check would report a conflict. Before the first
write that uses `ifRevision`, the adapter checks once, on a throwaway object under the
prefix (a create, a second create, a write with a wrong ETag and a write with the
object's own ETag, then a delete), that the store refuses the two that must be refused
and accepts the one that must be accepted. If it does not, that write is refused with
`invalid` and a message saying which, and plain writes keep working. Amazon S3 handles
conditions correctly; set `verifyConditionalWrites: false` to skip the check if you know
your service does too. A permission error is `forbidden`, a storage quota is `quota`,
throttling and network errors are `unavailable`, and nothing throws. `subscribe`
reports changes made through the same adapter; it does not listen for writes made by
other processes.

Observed so far: Amazon S3's documented behaviour (through the `moto` emulator) works.
MinIO (built from source, February 2026) enforces `If-Match` and `If-None-Match` with 412, and answers 404 for `If-Match` on a missing object; the whole suite passes against it in CI.
DigitalOcean Spaces (tested on `sfo3`, October 2026) refuses a quoted ETag in
`If-Match` but accepts it without quotes, and answers 412 rather than 404 for a missing
object; the adapter works out both by itself, so `ifRevision` works there. Run the check below to see how your own service behaves.

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

**Use one process per directory, or turn on the lock.** By default the write queue
lives in the process, so two processes writing the same directory can lose updates:
in a test with four processes each adding 1 to a shared counter 25 times, 66 of the 100
additions were lost. Pass `lock` and every write first takes a lock file next to its
key (`<key>.json.lock`), made with an exclusive create, so processes take turns and
`ifRevision` is checked against what the other process just wrote. The same test with
the lock loses none.

```ts
const adapter: StorageAdapter = fileAdapter({
  directory: './data',
  fileSystem: nodeFileSystem(),
  lock: {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), // you pass the timer
    // optional: staleMs 30000, timeoutMs 10000, retryMs 25
  },
});
```

A process that cannot get the lock within `timeoutMs` gets `unavailable` with the lock
file's name, and nothing is written. A lock older than `staleMs` is taken to belong to
a process that died and is broken; only the lock that was judged stale is removed, and
a lock is released only if it is still the one this write took. The lock needs a
`FileSystemLike` with `writeNewFile` (`nodeFileSystem()` has it) and a file system where
exclusive create is atomic: local disks are, some network file systems are not. A
process that stalls for longer than `staleMs` while holding a lock can lose it, and the
lock is advisory: it protects writers that all use it. Reads need no lock, because a
write replaces the file in one step. The adapter does not `fsync`, so a power failure
shortly after a write can lose it. `subscribe` reports changes made through adapters in
this process and, when the file system can watch a directory (`nodeFileSystem()` can),
files that another process or a person changes, writes, replaces or deletes. It stays
quiet for a file that did not change and for half-written files, and the folder is
watched only while someone is subscribed.

#### JSON file storage

For small amounts of data that a person might open and edit, such as settings,
use `jsonFileAdapter` from the optional `/json-file` entry point. It keeps every
key in one JSON file. Like the file adapter, it imports no file system module:
pass `nodeFileSystem()` from `/file/node`, or your own `FileSystemLike`. Writes go
to a temporary file that is renamed over the real one; if your `FileSystemLike`
has `writeNewFile` (an exclusive create, `O_CREAT | O_EXCL`, which `nodeFileSystem`
provides), the temporary name is random and a name that already exists, a symbolic
link included, is skipped instead of written through.

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
| `jsonFileAdapter` | Settings a person may edit by hand | Rewrites the whole file on each write; one process unless `lock` is set |
| `yamlFileAdapter`, `iniFileAdapter` | Settings a person edits by hand in YAML or INI | Rewrites the whole file and drops comments; one process unless `lock` is set |
| `fileAdapter` | Many or large values | One process per directory unless `lock` is set |
| `sqliteAdapter` | Several processes writing | Needs a SQLite driver |
| `postgresAdapter`, `mysqlAdapter` | Several servers sharing one database | Needs a driver and a running server |
| `restAdapter` | Values kept behind your own HTTP API | One request per call; you provide the API |
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
write removes them. Like the other file adapters, it is safe within one process unless you pass `lock` (a lock file beside the document, `<file>.lock`, with the same options and limits as the file adapter's), which lets several processes share it.

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

See `test/adapters.test.ts` for each wrapper in use, `test/browser.test.ts` for the browser adapters (localStorage and sessionStorage), `test/indexeddb.test.ts` for the IndexedDB adapter `test/sqlite.test.ts` for the SQLite adapter, `test/postgres.test.ts`, `test/mysql.test.ts` and `test/databases.test.ts` for the PostgreSQL and MySQL adapters (set `TEST_POSTGRES_URL` and `TEST_MYSQL_URL` to also run them against real servers), `test/rest.test.ts` for the REST adapter, `test/redis.test.ts` for the Redis adapter (set `TEST_REDIS_URL` to also run it against a real server), `test/browser-real.test.ts` for the browser adapters in a real Chromium, Firefox or WebKit (run `bun run test:browser`, with `TEST_BROWSER=firefox` or `webkit` for the others), `test/supabase.test.ts` and `test/supabase-postgrest.test.ts` for the Supabase adapter (set `TEST_SUPABASE_DB_URL`, `TEST_SUPABASE_REST_URL` and `TEST_SUPABASE_JWT_SECRET` to also run it against PostgreSQL and PostgREST through the real `supabase-js`), `test/firestore.test.ts` and `test/firestore-emulator.test.ts` for the Firestore adapter (set `TEST_FIRESTORE_EMULATOR`, for example `127.0.0.1:8080`, to also run it against the Firestore emulator through both SDKs), `test/s3.test.ts` and `test/s3-server.test.ts` for the S3 adapter (set `TEST_S3_ENDPOINT`, `TEST_S3_BUCKET` and the two key variables to also run it against an S3-compatible server) and `test/file.test.ts` for the file adapter `test/json-file.test.ts` for the JSON file adapter and `test/yaml-ini-file.test.ts` for the YAML and INI adapters.

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
