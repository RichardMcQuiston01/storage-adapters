import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  firestoreAdapter,
  firestoreDocumentId,
  firestorePrefixUpperBound,
} from '../src/firebase/index.js';
import type { StoredValue, StoreResult } from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { fakeFirestore, firestoreError } from './support/fake-firestore.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

function expectFailure<T>(
  result: StoreResult<T>,
  code: string,
  subject: string
): string {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  assert.ok(
    result.error.startsWith('Firestore '),
    `error should name the store: ${result.error}`
  );
  assert.ok(
    result.error.includes(`"${subject}"`),
    `error should name "${subject}": ${result.error}`
  );
  return result.error;
}

/** Lets queued snapshot callbacks run. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
};

runConformance('firestoreAdapter on an in-memory collection', {
  ownWrites: 'notifies',
  create: () => {
    const store = fakeFirestore();
    return {
      adapter: firestoreAdapter({ store }),
      reopen: () => firestoreAdapter({ store }),
    };
  },
});

void describe('firestoreDocumentId', () => {
  void it('keeps letters, digits and dashes and escapes everything else', () => {
    assert.equal(firestoreDocumentId('abc-DEF-123'), 'abc-DEF-123');
    assert.equal(firestoreDocumentId('a/b'), 'a%2Fb');
    assert.equal(firestoreDocumentId('with space'), 'with%20space');
    assert.equal(firestoreDocumentId('é'), '%C3%A9');
  });

  void it('never gives an id Firestore reserves: ".", "..", or "__name__"', () => {
    assert.equal(firestoreDocumentId('.'), '%2E');
    assert.equal(firestoreDocumentId('..'), '%2E%2E');
    assert.equal(firestoreDocumentId('__name__'), '%5F%5Fname%5F%5F');
    for (const key of ['a/b', '.', '..', '__x__', '.hidden', 'x.y_z']) {
      const id = firestoreDocumentId(key) ?? '';
      assert.ok(!id.includes('/'), id);
      assert.ok(!id.includes('.') && !id.includes('_'), id);
    }
  });

  void it('gives different ids to different keys', () => {
    const keys = ['a.b', 'a_b', 'a%2Eb', 'a b', 'a%20b', 'A', 'a'];
    const ids = new Set(keys.map((key) => firestoreDocumentId(key)));
    assert.equal(ids.size, keys.length);
  });

  void it('refuses a key Firestore cannot hold', () => {
    assert.equal(firestoreDocumentId(''), null);
    assert.equal(firestoreDocumentId('lone \ud800 surrogate'), null);
    assert.equal(firestoreDocumentId('é'.repeat(300)), null);
    assert.notEqual(firestoreDocumentId('a'.repeat(1500)), null);
    assert.equal(firestoreDocumentId('a'.repeat(1501)), null);
  });
});

void describe('firestorePrefixUpperBound', () => {
  void it('is the prefix with its last character raised by one', () => {
    assert.equal(firestorePrefixUpperBound('abc'), 'abd');
    assert.equal(firestorePrefixUpperBound('user:'), 'user;');
  });

  void it('works in code points, not code units', () => {
    assert.equal(firestorePrefixUpperBound('a\u{1f600}'), 'a\u{1f601}');
    assert.equal(firestorePrefixUpperBound('퟿'), '');
  });

  void it('drops a last character that cannot be raised, and gives none when nothing can', () => {
    assert.equal(firestorePrefixUpperBound('a\u{10ffff}'), 'b');
    assert.equal(firestorePrefixUpperBound('\u{10ffff}'), null);
    assert.equal(firestorePrefixUpperBound(''), null);
  });
});

void describe('firestoreAdapter', () => {
  void it('stores each key as one document with the key, value, counter revision and timestamps', async () => {
    const store = fakeFirestore();
    const times = [
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-02T00:00:00.000Z'),
    ];
    const adapter = firestoreAdapter({
      store,
      now: () => times.shift() ?? new Date(0),
    });
    assert.deepEqual(expectOk(await adapter.set('a/b', 'one', { signal })), {
      value: 'one',
      revision: '1',
    });
    assert.deepEqual(store.documents.get('a%2Fb'), {
      key: 'a/b',
      value: 'one',
      revision: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    expectOk(await adapter.set('a/b', 'two', { signal }));
    assert.deepEqual(store.documents.get('a%2Fb'), {
      key: 'a/b',
      value: 'two',
      revision: 2,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
  });

  void it('says what revision it holds when a write is stale', async () => {
    const adapter = firestoreAdapter({ store: fakeFirestore() });
    const first = expectOk(await adapter.set('k', 'v1', { signal }));
    expectOk(
      await adapter.set('k', 'v2', {
        signal,
        ifRevision: first.revision ?? '',
      })
    );
    const message = expectFailure(
      await adapter.set('k', 'v3', {
        signal,
        ifRevision: first.revision ?? '',
      }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 2, but revision 1 was expected/);
    assert.deepEqual(expectOk(await adapter.get('k', { signal })), {
      value: 'v2',
      revision: '2',
    });
  });

  void it('lets exactly one of several racing writers with the same revision win', async () => {
    const store = fakeFirestore();
    const adapter = firestoreAdapter({ store });
    const base = expectOk(await adapter.set('k', 'base', { signal }));
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((value) =>
        adapter.set('k', value, { signal, ifRevision: base.revision ?? '' })
      )
    );
    // The fake runs a transaction's body at once, so exactly one sees revision 1.
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(
      results.filter((result) => !result.ok && result.code === 'conflict')
        .length,
      3
    );
  });

  void describe('writes to one key', () => {
    /** A store that records how many transactions run at once, per document. */
    const countingStore = () => {
      const store = fakeFirestore();
      const running = new Map<string, number>();
      let mostAtOnce = 0;
      let mostForOneDocument = 0;
      const transact = store.transact;
      store.transact = async (documentId, decide) => {
        const forDocument = (running.get(documentId) ?? 0) + 1;
        running.set(documentId, forDocument);
        mostForOneDocument = Math.max(mostForOneDocument, forDocument);
        mostAtOnce = Math.max(
          mostAtOnce,
          [...running.values()].reduce((sum, count) => sum + count, 0)
        );
        try {
          // A real round trip, so overlapping callers would overlap here.
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await transact(documentId, decide);
        } finally {
          running.set(documentId, (running.get(documentId) ?? 1) - 1);
        }
      };
      return {
        store,
        mostForOneDocument: () => mostForOneDocument,
        mostAtOnce: () => mostAtOnce,
      };
    };

    void it('run one at a time, so racing writers find out at once who won', async () => {
      const counted = countingStore();
      const adapter = firestoreAdapter({ store: counted.store });
      const first = expectOk(await adapter.set('k', 'start', { signal }));
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          adapter.set('k', `writer-${index}`, {
            signal,
            ifRevision: first.revision ?? '',
          })
        )
      );
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal(counted.mostForOneDocument(), 1);
    });

    void it('queue a removal behind the writes before it', async () => {
      const counted = countingStore();
      const adapter = firestoreAdapter({ store: counted.store });
      const results = await Promise.all([
        adapter.set('k', 'one', { signal }),
        adapter.set('k', 'two', { signal }),
        adapter.remove?.('k', { signal }) ??
          Promise.reject(new Error('no remove')),
      ]);
      assert.ok(results.every((result) => result.ok));
      assert.equal(counted.mostForOneDocument(), 1);
      assert.deepEqual(expectOk(await adapter.get('k', { signal })), null);
    });

    void it('are not held up by an earlier write that failed', async () => {
      const counted = countingStore();
      const adapter = firestoreAdapter({ store: counted.store });
      counted.store.failNext.transact = firestoreError('unavailable', 'blip');
      const [failed, next] = await Promise.all([
        adapter.set('k', 'lost', { signal }),
        adapter.set('k', 'kept', { signal }),
      ]);
      expectFailure(failed, 'unavailable', 'k');
      assert.deepEqual(expectOk(next), { value: 'kept', revision: '1' });
    });

    void it('to different keys still go at the same time', async () => {
      const counted = countingStore();
      const adapter = firestoreAdapter({ store: counted.store });
      const results = await Promise.all(
        ['a', 'b', 'c', 'd'].map((key) => adapter.set(key, 'v', { signal }))
      );
      assert.ok(results.every((result) => result.ok));
      assert.equal(counted.mostForOneDocument(), 1);
      assert.ok(counted.mostAtOnce() > 1, 'different keys should overlap');
    });
  });

  void it('writes the same document when Firestore reruns the transaction', async () => {
    const store = fakeFirestore();
    store.rerunTransactions = 2;
    const adapter = firestoreAdapter({ store });
    assert.deepEqual(expectOk(await adapter.set('k', 'v', { signal })), {
      value: 'v',
      revision: '1',
    });
  });

  void it('refuses a key Firestore cannot hold, naming it, and touches nothing', async () => {
    const store = fakeFirestore();
    const adapter = firestoreAdapter({ store });
    const empty = expectFailure(
      await adapter.set('', 'v', { signal }),
      'invalid',
      ''
    );
    assert.match(empty, /must not be empty/);
    expectFailure(await adapter.get('', { signal }), 'invalid', '');
    expectFailure(
      await adapter.set('bad \ud800', 'v', { signal }),
      'invalid',
      'bad \ud800'
    );
    assert.deepEqual(store.calls, []);
  });

  void it('refuses a value too big for a document, and writes nothing', async () => {
    const store = fakeFirestore();
    const adapter = firestoreAdapter({ store });
    const message = expectFailure(
      await adapter.set('big', 'x'.repeat(1_000_001), { signal }),
      'invalid',
      'big'
    );
    assert.match(message, /1 MiB/);
    assert.deepEqual(store.calls, []);
  });

  void it('does not touch the store when the signal is already aborted', async () => {
    const store = fakeFirestore();
    const adapter = firestoreAdapter({ store });
    const controller = new AbortController();
    controller.abort();
    expectFailure(
      await adapter.get('k', { signal: controller.signal }),
      'unavailable',
      'k'
    );
    expectFailure(
      await adapter.set('k', 'v', { signal: controller.signal }),
      'unavailable',
      'k'
    );
    expectFailure(
      await (adapter.remove?.('k', { signal: controller.signal }) ??
        Promise.reject(new Error('no remove'))),
      'unavailable',
      'k'
    );
    expectFailure(
      await (adapter.list?.('p', { signal: controller.signal }) ??
        Promise.reject(new Error('no list'))),
      'unavailable',
      'p'
    );
    assert.deepEqual(store.calls, []);
  });

  void describe('a document that is not a stored entry', () => {
    void it('is corrupt when read, and cannot be checked against a revision', async () => {
      const store = fakeFirestore();
      store.documents.set('k', { key: 'k', value: 7 });
      const adapter = firestoreAdapter({ store });
      expectFailure(await adapter.get('k', { signal }), 'corrupt', 'k');
      expectFailure(
        await adapter.set('k', 'v', { signal, ifRevision: '1' }),
        'corrupt',
        'k'
      );
      assert.deepEqual(store.documents.get('k'), { key: 'k', value: 7 });
    });

    void it('is replaced by a plain write, which repairs it', async () => {
      const store = fakeFirestore();
      store.documents.set('k', { rubbish: true });
      const adapter = firestoreAdapter({ store });
      assert.deepEqual(expectOk(await adapter.set('k', 'v', { signal })), {
        value: 'v',
        revision: '1',
      });
    });
  });

  void describe('errors from the SDK', () => {
    const cases: readonly [string, string | number][] = [
      ['forbidden', 'permission-denied'],
      ['forbidden', 'firestore/permission-denied'],
      ['forbidden', 7],
      ['forbidden', 'unauthenticated'],
      ['forbidden', 16],
      ['quota', 'resource-exhausted'],
      ['quota', 8],
      ['invalid', 'invalid-argument'],
      ['invalid', 3],
      ['unavailable', 'unavailable'],
      ['unavailable', 'deadline-exceeded'],
      ['unavailable', 14],
    ];
    for (const [code, sdkCode] of cases) {
      void it(`maps ${String(sdkCode)} to ${code} for get, set, remove and list`, async () => {
        const store = fakeFirestore();
        const adapter = firestoreAdapter({ store });
        store.failNext.get = firestoreError(sdkCode, 'sdk said no');
        const read = expectFailure(
          await adapter.get('k', { signal }),
          code,
          'k'
        );
        assert.match(read, /could not be read \(sdk said no\)/);
        store.failNext.transact = firestoreError(sdkCode, 'sdk said no');
        expectFailure(await adapter.set('k', 'v', { signal }), code, 'k');
        store.failNext.transact = firestoreError(sdkCode, 'sdk said no');
        expectFailure(
          await (adapter.remove?.('k', { signal }) ??
            Promise.reject(new Error('no remove'))),
          code,
          'k'
        );
        store.failNext.list = firestoreError(sdkCode, 'sdk said no');
        expectFailure(
          await (adapter.list?.('p', { signal }) ??
            Promise.reject(new Error('no list'))),
          code,
          'p'
        );
      });
    }

    void it('does not tell subscribers about a write that failed', async () => {
      const store = fakeFirestore();
      const adapter = firestoreAdapter({ store });
      const heard: (StoredValue | null)[] = [];
      adapter.subscribe?.('k', (stored) => heard.push(stored));
      await settle();
      store.failNext.transact = firestoreError('unavailable');
      expectFailure(
        await adapter.set('k', 'v', { signal }),
        'unavailable',
        'k'
      );
      await settle();
      assert.deepEqual(heard, []);
    });
  });

  void describe('list', () => {
    void it('finds keys by prefix as plain text, even with characters that look like patterns', async () => {
      const adapter = firestoreAdapter({ store: fakeFirestore() });
      for (const key of [
        '100%',
        '100%sure',
        'a_b',
        'axb',
        'a.b',
        'a/b',
        'user:1',
        'user:2',
        'users',
        '\u{1f600}x',
        '\u{1f600}',
        '￿x',
      ]) {
        expectOk(await adapter.set(key, 'v', { signal }));
      }
      const list = async (prefix: string): Promise<string[]> =>
        expectOk(
          await (adapter.list?.(prefix, { signal }) ??
            Promise.reject(new Error('no list')))
        );
      assert.deepEqual(await list('100%'), ['100%', '100%sure']);
      assert.deepEqual(await list('a_'), ['a_b']);
      assert.deepEqual(await list('a.'), ['a.b']);
      assert.deepEqual(await list('user:'), ['user:1', 'user:2']);
      assert.deepEqual(await list('\u{1f600}'), ['\u{1f600}', '\u{1f600}x']);
      assert.deepEqual(await list('￿'), ['￿x']);
      assert.equal((await list('')).length, 12);
    });

    void it('says so when the store cannot list', async () => {
      const store = fakeFirestore();
      const adapter = firestoreAdapter({
        store: { get: store.get, transact: store.transact },
      });
      const message = expectFailure(
        await (adapter.list?.('p', { signal }) ??
          Promise.reject(new Error('no list'))),
        'invalid',
        'p'
      );
      assert.match(message, /no listKeys/);
    });
  });

  void describe('subscribe', () => {
    void it('reports a change another client makes, once', async () => {
      const store = fakeFirestore();
      const mine = firestoreAdapter({ store });
      const theirs = firestoreAdapter({ store });
      const heard: (StoredValue | null)[] = [];
      mine.subscribe?.('k', (stored) => heard.push(stored));
      await settle();
      expectOk(await theirs.set('k', 'v1', { signal }));
      await settle();
      expectOk(await theirs.set('k', 'v2', { signal }));
      await settle();
      expectOk(await (theirs.remove?.('k', { signal }) ?? Promise.reject()));
      await settle();
      assert.deepEqual(heard, [
        { value: 'v1', revision: '1' },
        { value: 'v2', revision: '2' },
        null,
      ]);
    });

    void it('reports its own write once, though the listener hears it again', async () => {
      const store = fakeFirestore();
      const adapter = firestoreAdapter({ store });
      const heard: (StoredValue | null)[] = [];
      adapter.subscribe?.('k', (stored) => heard.push(stored));
      await settle();
      expectOk(await adapter.set('k', 'v', { signal }));
      await settle();
      expectOk(await (adapter.remove?.('k', { signal }) ?? Promise.reject()));
      await settle();
      assert.deepEqual(heard, [{ value: 'v', revision: '1' }, null]);
    });

    void it('does not report what is already stored when it starts listening', async () => {
      const store = fakeFirestore();
      const adapter = firestoreAdapter({ store });
      expectOk(await adapter.set('k', 'v', { signal }));
      const heard: (StoredValue | null)[] = [];
      adapter.subscribe?.('k', (stored) => heard.push(stored));
      await settle();
      assert.deepEqual(heard, []);
    });

    void it('listens once per key however many subscribe, and stops with the last', async () => {
      const store = fakeFirestore();
      const adapter = firestoreAdapter({ store });
      const stopFirst = adapter.subscribe?.('k', () => undefined);
      const stopSecond = adapter.subscribe?.('k', () => undefined);
      const stopOther = adapter.subscribe?.('other', () => undefined);
      assert.equal(store.watchers.get('k'), 1);
      assert.equal(store.watchers.get('other'), 1);
      stopFirst?.();
      assert.equal(store.watchers.get('k'), 1);
      stopSecond?.();
      stopSecond?.();
      assert.equal(store.watchers.has('k'), false);
      stopOther?.();
      assert.equal(store.watchers.size, 0);
    });

    void it('hears a fresh change after unsubscribing and subscribing again', async () => {
      const store = fakeFirestore();
      const mine = firestoreAdapter({ store });
      const theirs = firestoreAdapter({ store });
      mine.subscribe?.('k', () => undefined)();
      const heard: (StoredValue | null)[] = [];
      mine.subscribe?.('k', (stored) => heard.push(stored));
      await settle();
      expectOk(await theirs.set('k', 'v', { signal }));
      await settle();
      assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
    });

    void it('says which key stopped listening when the listener fails', async () => {
      const store = fakeFirestore();
      const problems: [string, string][] = [];
      const adapter = firestoreAdapter({
        store,
        onWatchError: (key, message) => problems.push([key, message]),
      });
      adapter.subscribe?.('k', () => undefined);
      store.failWatchers(firestoreError('permission-denied', 'rules say no'));
      assert.equal(problems.length, 1);
      assert.equal(problems[0]?.[0], 'k');
      assert.match(
        problems[0]?.[1] ?? '',
        /Firestore stopped listening for key "k" \(rules say no\)/
      );
    });

    void it('still reports its own writes when the listener cannot start', async () => {
      const store = fakeFirestore();
      store.failNext.watch = firestoreError('unavailable', 'no network');
      const problems: string[] = [];
      const adapter = firestoreAdapter({
        store,
        onWatchError: (_key, message) => problems.push(message),
      });
      const heard: (StoredValue | null)[] = [];
      adapter.subscribe?.('k', (stored) => heard.push(stored));
      assert.match(problems[0] ?? '', /could not listen for key "k"/);
      expectOk(await adapter.set('k', 'v', { signal }));
      assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
    });

    void it('reports its own writes when the store cannot listen at all', async () => {
      const store = fakeFirestore();
      const adapter = firestoreAdapter({
        store: { get: store.get, transact: store.transact },
      });
      const heard: (StoredValue | null)[] = [];
      adapter.subscribe?.('k', (stored) => heard.push(stored));
      expectOk(await adapter.set('k', 'v', { signal }));
      expectOk(await adapter.set('k', 'v', { signal }));
      assert.deepEqual(heard, [
        { value: 'v', revision: '1' },
        { value: 'v', revision: '2' },
      ]);
    });
  });
});
