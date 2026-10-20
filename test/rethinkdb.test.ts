/**
 * The RethinkDB adapter, over an in-memory stand-in for `rethinkdb-ts` and a RethinkDB
 * server (test/support/fake-rethinkdb.ts), so the default test run stays offline.
 * test/rethinkdb-server.test.ts runs the same adapter against a real server.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  prefixUpperBound,
  rethinkDbAdapter,
  type RethinkDbAdapterOptions,
} from '../src/rethinkdb/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeRethinkDb } from './support/fake-rethinkdb.js';

const signal: AbortSignal = new AbortController().signal;
const TABLE = 'test.storage_entry';

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
): string {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  assert.ok(
    result.error.includes(`"${key}"`),
    `error should name the key: ${result.error}`
  );
  assert.ok(result.error.startsWith('RethinkDB '), result.error);
  return result.error;
}

function adapterFor(
  rethink: FakeRethinkDb,
  more: Partial<RethinkDbAdapterOptions> = {}
): StorageAdapter {
  return rethinkDbAdapter({ r: rethink.r, connection: 'conn', ...more });
}

const removeKey = async (
  adapter: StorageAdapter,
  key: string
): Promise<StoreResult<null>> =>
  adapter.remove?.(key, { signal }) ?? { ok: true, value: null };

const tick = (ms = 40): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await tick(20);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const unsubscribed = (): void => undefined;

runConformance('rethinkDbAdapter over a fake server', {
  ownWrites: 'notifies',
  create: () => {
    const rethink = new FakeRethinkDb();
    return {
      adapter: adapterFor(rethink),
      reopen: () => adapterFor(rethink),
    };
  },
});

void describe('prefixUpperBound', () => {
  void it('is the smallest string above every string with the prefix', () => {
    assert.equal(prefixUpperBound('user/'), 'user0');
    assert.equal(prefixUpperBound('a'), 'b');
    assert.equal(prefixUpperBound('é'), 'ê');
  });

  void it('is null when nothing bounds the prefix', () => {
    assert.equal(prefixUpperBound(''), null);
    assert.equal(prefixUpperBound('\u{10ffff}'), null);
  });

  void it('drops trailing highest code points, and steps over the surrogate range', () => {
    assert.equal(prefixUpperBound('a\u{10ffff}'), 'b');
    assert.equal(prefixUpperBound('퟿'), '');
    assert.equal(prefixUpperBound('😀'), '\u{1f601}');
  });
});

void describe('rethinkDbAdapter: documents and revisions', () => {
  void it('counts revisions per key from 1', async () => {
    const adapter = adapterFor(new FakeRethinkDb());
    const first = expectOk(await adapter.set('a', 'x', { signal }));
    const second = expectOk(await adapter.set('a', 'y', { signal }));
    const other = expectOk(await adapter.set('b', 'z', { signal }));
    assert.deepEqual(
      [first.revision, second.revision, other.revision],
      ['1', '2', '1']
    );
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
      value: 'y',
      revision: '2',
    });
  });

  void it('stores the key as the primary key, with both timestamps', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink);
    expectOk(await adapter.set('theme', 'dark', { signal }));
    const created = rethink.tables.get(TABLE)?.get('theme');
    await tick(10);
    expectOk(await adapter.set('theme', 'light', { signal }));
    const doc = rethink.tables.get(TABLE)?.get('theme');
    assert.equal(doc?.id, 'theme');
    assert.equal(doc?.value, 'light');
    assert.equal(doc?.revision, 2);
    assert.ok(
      doc?.created_at instanceof Date && doc.updated_at instanceof Date
    );
    assert.deepEqual(doc.created_at, created?.created_at);
    assert.ok(doc.updated_at.getTime() > doc.created_at.getTime());
  });

  void it('writes in one replace, whatever the key holds', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink);
    expectOk(await adapter.set('k', 'one', { signal }));
    rethink.runs.length = 0;
    expectOk(await adapter.set('k', 'two', { signal }));
    expectOk(await adapter.set('k', 'three', { signal, ifRevision: '2' }));
    assert.deepEqual(
      rethink.runs.map((run) => run.query),
      [`table ${TABLE}.get(k).replace()`, `table ${TABLE}.get(k).replace()`]
    );
  });

  void it('refuses an old revision in the same write, and says who holds the key', async () => {
    const adapter = adapterFor(new FakeRethinkDb());
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('k', 'two', { signal }));
    const message = expectFailure(
      await adapter.set('k', 'three', { signal, ifRevision: '1' }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 2, but revision 1 was expected/);
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'two');
  });

  void it('creates a key with nothing stored, even when given a revision', async () => {
    const adapter = adapterFor(new FakeRethinkDb());
    assert.equal(
      expectOk(await adapter.set('k', 'v', { signal, ifRevision: '41' }))
        .revision,
      '1'
    );
    expectOk(await removeKey(adapter, 'k'));
    assert.equal(
      expectOk(await adapter.set('k', 'again', { signal, ifRevision: '1' }))
        .revision,
      '1'
    );
  });

  void it('treats text that is not a revision as one that never matches', async () => {
    const adapter = adapterFor(new FakeRethinkDb());
    expectOk(await adapter.set('k', 'v', { signal }));
    for (const ifRevision of ['abc', '', '1.5', '0', '99999999999999999999']) {
      expectFailure(
        await adapter.set('k', 'w', { signal, ifRevision }),
        'conflict',
        'k'
      );
    }
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'v');
    expectOk(await removeKey(adapter, 'k'));
    assert.equal(
      expectOk(await adapter.set('k', 'new', { signal, ifRevision: 'abc' }))
        .revision,
      '1'
    );
  });

  void it('starts a removed key again at revision 1', async () => {
    const adapter = adapterFor(new FakeRethinkDb());
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('k', 'two', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    assert.equal(expectOk(await adapter.get('k', { signal })), null);
    assert.equal(
      expectOk(await adapter.set('k', 'again', { signal })).revision,
      '1'
    );
  });

  void it('reports a document that is not an entry as corrupt, and lets a remove clear it', async () => {
    const rethink = new FakeRethinkDb([TABLE]);
    const adapter = adapterFor(rethink, { createTable: false });
    for (const doc of [
      { id: 'k', value: 'no revision' },
      { id: 'k', value: 'text revision', revision: 'five' },
      { id: 'k', revision: 3 },
      { id: 'k', value: 7, revision: 3 },
    ]) {
      rethink.put(TABLE, doc);
      const message = expectFailure(
        await adapter.get('k', { signal }),
        'corrupt',
        'k'
      );
      assert.match(message, /remove the key to start again/);
      if (doc.revision === undefined || typeof doc.revision === 'string') {
        expectFailure(await adapter.set('k', 'v', { signal }), 'corrupt', 'k');
      }
      expectOk(await removeKey(adapter, 'k'));
      assert.equal(
        expectOk(await adapter.set('k', 'v', { signal })).revision,
        '1'
      );
      expectOk(await removeKey(adapter, 'k'));
    }
  });
});

void describe('rethinkDbAdapter: races', () => {
  void it('lets only one of several writers holding the same revision win', async () => {
    const rethink = new FakeRethinkDb();
    rethink.writeLatencyMs = 10;
    const adapter = adapterFor(rethink);
    const first = expectOk(await adapter.set('k', 'start', { signal }));
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        adapter.set('k', `writer ${String(index)}`, {
          signal,
          ifRevision: first.revision as string,
        })
      )
    );
    assert.equal(results.filter((result) => result.ok).length, 1);
  });

  void it('reports a conflict that happened between the replace and the read that explains it', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink);
    expectOk(await adapter.set('k', 'one', { signal }));
    const message = expectFailure(
      await adapter.set('k', 'two', { signal, ifRevision: '9' }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 1, but revision 9 was expected/);
  });

  void it('says the key changed when it is gone by the time the conflict is explained', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink);
    expectOk(await adapter.set('k', 'one', { signal }));
    let fail = true;
    rethink.beforeReplace = (table, key) => {
      if (fail) {
        fail = false;
        queueMicrotask(() => {
          rethink.remove(table, key);
        });
      }
    };
    const message = expectFailure(
      await adapter.set('k', 'two', { signal, ifRevision: '9' }),
      'conflict',
      'k'
    );
    assert.match(message, /changed while it was being written/);
  });
});

void describe('rethinkDbAdapter: the table', () => {
  void it('creates the table once, before first use, and waits for it', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink);
    expectOk(await adapter.set('a', '1', { signal }));
    expectOk(await adapter.get('a', { signal }));
    expectOk(await adapter.set('b', '2', { signal }));
    const queries = rethink.runs.map((run) => run.query);
    assert.equal(queries.filter((q) => q.startsWith('tableCreate')).length, 1);
    assert.deepEqual(queries.slice(0, 3), [
      'tableList test',
      'tableCreate test.storage_entry',
      `wait ${TABLE}`,
    ]);
    assert.ok(rethink.tables.has(TABLE));
  });

  void it('does not create a table that is there, and tolerates another process creating it first', async () => {
    const rethink = new FakeRethinkDb([TABLE]);
    expectOk(await adapterFor(rethink).get('k', { signal }));
    assert.ok(
      rethink.runs.every((run) => !run.query.startsWith('tableCreate'))
    );
    // Both list before either creates, so the second create is refused as a duplicate.
    const shared = new FakeRethinkDb();
    const results = await Promise.all([
      adapterFor(shared).set('a', '1', { signal }),
      adapterFor(shared).set('b', '2', { signal }),
    ]);
    for (const result of results) {
      expectOk(result);
    }
    assert.equal(
      shared.runs.filter((run) => run.query.startsWith('tableCreate')).length,
      2
    );
  });

  void it('explains an ambiguous table, which several processes creating it at once can cause', async () => {
    const rethink = new FakeRethinkDb([TABLE]);
    const adapter = adapterFor(rethink, { createTable: false });
    rethink.failures.push(
      new Error(
        'Table `test.storage_entry` is ambiguous; there are multiple tables with that name'
      )
    );
    const message = expectFailure(
      await adapter.set('k', 'v', { signal }),
      'unavailable',
      'k'
    );
    assert.match(
      message,
      /two tables with this name.*at the same moment.*create the table once before starting several processes/
    );
  });

  void it('uses the database and table names it is given', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink, { db: 'app', table: 'settings' });
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.ok(rethink.tables.get('app.settings')?.has('k'));
  });

  void it('refuses names that are not plain, without asking RethinkDB', async () => {
    const rethink = new FakeRethinkDb();
    for (const more of [
      { db: 'bad name' },
      { table: 'a;drop' },
      { table: 'a.b' },
      { db: '' },
    ]) {
      const adapter = adapterFor(rethink, more);
      const message = expectFailure(
        await adapter.get('k', { signal }),
        'invalid',
        'k'
      );
      assert.match(message, /cannot use database/);
      const listed = await adapter.list?.('', { signal });
      assert.ok(
        listed !== undefined && !listed.ok && listed.code === 'invalid'
      );
    }
    assert.deepEqual(rethink.runs, []);
  });

  void it('reports a failed creation and tries again next time', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink);
    rethink.failures.push(
      new Error('Cannot perform write: primary replica not available')
    );
    expectFailure(await adapter.set('k', 'v', { signal }), 'unavailable', 'k');
    expectOk(await adapter.set('k', 'v', { signal }));
  });

  void it('does not create anything when told not to, and says the table is missing', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink, { createTable: false });
    rethink.failures.push(
      new Error('Table `test.storage_entry` does not exist')
    );
    const message = expectFailure(
      await adapter.get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /check that table "test.storage_entry" exists/);
    assert.ok(
      rethink.runs.every(
        (run) =>
          !run.query.startsWith('tableCreate') &&
          !run.query.startsWith('tableList')
      )
    );
  });

  void it('runs every query on the connection it was given', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink, { connection: { id: 'mine' } });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await adapter.get('k', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    expectOk((await adapter.list?.('', { signal })) ?? { ok: true, value: [] });
    assert.ok(rethink.runs.length > 4);
    assert.ok(
      rethink.runs.every(
        (run) => (run.connection as { id?: string }).id === 'mine'
      )
    );
  });
});

void describe('rethinkDbAdapter: listing', () => {
  void it('lists keys under a prefix, in order, by code point', async () => {
    const adapter = adapterFor(new FakeRethinkDb());
    const keys = ['user/2', 'user/1', 'users', 'é😀', '😀', '￿', 'a b', ''];
    for (const key of keys) {
      expectOk(await adapter.set(key, key, { signal }));
    }
    const list = async (prefix: string): Promise<readonly string[]> =>
      expectOk(
        (await adapter.list?.(prefix, { signal })) ?? { ok: true, value: [] }
      );
    assert.deepEqual(await list('user/'), ['user/1', 'user/2']);
    assert.deepEqual(await list('é'), ['é😀']);
    assert.deepEqual(await list('\u{1f600}'), ['😀']);
    assert.deepEqual(await list('nothing'), []);
    assert.equal((await list('')).length, keys.length);
  });

  void it('asks for a range of the primary key, only its ids, and none of the other keys', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink);
    for (const key of ['user/1', 'users', 'zebra']) {
      expectOk(await adapter.set(key, key, { signal }));
    }
    rethink.runs.length = 0;
    expectOk(
      (await adapter.list?.('user/', { signal })) ?? { ok: true, value: [] }
    );
    assert.deepEqual(
      rethink.runs.map((run) => run.query),
      [`table ${TABLE}.between(user/, user0).pluck(id)`]
    );
  });

  void it('does not list removed keys', async () => {
    const adapter = adapterFor(new FakeRethinkDb());
    expectOk(await adapter.set('a', '1', { signal }));
    expectOk(await adapter.set('b', '2', { signal }));
    expectOk(await removeKey(adapter, 'a'));
    assert.deepEqual(
      expectOk(
        (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
      ),
      ['b']
    );
  });

  void it('names the prefix when listing fails', async () => {
    const rethink = new FakeRethinkDb([TABLE]);
    const adapter = adapterFor(rethink, { createTable: false });
    rethink.failures.push(new Error('Operation timed out'));
    const result = await adapter.list?.('user/', { signal });
    assert.ok(result !== undefined && !result.ok);
    assert.equal(result.code, 'unavailable');
    assert.ok(
      result.error.includes('"user/"') && result.error.includes('timed out'),
      result.error
    );
  });
});

void describe('rethinkDbAdapter: keys, values and failures', () => {
  void it('refuses keys and values RethinkDB cannot hold, without asking it', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink);
    expectFailure(await adapter.get('\ud800', { signal }), 'invalid', '\ud800');
    const huge = 'k'.repeat(128);
    const message = expectFailure(
      await adapter.set(huge, 'v', { signal }),
      'invalid',
      huge
    );
    assert.match(message, /at most 127 bytes/);
    expectFailure(
      await adapter.set('é'.repeat(64), 'v', { signal }),
      'invalid',
      'é'.repeat(64)
    );
    expectFailure(await adapter.set('k', '\udc00', { signal }), 'invalid', 'k');
    assert.deepEqual(rethink.runs, []);
  });

  void it('accepts a key of exactly 127 bytes', async () => {
    const adapter = adapterFor(new FakeRethinkDb());
    const key = 'k'.repeat(127);
    expectOk(await adapter.set(key, 'v', { signal }));
    assert.equal(expectOk(await adapter.get(key, { signal }))?.value, 'v');
  });

  const cases: readonly [string, string][] = [
    ['Cannot perform read: Auth failed (invalid password)', 'forbidden'],
    ['Server permission denied: user cannot read', 'forbidden'],
    ['Primary key too long (max 127 characters): "kkk"', 'invalid'],
    ['No space left on device', 'quota'],
    ['Connection is closed.', 'unavailable'],
    ['Operation timed out', 'unavailable'],
  ];
  for (const [message, code] of cases) {
    void it(`maps "${message.slice(0, 40)}" to ${code}, naming the key`, async () => {
      const rethink = new FakeRethinkDb();
      const adapter = adapterFor(rethink, { createTable: false });
      rethink.failures.push(new Error(message));
      const error = expectFailure(
        await adapter.get('k', { signal }),
        code,
        'k'
      );
      assert.ok(error.includes(message), error);
    });
  }

  void it('warns that a write that lost its connection may have been applied', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink, { createTable: false });
    rethink.failures.push(new Error('Connection is closed.'));
    const message = expectFailure(
      await adapter.set('k', 'v', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /may or may not have been applied/);
    rethink.failures.push(new Error('Connection is closed.'));
    assert.match(
      expectFailure(await removeKey(adapter, 'k'), 'unavailable', 'k'),
      /may or may not have been applied/
    );
    rethink.failures.push(new Error('Connection is closed.'));
    assert.doesNotMatch(
      expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k'),
      /may or may not/
    );
  });

  void it('does not touch the database when the request was aborted', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink);
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
      (await adapter.remove?.('k', { signal: controller.signal })) ?? {
        ok: true,
        value: null,
      },
      'unavailable',
      'k'
    );
    const listed = await adapter.list?.('', { signal: controller.signal });
    assert.ok(listed !== undefined && !listed.ok);
    assert.deepEqual(rethink.runs, []);
  });
});

void describe('rethinkDbAdapter: subscribe', () => {
  void it('reports writes and removals made through the same adapter, once each', async () => {
    const rethink = new FakeRethinkDb();
    const adapter = adapterFor(rethink);
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick();
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('other', 'x', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    await tick();
    stop();
    expectOk(await adapter.set('k', 'two', { signal }));
    assert.deepEqual(
      seen.map((stored) => stored?.value ?? null),
      ['one', null]
    );
  });

  void it('hears a write and a removal made by another process through the changefeed', async () => {
    const rethink = new FakeRethinkDb([TABLE]);
    const adapter = adapterFor(rethink, { createTable: false });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick();
    rethink.put(TABLE, { id: 'k', value: 'from elsewhere', revision: 4 });
    await eventually(() => seen.length === 1, 'the write');
    rethink.put(TABLE, { id: 'other', value: 'ignored', revision: 1 });
    rethink.remove(TABLE, 'k');
    await eventually(() => seen.length === 2, 'the removal');
    stop();
    assert.deepEqual(seen, [{ value: 'from elsewhere', revision: '4' }, null]);
  });

  void it('does not report what was stored when it subscribed', async () => {
    const rethink = new FakeRethinkDb([TABLE]);
    rethink.put(TABLE, { id: 'k', value: 'old', revision: 1 });
    const adapter = adapterFor(rethink, { createTable: false });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(100);
    assert.equal(seen.length, 0);
    rethink.put(TABLE, { id: 'k', value: 'new', revision: 2 });
    await eventually(() => seen.length === 1, 'the change');
    stop();
    assert.deepEqual(seen, [{ value: 'new', revision: '2' }]);
  });

  void it('hears its own writes once even though the changefeed repeats them', async () => {
    const rethink = new FakeRethinkDb();
    rethink.writeLatencyMs = 15;
    const adapter = adapterFor(rethink);
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(100);
    for (let index = 0; index < 6; index += 1) {
      expectOk(await adapter.set('k', `v${String(index)}`, { signal }));
    }
    await tick(100);
    stop();
    assert.deepEqual(
      seen.map((stored) => stored?.value),
      Array.from({ length: 6 }, (_, index) => `v${String(index)}`)
    );
  });

  void it('shares one changefeed among the subscribers of a key, and closes it with the last', async () => {
    const rethink = new FakeRethinkDb([TABLE]);
    const adapter = adapterFor(rethink, { createTable: false });
    const first: (StoredValue | null)[] = [];
    const second: (StoredValue | null)[] = [];
    const stopFirst =
      adapter.subscribe?.('k', (stored) => first.push(stored)) ?? unsubscribed;
    const stopSecond =
      adapter.subscribe?.('k', (stored) => second.push(stored)) ?? unsubscribed;
    const stopOther =
      adapter.subscribe?.('other', () => undefined) ?? unsubscribed;
    await tick();
    assert.equal(rethink.openFeeds, 2);
    rethink.put(TABLE, { id: 'k', value: 'v', revision: 1 });
    await eventually(() => first.length === 1 && second.length === 1, 'both');
    stopFirst();
    stopFirst();
    assert.equal(rethink.openFeeds, 2);
    stopSecond();
    assert.equal(rethink.openFeeds, 1);
    stopOther();
    assert.equal(rethink.openFeeds, 0);
  });

  void it('watches again after the changefeed ends, and reports what changed meanwhile', async () => {
    const rethink = new FakeRethinkDb([TABLE]);
    rethink.put(TABLE, { id: 'k', value: 'before', revision: 1 });
    const messages: string[] = [];
    const adapter = adapterFor(rethink, {
      createTable: false,
      watchRetryMs: 40,
      onWatchError: (message) => messages.push(message),
    });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(80);
    rethink.dropFeeds();
    rethink.put(TABLE, { id: 'k', value: 'while it was down', revision: 2 });
    await eventually(() => seen.length === 1, 'the catch-up');
    rethink.put(TABLE, { id: 'k', value: 'after', revision: 3 });
    await eventually(() => seen.length === 2, 'the next change');
    stop();
    assert.deepEqual(
      seen.map((stored) => stored?.value),
      ['while it was down', 'after']
    );
    assert.equal(messages.length, 0);
  });

  void it('reports a changefeed that cannot start, naming the key, and tries again', async () => {
    const rethink = new FakeRethinkDb([TABLE]);
    const messages: string[] = [];
    const adapter = adapterFor(rethink, {
      createTable: false,
      watchRetryMs: 40,
      onWatchError: (message) => messages.push(message),
    });
    rethink.failures.push(
      new Error('Cannot perform read: primary replica not available')
    );
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await eventually(() => messages.length === 1, 'the report');
    assert.match(
      messages[0] ?? '',
      /could not watch for key "k" \(.*primary replica not available/
    );
    await tick(120);
    rethink.put(TABLE, { id: 'k', value: 'v', revision: 1 });
    await eventually(() => seen.length === 1, 'the retry');
    stop();
  });

  void it('does not watch again when retrying is turned off', async () => {
    const rethink = new FakeRethinkDb([TABLE]);
    const adapter = adapterFor(rethink, {
      createTable: false,
      watchRetryMs: 0,
    });
    const stop = adapter.subscribe?.('k', () => undefined) ?? unsubscribed;
    await tick(60);
    rethink.dropFeeds();
    await tick(120);
    assert.equal(rethink.openFeeds, 0);
    stop();
  });

  void it('survives a listener that throws', async () => {
    const adapter = adapterFor(new FakeRethinkDb());
    const stop =
      adapter.subscribe?.('k', () => {
        throw new Error('listener bug');
      }) ?? unsubscribed;
    expectOk(await adapter.set('k', 'v', { signal }));
    stop();
  });
});
