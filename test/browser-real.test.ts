/**
 * The browser adapters in a real browser. The other browser tests run against fakes
 * (`fake-indexeddb`, a Map standing in for Web Storage); this file runs the real
 * `dist/browser.js` and `dist/indexeddb.js` in Chromium, Firefox or WebKit, where
 * storage events cross tabs, quotas are real, a sandboxed frame really cannot reach
 * storage, and IndexedDB transactions really race. It is skipped unless you ask for it:
 *
 *   bun run build
 *   TEST_BROWSER=chromium bun test test/browser-real.test.ts   # or firefox, or webkit
 *
 * `playwright-core` is pinned exactly, so `bunx playwright-core install <engine>` fetches
 * the same browser build in CI and on a laptop. Set `TEST_BROWSER_PATH` to use a browser
 * that is installed somewhere else.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';

import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import {
  isEngine,
  remoteAdapter,
  startHarness,
  type AdapterSpec,
  type Engine,
  type Harness,
} from './support/browser-harness.js';

const signal: AbortSignal = new AbortController().signal;
const requested: string | undefined = process.env.TEST_BROWSER;
if (requested !== undefined && requested !== '' && !isEngine(requested)) {
  throw new Error(
    `TEST_BROWSER is "${requested}", but it must be chromium, firefox or webkit`
  );
}
const engine: Engine | null = isEngine(requested) ? requested : null;
const harness: Harness | null =
  engine === null
    ? null
    : await startHarness(engine, process.env.TEST_BROWSER_PATH);
/** What the tests call the browser, for their names. */
const label: string = engine ?? 'a browser';
if (harness !== null) {
  after(async () => {
    await harness.close();
  });
}

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

function expectFailure<T>(result: StoreResult<T>, code: string): string {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code, result.error);
  return result.error;
}

