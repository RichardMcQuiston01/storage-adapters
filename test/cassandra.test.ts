/**
 * The Cassandra adapter, over an in-memory stand-in for a Cassandra client
 * (test/support/fake-cassandra.ts), so the default test run stays offline.
 * test/cassandra-server.test.ts runs the same adapter against a real node.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cassandraAdapter,
  type CassandraAdapterOptions,
} from '../src/cassandra/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeCassandra, FakeResponseError } from './support/fake-cassandra.js';

const signal: AbortSignal = new AbortController().signal;
const TABLE = 'storage_entry';

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
  assert.ok(result.error.startsWith('Cassandra '), result.error);
  return result.error;
}

function adapterFor(
  cassandra: FakeCassandra,
  more: Partial<CassandraAdapterOptions> = {}
): StorageAdapter {
  return cassandraAdapter({ client: cassandra, ...more });
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

runConformance('cassandraAdapter over a fake client', {
  ownWrites: 'notifies',
  create: () => {
    const cassandra = new FakeCassandra();
    return {
      adapter: adapterFor(cassandra),
      reopen: () => adapterFor(cassandra),
    };
  },
});

void describe('cassandraAdapter: rows and revisions', () => {
  void it('counts revisions per key from 1', async () => {
    const adapter = adapterFor(new FakeCassandra());
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

  void it('reads revisions whether the driver gives numbers or Long objects', async () => {
    for (const longRevisions of [true, false]) {
      const cassandra = new FakeCassandra();
      cassandra.longRevisions = longRevisions;
      const adapter = adapterFor(cassandra);
      expectOk(await adapter.set('k', 'one', { signal }));
      const second = expectOk(await adapter.set('k', 'two', { signal }));
      assert.equal(second.revision, '2');
      assert.equal(expectOk(await adapter.get('k', { signal }))?.revision, '2');
    }
  });

  void it('stores the creation and update times', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
    expectOk(await adapter.set('k', 'one', { signal }));
    const created = cassandra.tables.get(TABLE)?.get('k')?.createdAt;
    await tick(10);
    expectOk(await adapter.set('k', 'two', { signal }));
    const row = cassandra.tables.get(TABLE)?.get('k');
    assert.ok(created instanceof Date && row?.updatedAt instanceof Date);
    assert.equal(row.createdAt, created);
    assert.ok(row.updatedAt.getTime() >= created.getTime());
  });

  void it('writes when the revision matches in one conditional statement, and says who holds the key when it does not', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('k', 'two', { signal }));
    cassandra.statements.length = 0;
    const next = expectOk(
      await adapter.set('k', 'three', { signal, ifRevision: '2' })
    );
    assert.equal(next.revision, '3');
    assert.equal(cassandra.statements.length, 1);
    assert.match(cassandra.statements[0]?.query ?? '', /IF revision = \?/);
    const message = expectFailure(
      await adapter.set('k', 'four', { signal, ifRevision: '1' }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 3, but revision 1 was expected/);
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'three');
  });

  void it('creates a key with nothing stored, even when given a revision', async () => {
    const adapter = adapterFor(new FakeCassandra());
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
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'again');
  });

  void it('treats text that is not a revision as one that never matches', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
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
    const adapter = adapterFor(new FakeCassandra());
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('k', 'two', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    assert.equal(expectOk(await adapter.get('k', { signal })), null);
    assert.equal(
      expectOk(await adapter.set('k', 'again', { signal })).revision,
      '1'
    );
  });

  void it('reports a row that is not an entry as corrupt, and lets a remove clear it', async () => {
    const cassandra = new FakeCassandra([TABLE]);
    const adapter = adapterFor(cassandra);
    cassandra.put(TABLE, 'k', 'written by something else', null);
    const message = expectFailure(
      await adapter.get('k', { signal }),
      'corrupt',
      'k'
    );
    assert.match(message, /remove the key to start again/);
    expectFailure(await adapter.set('k', 'v', { signal }), 'corrupt', 'k');
    expectFailure(
      await adapter.set('k', 'v', { signal, ifRevision: '1' }),
      'corrupt',
      'k'
    );
    expectOk(await removeKey(adapter, 'k'));
    expectOk(await adapter.set('k', 'v', { signal }));
  });
});

void describe('cassandraAdapter: races', () => {
  void it('keeps trying an unconditional write until it lands, using the revision each refusal reports', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
    expectOk(await adapter.set('k', 'one', { signal }));
    let sneaked = 0;
    cassandra.beforeWrite = (table, key) => {
      if (sneaked < 3) {
        sneaked += 1;
        cassandra.put(table, key, 'sneaked in', 1 + sneaked);
      }
    };
    cassandra.statements.length = 0;
    const stored = expectOk(await adapter.set('k', 'mine', { signal }));
    assert.equal(stored.revision, '5');
    // No reads were needed: the first write was refused, and each refusal said what to try.
    assert.equal(cassandra.statements.length, 4);
    assert.ok(cassandra.statements.every((s) => !/^SELECT/.test(s.query)));
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'mine');
  });

  void it('creates the key when it was removed between an unconditional write and its retry', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
    expectOk(await adapter.set('k', 'one', { signal }));
    let removed = false;
    cassandra.beforeWrite = (table, key) => {
      if (
        !removed &&
        cassandra.statements.some((s) => /^UPDATE/.test(s.query))
      ) {
        removed = true;
        cassandra.delete(table, key);
      }
    };
    cassandra.put(TABLE, 'k', 'other', 7);
    const stored = expectOk(await adapter.set('k', 'mine', { signal }));
    assert.equal(stored.revision, '1');
  });

  void it('gives up on an unconditional write that always meets a newer version', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
    expectOk(await adapter.set('k', 'one', { signal }));
    let revision = 1;
    cassandra.beforeWrite = (table, key) => {
      revision += 1;
      cassandra.put(table, key, 'again', revision);
    };
    const message = expectFailure(
      await adapter.set('k', 'mine', { signal }),
      'conflict',
      'k'
    );
    assert.match(message, /kept changing.*gave up after 12 tries/);
  });

  void it('reports a conflict when another process created the key between the refusal and the create', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
    expectOk(await adapter.set('other', 'x', { signal }));
    cassandra.beforeWrite = (table, key) => {
      if (key === 'k' && !cassandra.tables.get(table)?.has('k')) {
        cassandra.put(table, key, 'created first', 1);
      }
    };
    const message = expectFailure(
      await adapter.set('k', 'mine', { signal, ifRevision: '3' }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 1, but revision 3 was expected/);
    assert.equal(
      expectOk(await adapter.get('k', { signal }))?.value,
      'created first'
    );
  });
});

void describe('cassandraAdapter: the table', () => {
  void it('creates the table once, before first use', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
    expectOk(await adapter.set('a', '1', { signal }));
    expectOk(await adapter.get('a', { signal }));
    expectOk(await adapter.set('b', '2', { signal }));
    assert.equal(
      cassandra.statements.filter((s) => /^CREATE TABLE/.test(s.query)).length,
      1
    );
    assert.ok(cassandra.tables.has(TABLE));
    assert.match(
      cassandra.statements[0]?.query ?? '',
      /entry_key text PRIMARY KEY[\s\S]*entry_value text[\s\S]*revision bigint[\s\S]*created_at timestamp[\s\S]*updated_at timestamp/
    );
  });

  void it('uses a keyspace and table name it is given', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra, { table: 'app.settings_entry' });
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.ok(cassandra.tables.get('app.settings_entry')?.has('k'));
  });

  void it('refuses a table name that is not a plain name, without asking Cassandra', async () => {
    const cassandra = new FakeCassandra();
    for (const table of ['bad name', 'a;drop', 'a.b.c', '1abc']) {
      const adapter = adapterFor(cassandra, { table });
      const message = expectFailure(
        await adapter.get('k', { signal }),
        'invalid',
        'k'
      );
      assert.match(message, /cannot use table/);
      const listed = await adapter.list?.('', { signal });
      assert.ok(
        listed !== undefined && !listed.ok && listed.code === 'invalid'
      );
    }
    assert.deepEqual(cassandra.statements, []);
  });

  void it('reports a failed creation and tries again next time', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
    cassandra.failures.push(
      new FakeResponseError('Cannot achieve consistency', 0x1000)
    );
    expectFailure(await adapter.set('k', 'v', { signal }), 'unavailable', 'k');
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.equal(
      cassandra.statements.filter((s) => /^CREATE TABLE/.test(s.query)).length,
      2
    );
  });

  void it('does not create anything when told not to, and says the table is missing', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra, { createTable: false });
    const message = expectFailure(
      await adapter.get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.match(
      message,
      /table "storage_entry" or its keyspace does not exist/
    );
    assert.ok(cassandra.statements.every((s) => !/^CREATE/.test(s.query)));
  });
});

void describe('cassandraAdapter: consistency and listing', () => {
  void it('reads at SERIAL, or LOCAL_SERIAL when asked, and writes without overriding', async () => {
    for (const [readConsistency, code] of [
      [undefined, 8],
      ['localSerial', 9],
    ] as const) {
      const cassandra = new FakeCassandra();
      const adapter = adapterFor(
        cassandra,
        readConsistency === undefined ? {} : { readConsistency }
      );
      expectOk(await adapter.set('k', 'v', { signal }));
      expectOk(await adapter.get('k', { signal }));
      const reads = cassandra.statements.filter((s) =>
        /^SELECT entry_value/.test(s.query)
      );
      assert.equal(reads.length, 1);
      assert.equal(reads[0]?.consistency, code);
      assert.ok(
        cassandra.statements
          .filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s.query))
          .every((s) => s.consistency === undefined)
      );
    }
  });

  void it('lists keys under a prefix, in order, across pages', async () => {
    const cassandra = new FakeCassandra([TABLE]);
    cassandra.pageSize = 7;
    const adapter = adapterFor(cassandra);
    const keys: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const key = `n${String(index).padStart(3, '0')}`;
      keys.push(key);
      cassandra.put(TABLE, key, 'v', 1);
    }
    for (const key of ['user/2', 'user/1', 'users', 'é😀']) {
      expectOk(await adapter.set(key, key, { signal }));
    }
    const list = async (prefix: string): Promise<readonly string[]> =>
      expectOk(
        (await adapter.list?.(prefix, { signal })) ?? { ok: true, value: [] }
      );
    assert.deepEqual(await list('n'), keys);
    assert.deepEqual(await list('user/'), ['user/1', 'user/2']);
    assert.deepEqual(await list('é'), ['é😀']);
    assert.deepEqual(await list('nothing'), []);
    assert.equal((await list('')).length, 44);
    assert.ok(
      cassandra.statements.filter((s) => /^SELECT entry_key FROM/.test(s.query))
        .length >= 6
    );
  });

  void it('does not list removed keys', async () => {
    const adapter = adapterFor(new FakeCassandra());
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
    const cassandra = new FakeCassandra([TABLE]);
    const adapter = adapterFor(cassandra, { createTable: false });
    cassandra.failures.push(
      new FakeResponseError('Operation timed out', 0x1200)
    );
    const result = await adapter.list?.('user/', { signal });
    assert.ok(result !== undefined && !result.ok);
    assert.equal(result.code, 'unavailable');
    assert.ok(
      result.error.includes('"user/"') && result.error.includes('timed out'),
      result.error
    );
  });
});

void describe('cassandraAdapter: keys, values and failures', () => {
  void it('refuses keys and values Cassandra cannot hold, without asking it', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
    const empty = expectFailure(
      await adapter.set('', 'v', { signal }),
      'invalid',
      ''
    );
    assert.match(empty, /empty partition key/);
    expectFailure(await adapter.get('\ud800', { signal }), 'invalid', '\ud800');
    const huge = 'k'.repeat(70_000);
    expectFailure(await adapter.set(huge, 'v', { signal }), 'invalid', huge);
    expectFailure(await adapter.set('k', '\udc00', { signal }), 'invalid', 'k');
    assert.deepEqual(cassandra.statements, []);
  });

  const cases: readonly [string, number, string][] = [
    [
      'Unauthorized: user app has no MODIFY permission on <table ks.t>',
      0x2100,
      'forbidden',
    ],
    [
      'Provided username app and/or password are incorrect',
      0x0100,
      'forbidden',
    ],
    [
      'Request is too big: length 20971587 exceeds maximum allowed length 16777216.',
      0x2200,
      'invalid',
    ],
    ['line 1:3 no viable alternative at input', 0x2000, 'invalid'],
    ['No space left on device', 0, 'quota'],
    ['Operation timed out - received only 0 responses.', 0x1200, 'unavailable'],
    [
      'All host(s) tried for query failed (no host was tried)',
      0,
      'unavailable',
    ],
  ];
  for (const [message, errorCode, code] of cases) {
    void it(`maps "${message.slice(0, 40)}" to ${code}, naming the key`, async () => {
      const cassandra = new FakeCassandra([TABLE]);
      const adapter = adapterFor(cassandra, { createTable: false });
      cassandra.failures.push(new FakeResponseError(message, errorCode));
      const error = expectFailure(
        await adapter.get('k', { signal }),
        code,
        'k'
      );
      assert.ok(error.includes(message), error);
    });
  }

  void it('warns that a timed-out write may have been applied', async () => {
    const cassandra = new FakeCassandra([TABLE]);
    const adapter = adapterFor(cassandra, { createTable: false });
    cassandra.failures.push(
      new FakeResponseError(
        'Operation timed out - CAS operation result is unknown',
        0x1100
      )
    );
    const message = expectFailure(
      await adapter.set('k', 'v', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /may or may not have been applied/);
    cassandra.failures.push(
      new FakeResponseError('Operation timed out', 0x1200)
    );
    const read = expectFailure(
      await adapter.get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.doesNotMatch(read, /may or may not/);
  });

  void it('does not touch the client when the request was aborted', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
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
    assert.deepEqual(cassandra.statements, []);
  });
});

void describe('cassandraAdapter: subscribe', () => {
  void it('reports writes and removals made through the same adapter, once each, without polling', async () => {
    const cassandra = new FakeCassandra();
    const adapter = adapterFor(cassandra);
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('other', 'x', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    stop();
    expectOk(await adapter.set('k', 'two', { signal }));
    assert.deepEqual(
      seen.map((stored) => stored?.value ?? null),
      ['one', null]
    );
    assert.ok(cassandra.statements.every((s) => !/ IN \?/.test(s.query)));
  });

  void it('hears a write and a removal made by another process when polling', async () => {
    const cassandra = new FakeCassandra([TABLE]);
    const adapter = adapterFor(cassandra, { pollIntervalMs: 50 });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(80);
    cassandra.put(TABLE, 'k', 'from elsewhere', 4);
    await eventually(() => seen.length === 1, 'the write');
    cassandra.delete(TABLE, 'k');
    await eventually(() => seen.length === 2, 'the removal');
    stop();
    assert.deepEqual(seen, [{ value: 'from elsewhere', revision: '4' }, null]);
  });

  void it('does not report what was stored when it subscribed, or an own write twice', async () => {
    const cassandra = new FakeCassandra([TABLE]);
    cassandra.put(TABLE, 'k', 'old', 1);
    const adapter = adapterFor(cassandra, { pollIntervalMs: 50 });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(150);
    assert.equal(seen.length, 0);
    expectOk(await adapter.set('k', 'mine', { signal }));
    await tick(250);
    stop();
    assert.deepEqual(
      seen.map((stored) => stored?.value),
      ['mine']
    );
  });

  void it('reports a failing poll once per run of failures, naming the table, and carries on', async () => {
    const cassandra = new FakeCassandra([TABLE]);
    const messages: string[] = [];
    const adapter = adapterFor(cassandra, {
      pollIntervalMs: 50,
      createTable: false,
      onPollError: (message) => messages.push(message),
    });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(80);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      cassandra.failures.push(
        new FakeResponseError('node is restarting', 0x1000)
      );
    }
    await tick(300);
    assert.equal(messages.length, 1);
    assert.match(
      messages[0] ?? '',
      /could not poll table "storage_entry" for changes \(.*restarting/
    );
    cassandra.put(TABLE, 'k', 'after the outage', 2);
    await eventually(() => seen.length === 1, 'recovery');
    stop();
    assert.equal(seen[0]?.value, 'after the outage');
  });

  void it('survives a listener that throws', async () => {
    const adapter = adapterFor(new FakeCassandra());
    const stop =
      adapter.subscribe?.('k', () => {
        throw new Error('listener bug');
      }) ?? unsubscribed;
    expectOk(await adapter.set('k', 'v', { signal }));
    stop();
  });
});
