/**
 * The contract every `StorageAdapter` must keep, as one set of tests. Each backend's
 * test file passes in a way to make a fresh adapter; behaviour that only some
 * backends have (reopening, change notices) is switched on by `capabilities`.
 * Nothing here assumes how a revision is built, only that it is a string.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../../src/storage.js';

/** One adapter under test, and how to throw its storage away afterwards. */
export interface ConformanceSubject {
  readonly adapter: StorageAdapter;
  /**
   * Makes a second adapter over the same storage, as a restart would. Leave out
   * for storage that does not outlive its adapter.
   */
  readonly reopen?: () => StorageAdapter;
  /** Frees what the subject holds (temporary folders, open databases). */
  readonly cleanup?: () => void | Promise<void>;
}

export interface ConformanceOptions {
  /** Makes a fresh, empty subject. Called once per test. */
  readonly create: () => ConformanceSubject | Promise<ConformanceSubject>;
  /**
   * Says what a write made through this adapter does to its own subscribers.
   * `'notifies'` means they hear about it; `'silent'` means only changes made
   * elsewhere (another tab) are reported, as with Web Storage events.
   */
  readonly ownWrites: 'notifies' | 'silent';
}

const signal: AbortSignal = new AbortController().signal;

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

function expectFailure<T>(
  result: StoreResult<T>,
  code: string,
  key: string
): void {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  assert.ok(
    result.error.includes(`"${key}"`),
    `error should name the key: ${result.error}`
  );
}

function revisionOf(stored: StoredValue | null): string {
  assert.ok(stored !== null, 'expected a stored value');
  assert.equal(typeof stored.revision, 'string', 'revision should be a string');
  return stored.revision as string;
}

/** Runs `body` with a fresh subject, always cleaning up. */
async function withSubject(
  options: ConformanceOptions,
  body: (subject: ConformanceSubject) => Promise<void>
): Promise<void> {
  const subject: ConformanceSubject = await options.create();
  try {
    await body(subject);
  } finally {
    await subject.cleanup?.();
  }
}

