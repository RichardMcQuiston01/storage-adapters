/**
 * The Realtime Database adapter against the real Realtime Database emulator, through both
 * SDKs. The default test run skips this (it uses an in-memory node, in
 * `realtime.test.ts`). Start the emulator and set its address to run it:
 *
 *   firebase emulators:start --only database
 *   TEST_RTDB_EMULATOR=127.0.0.1:9000
 *
 * Every test uses its own parent node, so nothing needs cleaning up. The SDKs are loaded
 * only when the emulator is set, so the default run (and Deno) never imports them.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';

import {
  realtimeDatabaseAdapter,
  realtimeStoreFromAdmin,
  realtimeStoreFromWebSdk,
  type RealtimeDatabaseStoreLike,
} from '../src/firebase/realtime.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;
const emulator: string | undefined = process.env.TEST_RTDB_EMULATOR;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

const freshPath = (): string => `test_${randomBytes(6).toString('hex')}`;

async function listKeys(
  adapter: StorageAdapter,
  prefix: string
): Promise<string[]> {
  if (adapter.list === undefined) {
    assert.fail('the adapter should list');
  }
  return expectOk(await adapter.list(prefix, { signal }));
}

/** Waits until `check` passes, for listeners, which answer a moment later. */
async function eventually(
  check: () => boolean,
  describeWait: string
): Promise<void> {
  const deadline: number = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${describeWait}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** The SDKs, imported only when there is an emulator to talk to. */
const loaded =
  emulator === undefined
    ? null
    : {
        adminApp: await import('firebase-admin/app'),
        adminDatabase: await import('firebase-admin/database'),
        webApp: await import('firebase/app'),
        web: await import('firebase/database'),
      };

void describe('realtimeDatabaseAdapter against the Realtime Database emulator', () => {
  if (emulator === undefined || loaded === null) {
    void it(
      'is skipped: set TEST_RTDB_EMULATOR to run it',
      { skip: true },
      () => {
        /* nothing to run */
      }
    );
    return;
  }
  const [host, port] = emulator.split(':');
  const projectId = 'demo-storage-adapters';
  const databaseURL = `https://${projectId}-default-rtdb.firebaseio.com`;
  process.env.FIREBASE_DATABASE_EMULATOR_HOST = emulator;
  const { web } = loaded;

  const adminApps: ReturnType<typeof loaded.adminApp.initializeApp>[] = [];
  const adminStore = (path: string): RealtimeDatabaseStoreLike => {
    const app = loaded.adminApp.initializeApp(
      { projectId, databaseURL },
      `admin-${randomBytes(6).toString('hex')}`
    );
    adminApps.push(app);
    return realtimeStoreFromAdmin({
      database: loaded.adminDatabase.getDatabase(app),
      path,
    });
  };
  const webApps: ReturnType<typeof loaded.webApp.initializeApp>[] = [];
  const webStore = (path: string): RealtimeDatabaseStoreLike => {
    const app = loaded.webApp.initializeApp(
      { projectId, databaseURL },
      `web-${randomBytes(6).toString('hex')}`
    );
    webApps.push(app);
    const database = web.getDatabase(app);
    web.connectDatabaseEmulator(database, host ?? '127.0.0.1', Number(port));
    return realtimeStoreFromWebSdk({ database, sdk: web, path });
  };
  after(async () => {
    for (const app of adminApps) {
      await loaded.adminApp.deleteApp(app);
    }
    for (const app of webApps) {
      await loaded.webApp.deleteApp(app);
    }
  });

  const sdks: readonly [string, (path: string) => StorageAdapter][] = [
    [
      'the Admin SDK',
      (path) => realtimeDatabaseAdapter({ store: adminStore(path) }),
    ],
    [
      'the web SDK',
      (path) => realtimeDatabaseAdapter({ store: webStore(path) }),
    ],
  ];

  for (const [name, make] of sdks) {
    runConformance(`realtimeDatabaseAdapter on the emulator through ${name}`, {
      ownWrites: 'notifies',
      create: () => {
        const path = freshPath();
        return { adapter: make(path), reopen: () => make(path) };
      },
    });

    void describe(`through ${name}`, () => {
      void it('lets exactly one of several racing writers with the same revision win', async () => {
        const path = freshPath();
        const adapters = [make(path), make(path), make(path)];
        const base = expectOk(
          await (adapters[0] as StorageAdapter).set('k', 'base', { signal })
        );
        const results = await Promise.all(
          adapters.map((adapter, index) =>
            adapter.set('k', `from ${index}`, {
              signal,
              ifRevision: base.revision ?? '',
            })
          )
        );
        assert.equal(results.filter((result) => result.ok).length, 1);
        for (const result of results) {
          if (!result.ok) {
            assert.equal(result.code, 'conflict', JSON.stringify(result));
          }
        }
        const stored = expectOk(
          await (adapters[0] as StorageAdapter).get('k', { signal })
        );
        assert.equal(stored?.revision, '2');
      });

      void it(
        'loses no update when several clients add to one counter',
        { timeout: 60_000 },
        async () => {
          const path = freshPath();
          const adapters = [make(path), make(path), make(path)];
          expectOk(
            await (adapters[0] as StorageAdapter).set('count', '0', { signal })
          );
          const bump = async (adapter: StorageAdapter): Promise<void> => {
            for (let attempt = 0; attempt < 100; attempt += 1) {
              const current = expectOk(await adapter.get('count', { signal }));
              const written = await adapter.set(
                'count',
                String(Number(current?.value ?? '0') + 1),
                { signal, ifRevision: current?.revision ?? '' }
              );
              if (written.ok) {
                return;
              }
              assert.equal(written.code, 'conflict', JSON.stringify(written));
            }
            assert.fail('could not add after 100 attempts');
          };
          await Promise.all(
            adapters.flatMap((adapter) =>
              Array.from({ length: 5 }, () => bump(adapter))
            )
          );
          const stored = expectOk(
            await (adapters[0] as StorageAdapter).get('count', { signal })
          );
          assert.equal(stored?.value, '15');
        }
      );

      void it('stores keys the database would not accept as names', async () => {
        const adapter = make(freshPath());
        const keys = [
          'a/b/c',
          '.',
          '..',
          'a.b$c#d[e]f',
          'with space',
          'é and \u{1f600}',
          '100%',
          '%2F',
          'line\nbreak',
          '0',
          '10',
          '',
        ];
        for (const key of keys) {
          expectOk(await adapter.set(key, `value of ${key}`, { signal }));
        }
        for (const key of keys) {
          assert.equal(
            expectOk(await adapter.get(key, { signal }))?.value,
            `value of ${key}`
          );
        }
        assert.deepEqual(await listKeys(adapter, ''), [...keys].sort());
      });

      void it('lists keys by prefix, astral characters included', async () => {
        const adapter = make(freshPath());
        for (const key of [
          'user:1',
          'user:2',
          'users',
          '\u{1f600}',
          '\u{1f600}x',
          '￿',
          '￿x',
        ]) {
          expectOk(await adapter.set(key, 'v', { signal }));
        }
        assert.deepEqual(await listKeys(adapter, 'user:'), [
          'user:1',
          'user:2',
        ]);
        assert.deepEqual(await listKeys(adapter, '\u{1f600}'), [
          '\u{1f600}',
          '\u{1f600}x',
        ]);
        assert.deepEqual(await listKeys(adapter, '￿'), ['￿', '￿x']);
        assert.equal((await listKeys(adapter, '')).length, 7);
      });

      void it(
        'lists more keys than one page, and stops at the end of the prefix',
        { timeout: 60_000 },
        async () => {
          const adapter = make(freshPath());
          const count = 1200;
          for (let start = 0; start < count; start += 100) {
            await Promise.all(
              Array.from({ length: 100 }, (_, offset) =>
                adapter.set(
                  `item:${String(start + offset).padStart(4, '0')}`,
                  'v',
                  { signal }
                )
              )
            );
          }
          expectOk(await adapter.set('itex', 'after', { signal }));
          expectOk(await adapter.set('ite', 'before', { signal }));
          const keys = await listKeys(adapter, 'item:');
          assert.equal(keys.length, count);
          assert.equal(new Set(keys).size, count);
          assert.deepEqual(keys, [...keys].sort());
          assert.equal((await listKeys(adapter, 'item:11')).length, 100);
          assert.deepEqual(await listKeys(adapter, 'itex'), ['itex']);
          assert.equal((await listKeys(adapter, '')).length, count + 2);
        }
      );

      void it('refuses a value over the database limit as invalid', async () => {
        const adapter = make(freshPath());
        const result = await adapter.set('big', 'x'.repeat(10_000_001), {
          signal,
        });
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.code, 'invalid');
        }
      });

      void it('tells a subscriber about a write another client made', async () => {
        const path = freshPath();
        const mine = make(path);
        const theirs = make(path);
        const heard: (StoredValue | null)[] = [];
        const stop = mine.subscribe?.('shared', (stored) => heard.push(stored));
        await pause(500);
        expectOk(await theirs.set('shared', 'one', { signal }));
        await eventually(() => heard.length >= 1, 'the first change');
        expectOk(await theirs.set('shared', 'two', { signal }));
        await eventually(() => heard.length >= 2, 'the second change');
        expectOk(
          await (theirs.remove?.('shared', { signal }) ?? Promise.reject())
        );
        await eventually(() => heard.length >= 3, 'the removal');
        stop?.();
        await pause(300);
        assert.deepEqual(heard, [
          { value: 'one', revision: '1' },
          { value: 'two', revision: '2' },
          null,
        ]);
      });

      void it('tells a subscriber about its own write once', async () => {
        const adapter = make(freshPath());
        const heard: (StoredValue | null)[] = [];
        const stop = adapter.subscribe?.('mine', (stored) =>
          heard.push(stored)
        );
        await pause(500);
        expectOk(await adapter.set('mine', 'v', { signal }));
        await pause(500);
        stop?.();
        assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
      });
    });
  }

  void it('reads nodes the two SDKs wrote, through each other', async () => {
    const path = freshPath();
    const viaAdmin = realtimeDatabaseAdapter({ store: adminStore(path) });
    const viaWeb = realtimeDatabaseAdapter({ store: webStore(path) });
    const written = expectOk(await viaAdmin.set('k', 'from admin', { signal }));
    assert.deepEqual(expectOk(await viaWeb.get('k', { signal })), written);
    expectOk(
      await viaWeb.set('k', 'from web', {
        signal,
        ifRevision: written.revision ?? '',
      })
    );
    assert.deepEqual(expectOk(await viaAdmin.get('k', { signal })), {
      value: 'from web',
      revision: '2',
    });
  });

  void it('reports forbidden when the rules refuse access', async () => {
    const path = freshPath();
    // Rules that refuse everything, set through the emulator's REST API.
    const response = await fetch(
      `http://${emulator}/.settings/rules.json?ns=${projectId}-default-rtdb`,
      {
        method: 'PUT',
        headers: { authorization: 'Bearer owner' },
        body: JSON.stringify({
          // A rule that grants access cannot be taken back lower down, so refuse at the top.
          rules: { '.read': false, '.write': false },
        }),
      }
    );
    assert.ok(response.ok, `could not set the rules: ${response.status}`);
    try {
      // The Admin SDK is not bound by rules, so only the web SDK is refused.
      const problems: string[] = [];
      const adapter = realtimeDatabaseAdapter({
        store: webStore(path),
        onWatchError: (key, message) => problems.push(`${key}: ${message}`),
      });
      for (const result of [
        await adapter.set('k', 'v', { signal }),
        await adapter.get('k', { signal }),
      ]) {
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.code, 'forbidden', JSON.stringify(result));
          assert.ok(result.error.includes('"k"'), result.error);
        }
      }
      adapter.subscribe?.('k', () => undefined);
      await eventually(() => problems.length > 0, 'the listener to be refused');
      assert.ok(problems[0]?.includes('"k"'), problems[0]);
    } finally {
      await fetch(
        `http://${emulator}/.settings/rules.json?ns=${projectId}-default-rtdb`,
        {
          method: 'PUT',
          headers: { authorization: 'Bearer owner' },
          body: JSON.stringify({
            rules: { '.read': true, '.write': true },
          }),
        }
      );
    }
  });
});
