/**
 * Loads every built entry point and round-trips a value through the adapters that
 * can run without a browser or database server. Meant for runtimes other than the
 * one the tests run on (Deno): `deno run --allow-all scripts/smoke-dist.ts`.
 * Run `bun run build` first.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as ini from 'ini';
import YAML from 'yaml';

import * as browser from '../dist/browser.js';
import * as core from '../dist/index.js';
import * as fileNode from '../dist/file-node.js';
import * as file from '../dist/file.js';
import * as couchdb from '../dist/couchdb.js';
import * as firebase from '../dist/firebase.js';
import * as firebaseRealtime from '../dist/firebase-realtime.js';
import * as iniFile from '../dist/ini-file.js';
import * as jsonFile from '../dist/json-file.js';
import * as mysql from '../dist/mysql.js';
import * as postgres from '../dist/postgres.js';
import * as react from '../dist/react.js';
import * as nats from '../dist/nats.js';
import * as redis from '../dist/redis.js';
import * as rest from '../dist/rest.js';
import * as s3 from '../dist/s3.js';
import * as sqlite from '../dist/sqlite.js';
import * as supabase from '../dist/supabase.js';
import * as yamlFile from '../dist/yaml-file.js';
import * as indexeddb from '../dist/indexeddb.js';

const signal: AbortSignal = new AbortController().signal;

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`smoke test failed: ${message}`);
  }
}

const entries: Record<string, Record<string, unknown>> = {
  core,
  browser,
  indexeddb,
  sqlite,
  postgres,
  react,
  nats,
  redis,
  rest,
  couchdb,
  firebase,
  firebaseRealtime,
  supabase,
  mysql,
  s3,
  file,
  fileNode,
  jsonFile,
  yamlFile,
  iniFile,
};
for (const [name, entry] of Object.entries(entries)) {
  check(Object.keys(entry).length > 0, `${name} exports nothing`);
}

const folder: string = mkdtempSync(join(tmpdir(), 'smoke-'));
try {
  const adapters: Record<string, core.StorageAdapter> = {
    file: file.fileAdapter({
      directory: join(folder, 'files'),
      fileSystem: fileNode.nodeFileSystem(),
    }),
    json: jsonFile.jsonFileAdapter({
      path: join(folder, 'store.json'),
      fileSystem: fileNode.nodeFileSystem(),
    }),
    yaml: yamlFile.yamlFileAdapter({
      path: join(folder, 'store.yaml'),
      fileSystem: fileNode.nodeFileSystem(),
      yaml: YAML,
    }),
    ini: iniFile.iniFileAdapter({
      path: join(folder, 'store.ini'),
      fileSystem: fileNode.nodeFileSystem(),
      ini,
    }),
  };
  for (const [name, adapter] of Object.entries(adapters)) {
    const written = await adapter.set('theme', 'dark', { signal });
    check(written.ok, `${name} set: ${JSON.stringify(written)}`);
    const read = await adapter.get('theme', { signal });
    check(
      read.ok && read.value?.value === 'dark',
      `${name} get: ${JSON.stringify(read)}`
    );
    const conflict = await adapter.set('theme', 'light', {
      signal,
      ifRevision: 'not-a-revision',
    });
    check(
      !conflict.ok && conflict.code === 'conflict',
      `${name} conflict: ${JSON.stringify(conflict)}`
    );
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}

console.log(
  `smoke test passed on ${'Deno' in globalThis ? 'Deno' : 'this runtime'}`
);
