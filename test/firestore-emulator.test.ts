/**
 * The Firestore adapter against the real Firestore emulator, through both SDKs. The
 * default test run skips this (it uses an in-memory collection, in
 * `firestore.test.ts`). Start the emulator and set its address to run it:
 *
 *   firebase emulators:start --only firestore
 *   TEST_FIRESTORE_EMULATOR=127.0.0.1:8085
 *
 * Every test uses its own collection, so nothing needs cleaning up. The SDKs are
 * loaded only when the emulator is set, so the default run (and Deno) never
 * imports them.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';

import type { Firestore } from '@google-cloud/firestore';
import type { Firestore as WebFirestore } from 'firebase/firestore';

import {
  firestoreAdapter,
  firestoreStoreFromAdmin,
  firestoreStoreFromWebSdk,
  type FirestoreStoreLike,
} from '../src/firebase/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;
const emulator: string | undefined = process.env.TEST_FIRESTORE_EMULATOR;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

const freshCollection = (): string => `test_${randomBytes(6).toString('hex')}`;

/** Waits until `check` passes, for snapshot listeners, which answer a moment later. */
async function eventually(
  check: () => boolean,
  describeWait: string
): Promise<void> {
  const deadline: number = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${describeWait}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The SDKs, imported only when there is an emulator to talk to. */
const loaded =
  emulator === undefined
    ? null
    : {
        admin: await import('@google-cloud/firestore'),
        web: await import('firebase/firestore'),
        app: await import('firebase/app'),
      };

void describe('firestoreAdapter against the Firestore emulator', () => {
  if (emulator === undefined || loaded === null) {
    void it(
      'is skipped: set TEST_FIRESTORE_EMULATOR to run it',
      { skip: true },
      () => {
        /* nothing to run */
      }
    );
    return;
  }
  const [host, port] = emulator.split(':');
  const projectId = 'demo-storage-adapters';
  process.env.FIRESTORE_EMULATOR_HOST = emulator;
  const { admin, web } = loaded;
  const { initializeApp, deleteApp } = loaded.app;

  const adminClients: Firestore[] = [];
  const adminFirestore = (): Firestore => {
    const client = new admin.Firestore({ projectId });
    adminClients.push(client);
    return client;
  };
  const webApps: Awaited<ReturnType<typeof initializeApp>>[] = [];
  const webFirestore = (): WebFirestore => {
    const app = initializeApp(
      { projectId },
      `test-${randomBytes(6).toString('hex')}`
    );
    webApps.push(app);
    const client = web.getFirestore(app);
    web.connectFirestoreEmulator(client, host ?? '127.0.0.1', Number(port));
    return client;
  };
  after(async () => {
    for (const client of adminClients) {
      await client.terminate();
    }
    for (const app of webApps) {
      await deleteApp(app);
    }
  });

  const adminStore = (
    firestore: Firestore,
    collection: string
  ): FirestoreStoreLike =>
    firestoreStoreFromAdmin({
      firestore,
      collection,
    });
  const webStore = (
    firestore: WebFirestore,
    collection: string
  ): FirestoreStoreLike =>
    firestoreStoreFromWebSdk({
      firestore,
      sdk: web,
      collection,
    });

  const sdks: readonly [string, (collection: string) => StorageAdapter][] = [
    [
      'the Admin SDK',
      (collection) =>
        firestoreAdapter({
          store: adminStore(adminFirestore(), collection),
        }),
    ],
    [
      'the web SDK',
      (collection) =>
        firestoreAdapter({
          store: webStore(webFirestore(), collection),
        }),
    ],
  ];

  for (const [name, make] of sdks) {
    runConformance(`firestoreAdapter on the emulator through ${name}`, {
      ownWrites: 'notifies',
      create: () => {
        const collection = freshCollection();
        return {
          adapter: make(collection),
          reopen: () => make(collection),
        };
      },
    });

    void describe(`through ${name}`, () => {
      void it('lets exactly one of several racing writers with the same revision win', async () => {
        const collection = freshCollection();
        const adapters = [make(collection), make(collection), make(collection)];
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

      // Firestore locks a document a transaction has read, so writers queue up
      // and the SDKs retry the ones it aborts; this takes a few seconds.
      void it(
        'loses no update when several clients add to one counter',
        { timeout: 60_000 },
        async () => {
          const collection = freshCollection();
          const adapters = [
            make(collection),
            make(collection),
            make(collection),
          ];
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

      void it('stores keys that Firestore would not accept as document ids', async () => {
        const adapter = make(freshCollection());
        const keys = [
          'a/b/c',
          '.',
          '..',
          '__name__',
          'with space',
          'é and \u{1f600}',
          '100%',
          'a.b_c',
        ];
        for (const key of keys) {
          expectOk(await adapter.set(key, `value of ${key}`, { signal }));
        }
        for (const key of keys) {
          assert.deepEqual(
            expectOk(await adapter.get(key, { signal }))?.value,
            `value of ${key}`
          );
        }
        assert.deepEqual(
          expectOk(await (adapter.list?.('', { signal }) ?? Promise.reject())),
          [...keys].sort()
        );
      });

      void it('lists keys by prefix in code point order, astral characters included', async () => {
        const adapter = make(freshCollection());
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
        const list = async (prefix: string): Promise<string[]> =>
          expectOk(
            await (adapter.list?.(prefix, { signal }) ?? Promise.reject())
          );
        assert.deepEqual(await list('user:'), ['user:1', 'user:2']);
        assert.deepEqual(await list('\u{1f600}'), ['\u{1f600}', '\u{1f600}x']);
        assert.deepEqual(await list('￿'), ['￿', '￿x']);
        assert.equal((await list('')).length, 7);
      });

      void it('tells a subscriber about a write another client made', async () => {
        const collection = freshCollection();
        const mine = make(collection);
        const theirs = make(collection);
        const heard: (StoredValue | null)[] = [];
        const stop = mine.subscribe?.('shared', (stored) => heard.push(stored));
        // Give the listener time to deliver its first snapshot before the change.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expectOk(await theirs.set('shared', 'one', { signal }));
        await eventually(() => heard.length >= 1, 'the first change');
        expectOk(await theirs.set('shared', 'two', { signal }));
        await eventually(() => heard.length >= 2, 'the second change');
        expectOk(
          await (theirs.remove?.('shared', { signal }) ?? Promise.reject())
        );
        await eventually(() => heard.length >= 3, 'the removal');
        stop?.();
        // Give a stray duplicate time to show up.
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(heard, [
          { value: 'one', revision: '1' },
          { value: 'two', revision: '2' },
          null,
        ]);
      });

      void it('tells a subscriber about its own write once', async () => {
        const adapter = make(freshCollection());
        const heard: (StoredValue | null)[] = [];
        const stop = adapter.subscribe?.('mine', (stored) =>
          heard.push(stored)
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        expectOk(await adapter.set('mine', 'v', { signal }));
        await new Promise((resolve) => setTimeout(resolve, 500));
        stop?.();
        assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
      });
    });
  }

  void it('reads documents the two SDKs wrote, through each other', async () => {
    const collection = freshCollection();
    const viaAdmin = firestoreAdapter({
      store: adminStore(adminFirestore(), collection),
    });
    const viaWeb = firestoreAdapter({
      store: webStore(webFirestore(), collection),
    });
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
});
