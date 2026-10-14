import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as ini from 'ini';
import YAML from 'yaml';
import { IDBFactory } from 'fake-indexeddb';

import {
  localStorageAdapter,
  sessionStorageAdapter,
  type WebStorageLike,
} from '../src/browser/index.js';
import { fileAdapter } from '../src/file/index.js';
import { nodeFileSystem } from '../src/file/node.js';
import {
  indexedDbAdapter,
  type IdbFactoryLike,
} from '../src/indexeddb/index.js';
import { iniFileAdapter } from '../src/ini-file/index.js';
import { jsonFileAdapter } from '../src/json-file/index.js';
import { sqliteAdapter } from '../src/sqlite/index.js';
import { memoryAdapter } from '../src/storage.js';
import { yamlFileAdapter } from '../src/yaml-file/index.js';
import {
  runConformance,
  type ConformanceSubject,
} from './support/conformance.js';

function fakeStorage(): WebStorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
  };
}

/** A subject whose adapters live in a fresh temporary folder, removed afterwards. */
function inTemporaryFolder(
  make: (folder: string) => ReturnType<typeof fileAdapter>
): ConformanceSubject {
  const folder: string = mkdtempSync(join(tmpdir(), 'conformance-'));
  return {
    adapter: make(folder),
    reopen: () => make(folder),
    cleanup: () => rmSync(folder, { recursive: true, force: true }),
  };
}

runConformance('memoryAdapter', {
  ownWrites: 'notifies',
  create: () => ({ adapter: memoryAdapter() }),
});

runConformance('localStorageAdapter', {
  ownWrites: 'silent',
  create: () => {
    const storage = fakeStorage();
    return {
      adapter: localStorageAdapter({ storage }),
      reopen: () => localStorageAdapter({ storage }),
    };
  },
});

runConformance('sessionStorageAdapter', {
  ownWrites: 'silent',
  create: () => {
    const storage = fakeStorage();
    return {
      adapter: sessionStorageAdapter({ storage }),
      reopen: () => sessionStorageAdapter({ storage }),
    };
  },
});

runConformance('indexedDbAdapter', {
  ownWrites: 'silent',
  create: () => {
    const factory = new IDBFactory() as unknown as IdbFactoryLike;
    return {
      adapter: indexedDbAdapter({ factory }),
      reopen: () => indexedDbAdapter({ factory }),
    };
  },
});

runConformance('sqliteAdapter', {
  ownWrites: 'notifies',
  create: () => {
    const database = new DatabaseSync(':memory:');
    return {
      adapter: sqliteAdapter({ database }),
      reopen: () => sqliteAdapter({ database }),
      cleanup: () => database.close(),
    };
  },
});

runConformance('fileAdapter', {
  ownWrites: 'notifies',
  create: () =>
    inTemporaryFolder((directory) =>
      fileAdapter({ directory, fileSystem: nodeFileSystem() })
    ),
});

runConformance('jsonFileAdapter', {
  ownWrites: 'notifies',
  create: () =>
    inTemporaryFolder((folder) =>
      jsonFileAdapter({
        path: join(folder, 'store.json'),
        fileSystem: nodeFileSystem(),
      })
    ),
});

runConformance('yamlFileAdapter', {
  ownWrites: 'notifies',
  create: () =>
    inTemporaryFolder((folder) =>
      yamlFileAdapter({
        path: join(folder, 'store.yaml'),
        fileSystem: nodeFileSystem(),
        yaml: YAML,
      })
    ),
});

runConformance('iniFileAdapter', {
  ownWrites: 'notifies',
  create: () =>
    inTemporaryFolder((folder) =>
      iniFileAdapter({
        path: join(folder, 'store.ini'),
        fileSystem: nodeFileSystem(),
        ini,
      })
    ),
});