export function runConformance(
  name: string,
  options: ConformanceOptions
): void {
  const test = (
    title: string,
    body: (subject: ConformanceSubject) => Promise<void>
  ): void => {
    void it(title, () => withSubject(options, body));
  };

  void describe(`${name} meets the adapter contract`, () => {
    void describe('get', () => {
      test('returns null for a key that was never written', async ({
        adapter,
      }) => {
        assert.deepEqual(await adapter.get('missing', { signal }), {
          ok: true,
          value: null,
        });
      });

      test('returns what was written, with the same revision set gave', async ({
        adapter,
      }) => {
        const written = expectOk(
          await adapter.set('theme', 'dark', { signal })
        );
        assert.equal(written.value, 'dark');
        revisionOf(written);
        assert.deepEqual(await adapter.get('theme', { signal }), {
          ok: true,
          value: written,
        });
      });

      test('keeps keys apart from each other', async ({ adapter }) => {
        await adapter.set('first', 'one', { signal });
        await adapter.set('second', 'two', { signal });
        assert.equal(
          expectOk(await adapter.get('first', { signal }))?.value,
          'one'
        );
        assert.equal(
          expectOk(await adapter.get('second', { signal }))?.value,
          'two'
        );
        assert.equal(expectOk(await adapter.get('third', { signal })), null);
      });

      test('does not confuse a key with a longer key that starts with it', async ({
        adapter,
      }) => {
        await adapter.set('theme-dark', 'a', { signal });
        assert.equal(expectOk(await adapter.get('theme', { signal })), null);
      });
    });

    void describe('set', () => {
      test('replaces an earlier value', async ({ adapter }) => {
        await adapter.set('theme', 'dark', { signal });
        await adapter.set('theme', 'light', { signal });
        assert.equal(
          expectOk(await adapter.get('theme', { signal }))?.value,
          'light'
        );
      });

      test('gives a new revision when the value changes', async ({
        adapter,
      }) => {
        const first = expectOk(await adapter.set('theme', 'dark', { signal }));
        const second = expectOk(
          await adapter.set('theme', 'light', { signal })
        );
        assert.notEqual(revisionOf(first), revisionOf(second));
      });

      test('stores an empty string and tells it apart from nothing', async ({
        adapter,
      }) => {
        expectOk(await adapter.set('empty', '', { signal }));
        const stored = expectOk(await adapter.get('empty', { signal }));
        assert.ok(stored !== null, 'an empty string is still a value');
        assert.equal(stored.value, '');
      });

      test('stores non-ASCII text unchanged', async ({ adapter }) => {
        const text = 'café 日本語 😀';
        expectOk(await adapter.set('unicode', text, { signal }));
        assert.equal(
          expectOk(await adapter.get('unicode', { signal }))?.value,
          text
        );
      });

      test('stores a long value unchanged', async ({ adapter }) => {
        const text = 'x'.repeat(50000);
        expectOk(await adapter.set('long', text, { signal }));
        assert.equal(
          expectOk(await adapter.get('long', { signal }))?.value,
          text
        );
      });
    });

    void describe('ifRevision', () => {
      test('accepts the current revision', async ({ adapter }) => {
        const first = expectOk(await adapter.set('theme', 'dark', { signal }));
        const second = expectOk(
          await adapter.set('theme', 'light', {
            signal,
            ifRevision: revisionOf(first),
          })
        );
        assert.equal(second.value, 'light');
      });

      test('refuses an old revision, names the key and keeps the newer value', async ({
        adapter,
      }) => {
        const first = expectOk(await adapter.set('theme', 'dark', { signal }));
        expectOk(await adapter.set('theme', 'light', { signal }));
        expectFailure(
          await adapter.set('theme', 'blue', {
            signal,
            ifRevision: revisionOf(first),
          }),
          'conflict',
          'theme'
        );
        assert.equal(
          expectOk(await adapter.get('theme', { signal }))?.value,
          'light'
        );
      });

      test('refuses a revision that never existed', async ({ adapter }) => {
        await adapter.set('theme', 'dark', { signal });
        expectFailure(
          await adapter.set('theme', 'light', {
            signal,
            ifRevision: 'not-a-revision',
          }),
          'conflict',
          'theme'
        );
      });

      test('lets only one of several writers holding the same revision win', async ({
        adapter,
      }) => {
        const first = expectOk(await adapter.set('race', 'start', { signal }));
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            adapter.set('race', `writer-${index}`, {
              signal,
              ifRevision: revisionOf(first),
            })
          )
        );
        const winners = results.filter((result) => result.ok);
        assert.equal(winners.length, 1, JSON.stringify(results));
        for (const result of results) {
          if (!result.ok) {
            assert.equal(result.code, 'conflict');
          }
        }
        const kept = expectOk(await adapter.get('race', { signal }));
        assert.equal(
          kept?.value,
          expectOk(winners[0] as StoreResult<StoredValue>).value
        );
      });

      test('keeps every write when different keys are written at once', async ({
        adapter,
      }) => {
        const keys = Array.from({ length: 12 }, (_, index) => `key-${index}`);
        const results = await Promise.all(
          keys.map((key) => adapter.set(key, `value-${key}`, { signal }))
        );
        for (const result of results) {
          expectOk(result);
        }
        for (const key of keys) {
          assert.equal(
            expectOk(await adapter.get(key, { signal }))?.value,
            `value-${key}`
          );
        }
      });
    });

    void describe('remove', () => {
      test('deletes a value so get returns null again', async ({ adapter }) => {
        assert.ok(
          adapter.remove !== undefined,
          'adapter should implement remove'
        );
        await adapter.set('theme', 'dark', { signal });
        assert.deepEqual(await adapter.remove('theme', { signal }), {
          ok: true,
          value: null,
        });
        assert.equal(expectOk(await adapter.get('theme', { signal })), null);
      });

      test('succeeds for a key that is not there', async ({ adapter }) => {
        assert.ok(
          adapter.remove !== undefined,
          'adapter should implement remove'
        );
        assert.deepEqual(await adapter.remove('missing', { signal }), {
          ok: true,
          value: null,
        });
      });

      test('leaves other keys alone', async ({ adapter }) => {
        assert.ok(
          adapter.remove !== undefined,
          'adapter should implement remove'
        );
        await adapter.set('keep', 'yes', { signal });
        await adapter.set('drop', 'no', { signal });
        await adapter.remove('drop', { signal });
        assert.equal(
          expectOk(await adapter.get('keep', { signal }))?.value,
          'yes'
        );
      });

      test('lets the key be written again afterwards', async ({ adapter }) => {
        assert.ok(
          adapter.remove !== undefined,
          'adapter should implement remove'
        );
        await adapter.set('theme', 'dark', { signal });
        await adapter.remove('theme', { signal });
        expectOk(await adapter.set('theme', 'light', { signal }));
        assert.equal(
          expectOk(await adapter.get('theme', { signal }))?.value,
          'light'
        );
      });
    });

    void describe('abort', () => {
      test('get returns unavailable and names the key', async ({ adapter }) => {
        expectFailure(
          await adapter.get('theme', { signal: aborted() }),
          'unavailable',
          'theme'
        );
      });

      test('set returns unavailable without writing', async ({ adapter }) => {
        expectFailure(
          await adapter.set('theme', 'dark', { signal: aborted() }),
          'unavailable',
          'theme'
        );
        assert.equal(expectOk(await adapter.get('theme', { signal })), null);
      });

      test('remove returns unavailable without deleting', async ({
        adapter,
      }) => {
        assert.ok(
          adapter.remove !== undefined,
          'adapter should implement remove'
        );
        await adapter.set('theme', 'dark', { signal });
        expectFailure(
          await adapter.remove('theme', { signal: aborted() }),
          'unavailable',
          'theme'
        );
        assert.equal(
          expectOk(await adapter.get('theme', { signal }))?.value,
          'dark'
        );
      });
    });

    void describe('never throws', () => {
      test('every call returns a result, even for an odd key', async ({
        adapter,
      }) => {
        // A key may be refused (`invalid`) but must never make a call throw.
        for (const key of ['', ' ', 'a/b', '../up', 'A', 'z'.repeat(300)]) {
          const written = await adapter.set(key, 'v', { signal });
          const read = await adapter.get(key, { signal });
          assert.equal(typeof written.ok, 'boolean');
          assert.equal(typeof read.ok, 'boolean');
          if (written.ok) {
            assert.equal(read.ok && read.value?.value, 'v', `key ${key}`);
          } else {
            assert.ok(written.error.length > 0);
          }
        }
      });
    });

    void describe('subscribe', () => {
      test('returns a function that can be called twice without harm', async ({
        adapter,
      }) => {
        assert.ok(
          adapter.subscribe !== undefined,
          'adapter should implement subscribe'
        );
        const unsubscribe = adapter.subscribe('theme', () => undefined);
        assert.equal(typeof unsubscribe, 'function');
        unsubscribe();
        unsubscribe();
      });

      test('says nothing after unsubscribe', async ({ adapter }) => {
        assert.ok(
          adapter.subscribe !== undefined,
          'adapter should implement subscribe'
        );
        const seen: (StoredValue | null)[] = [];
        const unsubscribe = adapter.subscribe('theme', (stored) =>
          seen.push(stored)
        );
        unsubscribe();
        await adapter.set('theme', 'dark', { signal });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(seen, []);
      });

      if (options.ownWrites === 'notifies') {
        test('reports a write and a removal made through the same adapter', async ({
          adapter,
        }) => {
          assert.ok(
            adapter.subscribe !== undefined && adapter.remove !== undefined
          );
          const seen: (StoredValue | null)[] = [];
          const unsubscribe = adapter.subscribe('theme', (stored) =>
            seen.push(stored)
          );
          const written = expectOk(
            await adapter.set('theme', 'dark', { signal })
          );
          await adapter.remove('theme', { signal });
          unsubscribe();
          assert.deepEqual(seen, [written, null]);
        });

        test('ignores changes to other keys', async ({ adapter }) => {
          assert.ok(adapter.subscribe !== undefined);
          const seen: (StoredValue | null)[] = [];
          const unsubscribe = adapter.subscribe('theme', (stored) =>
            seen.push(stored)
          );
          await adapter.set('other', 'x', { signal });
          unsubscribe();
          assert.deepEqual(seen, []);
        });
      } else {
        test('does not report a write made through the same adapter', async ({
          adapter,
        }) => {
          assert.ok(adapter.subscribe !== undefined);
          const seen: (StoredValue | null)[] = [];
          const unsubscribe = adapter.subscribe('theme', (stored) =>
            seen.push(stored)
          );
          await adapter.set('theme', 'dark', { signal });
          await new Promise((resolve) => setTimeout(resolve, 50));
          unsubscribe();
          assert.deepEqual(seen, []);
        });
      }
    });

    void describe('durability', () => {
      test('a second adapter over the same storage sees earlier writes', async (subject) => {
        if (subject.reopen === undefined) {
          return; // This storage lives and dies with its adapter.
        }
        const written = expectOk(
          await subject.adapter.set('theme', 'dark', { signal })
        );
        const again = subject.reopen();
        assert.deepEqual(await again.get('theme', { signal }), {
          ok: true,
          value: written,
        });
      });

      test('a revision from one adapter is accepted by another over the same storage', async (subject) => {
        if (subject.reopen === undefined) {
          return;
        }
        const written = expectOk(
          await subject.adapter.set('theme', 'dark', { signal })
        );
        const again = subject.reopen();
        expectOk(
          await again.set('theme', 'light', {
            signal,
            ifRevision: revisionOf(written),
          })
        );
      });
    });
  });
}