/** Waits until `check` passes: storage events and broadcasts arrive a moment later. */
async function eventually(
  check: () => boolean,
  describeWait: string
): Promise<void> {
  const deadline: number = Date.now() + 3000; // inside the 5 s test timeout
  while (!check()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${describeWait}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const freshDatabase = (): string => `test-${randomBytes(6).toString('hex')}`;

/* One profile and one page run the whole conformance suite. */
const sharedContext = harness === null ? null : await harness.newContext();
const sharedPage =
  harness === null || sharedContext === null
    ? null
    : await harness.openPage(sharedContext);

void describe(`the browser adapters in ${label}`, () => {
  if (harness === null || sharedPage === null) {
    void it(
      'is skipped: build the package and set TEST_BROWSER=chromium, firefox or webkit to run it',
      { skip: true },
      () => {
        /* nothing to run */
      }
    );
    return;
  }
  const browser: Harness = harness;
  const page = sharedPage;
  const makeConformance = (
    name: string,
    spec: () => AdapterSpec,
    clear: boolean
  ): void => {
    runConformance(name, {
      ownWrites: 'silent',
      create: async () => {
        if (clear) {
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
          });
        }
        const chosen = spec();
        const created: (StorageAdapter & { dispose(): Promise<void> })[] = [];
        const make = (): StorageAdapter => {
          const adapter = remoteAdapter(page, chosen);
          created.push(adapter);
          return adapter;
        };
        return {
          adapter: make(),
          reopen: make,
          cleanup: async () => {
            await Promise.all(created.map((adapter) => adapter.dispose()));
          },
        };
      },
    });
  };
  makeConformance(
    `localStorageAdapter in ${label}`,
    () => ({ kind: 'local' }),
    true
  );
  makeConformance(
    `sessionStorageAdapter in ${label}`,
    () => ({ kind: 'session' }),
    true
  );
  makeConformance(
    `indexedDbAdapter in ${label}`,
    () => ({ kind: 'idb', database: freshDatabase() }),
    false
  );

  void describe('Web Storage', () => {
    void it('tells another tab about a change, through a real storage event', async () => {
      const profile = await browser.newContext();
      const tabA = await browser.openPage(profile);
      const tabB = await browser.openPage(profile);
      const a = remoteAdapter(tabA, { kind: 'local' });
      const b = remoteAdapter(tabB, { kind: 'local' });
      const heardByA: (StoredValue | null)[] = [];
      const heardByB: (StoredValue | null)[] = [];
      const stopA = a.subscribe?.('theme', (stored) => heardByA.push(stored));
      const stopB = b.subscribe?.('theme', (stored) => heardByB.push(stored));
      await a.get('theme', { signal }); // the subscriptions are in place
      await b.get('theme', { signal });

      expectOk(await b.set('theme', 'dark', { signal }));
      await eventually(() => heardByA.length >= 1, 'tab A to hear the write');
      expectOk(await b.set('theme', 'light', { signal }));
      await eventually(() => heardByA.length >= 2, 'tab A to hear the rewrite');
      assert.ok(b.remove !== undefined);
      expectOk(await b.remove('theme', { signal }));
      await eventually(() => heardByA.length >= 3, 'tab A to hear the removal');

      assert.deepEqual(heardByA, [
        { value: 'dark', revision: '1' },
        { value: 'light', revision: '2' },
        null,
      ]);
      // A browser never sends a storage event to the document that made the change.
      assert.deepEqual(heardByB, []);
      // And the other tab does not need the event to read what was written.
      expectOk(await a.set('theme', 'sepia', { signal }));
      assert.deepEqual(expectOk(await b.get('theme', { signal })), {
        value: 'sepia',
        revision: '1',
      });
      stopA?.();
      stopB?.();
      await profile.close();
    });

    void it('shares sessionStorage with a frame of the same tab, not with another tab', async () => {
      const profile = await browser.newContext();
      const top = await browser.openPage(profile);
      const otherTab = await browser.openPage(profile);
      await top.evaluate(() =>
        (
          globalThis as unknown as { addFrame(src: string): Promise<void> }
        ).addFrame('/frame')
      );
      const inner = top.frames().find((frame) => frame !== top.mainFrame());
      assert.ok(inner !== undefined, 'the iframe should have loaded');
      await inner.waitForFunction(
        () =>
          (globalThis as unknown as { libReady?: boolean }).libReady === true
      );
      const fromTop = remoteAdapter(top, { kind: 'session' });
      const fromFrame = remoteAdapter(inner, { kind: 'session' });
      const fromOtherTab = remoteAdapter(otherTab, { kind: 'session' });
      const heard: (StoredValue | null)[] = [];
      fromTop.subscribe?.('draft', (stored) => heard.push(stored));
      await fromTop.get('draft', { signal });

      expectOk(await fromFrame.set('draft', 'hello', { signal }));
      await eventually(
        () => heard.length >= 1,
        'the top document to hear the frame'
      );
      assert.deepEqual(heard, [{ value: 'hello', revision: '1' }]);
      assert.deepEqual(expectOk(await fromTop.get('draft', { signal })), {
        value: 'hello',
        revision: '1',
      });
      assert.equal(expectOk(await fromOtherTab.get('draft', { signal })), null);
      await profile.close();
    });

    void it('cannot reach storage from a sandboxed frame, and says so without throwing', async () => {
      const profile = await browser.newContext();
      const sandboxed = await profile.newPage();
      await sandboxed.goto(`${browser.origin}/sandbox`);
      await sandboxed.waitForFunction(
        () =>
          (globalThis as unknown as { sandboxResult?: unknown })
            .sandboxResult !== undefined,
        undefined,
        { timeout: 10_000 }
      );
      const outcome = (await sandboxed.evaluate(
        () =>
          (globalThis as unknown as { sandboxResult: unknown }).sandboxResult
      )) as {
        failure?: string;
        result?: { ok: boolean; code?: string; error?: string };
      };
      assert.equal(outcome.failure, undefined, outcome.failure);
      assert.equal(outcome.result?.ok, false);
      assert.ok(
        ['forbidden', 'unavailable'].includes(outcome.result?.code ?? ''),
        JSON.stringify(outcome.result)
      );
      assert.match(outcome.result?.error ?? '', /localStorage/);
      assert.match(outcome.result?.error ?? '', /"k"/);
      await profile.close();
    });

    void it('reports a full localStorage as quota and keeps working afterwards', async () => {
      const profile = await browser.newContext();
      const tab = await browser.openPage(profile);
      const adapter = remoteAdapter(tab, { kind: 'local' });
      expectOk(await adapter.set('small', 'before', { signal }));
      const message = expectFailure(
        await adapter.set('huge', 'x'.repeat(8_000_000), { signal }),
        'quota'
      );
      assert.match(message, /"huge"/);
      assert.equal(expectOk(await adapter.get('huge', { signal })), null);
      assert.equal(
        expectOk(await adapter.get('small', { signal }))?.value,
        'before'
      );
      expectOk(await adapter.set('small', 'after', { signal }));
      await profile.close();
    });

    void it('keeps what it wrote when the page reloads', async () => {
      const profile = await browser.newContext();
      const tab = await browser.openPage(profile);
      const before = remoteAdapter(tab, { kind: 'local' });
      const written = expectOk(await before.set('theme', 'dark', { signal }));
      await tab.reload();
      await tab.waitForFunction(
        () =>
          (globalThis as unknown as { libReady?: boolean }).libReady === true
      );
      const after = remoteAdapter(tab, { kind: 'local' });
      assert.deepEqual(expectOk(await after.get('theme', { signal })), written);
      await profile.close();
    });
  });

  void describe('IndexedDB', () => {
    void it('lets exactly one of several tabs holding the same revision win', async () => {
      const profile = await browser.newContext();
      const database = freshDatabase();
      const tabs = await Promise.all([
        browser.openPage(profile),
        browser.openPage(profile),
        browser.openPage(profile),
      ]);
      const adapters = tabs.map((tab) =>
        remoteAdapter(tab, { kind: 'idb', database })
      );
      const base = expectOk(
        await (adapters[0] as StorageAdapter).set('race', 'start', { signal })
      );
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          (adapters[index % adapters.length] as StorageAdapter).set(
            'race',
            `writer-${index}`,
            { signal, ifRevision: base.revision ?? '' }
          )
        )
      );
      assert.equal(results.filter((result) => result.ok).length, 1);
      for (const result of results) {
        if (!result.ok) {
          assert.equal(result.code, 'conflict', result.error);
        }
      }
      await profile.close();
    });

    void it('loses no update when several tabs add to one counter', async () => {
      const profile = await browser.newContext();
      const database = freshDatabase();
      const tabs = await Promise.all([
        browser.openPage(profile),
        browser.openPage(profile),
        browser.openPage(profile),
      ]);
      const adapters = tabs.map((tab) =>
        remoteAdapter(tab, { kind: 'idb', database })
      );
      expectOk(
        await (adapters[0] as StorageAdapter).set('count', '0', { signal })
      );
      const bump = async (adapter: StorageAdapter): Promise<void> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const current = expectOk(await adapter.get('count', { signal }));
          const written = await adapter.set(
            'count',
            String(Number(current?.value ?? '0') + 1),
            { signal, ifRevision: current?.revision ?? '' }
          );
          if (written.ok) {
            return;
          }
          assert.equal(written.code, 'conflict', written.error);
        }
        assert.fail('could not add after 200 attempts');
      };
      await Promise.all(
        adapters.flatMap((adapter) =>
          Array.from({ length: 10 }, () => bump(adapter))
        )
      );
      assert.equal(
        expectOk(await (adapters[0] as StorageAdapter).get('count', { signal }))
          ?.value,
        '30'
      );
      await profile.close();
    });

    void it('tells another tab about a change, through a real BroadcastChannel', async () => {
      const profile = await browser.newContext();
      const database = freshDatabase();
      const tabA = await browser.openPage(profile);
      const tabB = await browser.openPage(profile);
      const a = remoteAdapter(tabA, { kind: 'idb', database });
      const b = remoteAdapter(tabB, { kind: 'idb', database });
      const heard: (StoredValue | null)[] = [];
      a.subscribe?.('theme', (stored) => heard.push(stored));
      await a.get('theme', { signal });
      await b.get('theme', { signal });

      const written = expectOk(await b.set('theme', 'dark', { signal }));
      await eventually(() => heard.length >= 1, 'tab A to hear the write');
      assert.ok(b.remove !== undefined);
      expectOk(await b.remove('theme', { signal }));
      await eventually(() => heard.length >= 2, 'tab A to hear the removal');
      assert.deepEqual(heard, [written, null]);
      await profile.close();
    });

    void it('keeps working when another tab deletes the database under it', async () => {
      const profile = await browser.newContext();
      const database = freshDatabase();
      const tabA = await browser.openPage(profile);
      const tabB = await browser.openPage(profile);
      const a = remoteAdapter(tabA, { kind: 'idb', database });
      expectOk(await a.set('k', 'v', { signal }));
      // The delete waits for tab A to close its connection; the adapter closes on
      // `versionchange`, so this finishes instead of hanging.
      const deleted = await tabB.evaluate(
        (name) =>
          new Promise<string>((resolve) => {
            const request = (
              globalThis as unknown as {
                indexedDB: {
                  deleteDatabase(name: string): {
                    onsuccess: (() => void) | null;
                    onerror: (() => void) | null;
                    onblocked: (() => void) | null;
                  };
                };
              }
            ).indexedDB.deleteDatabase(name);
            request.onsuccess = (): void => resolve('deleted');
            request.onerror = (): void => resolve('failed');
            request.onblocked = (): void => {
              // Blocked until the other connection closes; keep waiting for success.
            };
          }),
        database
      );
      assert.equal(deleted, 'deleted');
      assert.equal(expectOk(await a.get('k', { signal })), null);
      assert.deepEqual(expectOk(await a.set('k', 'again', { signal })), {
        value: 'again',
        revision: '1',
      });
      await profile.close();
    });

    void it('keeps what it wrote when the page reloads', async () => {
      const profile = await browser.newContext();
      const database = freshDatabase();
      const tab = await browser.openPage(profile);
      const before = remoteAdapter(tab, { kind: 'idb', database });
      const written = expectOk(await before.set('theme', 'dark', { signal }));
      await tab.reload();
      await tab.waitForFunction(
        () =>
          (globalThis as unknown as { libReady?: boolean }).libReady === true
      );
      const after = remoteAdapter(tab, { kind: 'idb', database });
      assert.deepEqual(expectOk(await after.get('theme', { signal })), written);
      await profile.close();
    });

    void it(
      'stores a large value and many keys, and lists them',
      { timeout: 60_000 },
      async () => {
        const profile = await browser.newContext();
        const tab = await browser.openPage(profile);
        const adapter = remoteAdapter(tab, {
          kind: 'idb',
          database: freshDatabase(),
        });
        const big = 'x\u{1f600}é'.repeat(1_000_000);
        expectOk(await adapter.set('big', big, { signal }));
        assert.equal(
          expectOk(await adapter.get('big', { signal }))?.value,
          big
        );
        for (let batch = 0; batch < 10; batch += 1) {
          await Promise.all(
            Array.from({ length: 100 }, (_, index) =>
              adapter.set(
                `key:${String(batch * 100 + index).padStart(4, '0')}`,
                'v',
                {
                  signal,
                }
              )
            )
          );
        }
        assert.ok(adapter.list !== undefined);
        const keys = expectOk(await adapter.list('key:', { signal }));
        assert.equal(keys.length, 1000);
        assert.equal(keys[0], 'key:0000');
        assert.equal(keys.at(-1), 'key:0999');
        assert.deepEqual(expectOk(await adapter.list('big', { signal })), [
          'big',
        ]);
        await profile.close();
      }
    );
  });
});
