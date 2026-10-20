/**
 * The ClickHouse adapter, over an in-memory stand-in for ClickHouse's HTTP interface
 * (test/support/fake-clickhouse.ts), so the default test run stays offline.
 * test/clickhouse-server.test.ts runs the same adapter against a real server.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clickHouseAdapter,
  type ClickHouseAdapterOptions,
} from '../src/clickhouse/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeClickHouse } from './support/fake-clickhouse.js';

const signal: AbortSignal = new AbortController().signal;
const TABLE = 'default.storage_entry';

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
  assert.ok(result.error.startsWith('ClickHouse '), result.error);
  return result.error;
}

function adapterFor(
  clickhouse: FakeClickHouse,
  more: Partial<ClickHouseAdapterOptions> = {}
): StorageAdapter {
  return clickHouseAdapter({
    url: 'http://clickhouse.test:8123/',
    fetch: clickhouse.fetch,
    ...more,
  });
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

runConformance('clickHouseAdapter on a stand-in ClickHouse', {
  ownWrites: 'notifies',
  create: () => {
    const clickhouse = new FakeClickHouse();
    return {
      adapter: adapterFor(clickhouse),
      reopen: () => adapterFor(clickhouse),
    };
  },
});

void describe('clickHouseAdapter', () => {
  void it('sends the statement as the body, with settings and headers on every request', async () => {
    const clickhouse = new FakeClickHouse();
    let token = 0;
    const adapter = adapterFor(clickhouse, {
      headers: () => ({ 'X-ClickHouse-Key': `secret${String(++token)}` }),
      settings: { insert_quorum: 'auto', select_sequential_consistency: 1 },
    });
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.ok(clickhouse.requests.length >= 3);
    for (const request of clickhouse.requests) {
      assert.ok(request.url.startsWith('http://clickhouse.test:8123/?'));
      assert.match(request.url, /wait_end_of_query=1/);
      assert.match(request.url, /insert_quorum=auto/);
      assert.match(request.url, /select_sequential_consistency=1/);
      assert.match(request.headers['X-ClickHouse-Key'] ?? '', /^secret\d+$/);
    }
  });

  void it('raises max_query_size for a value bigger than the default', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    expectOk(await adapter.set('k', 'x'.repeat(1_000_000), { signal }));
    const insert = clickhouse.requests.find((request) =>
      request.body.startsWith('INSERT')
    );
    const size = Number(/max_query_size=(\d+)/.exec(insert?.url ?? '')?.[1]);
    assert.ok(size > 1_000_000, String(size));
  });

  void it('creates the table once, and not at all when createTable is off', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    for (let index = 0; index < 3; index += 1) {
      expectOk(await adapter.set('k', 'v', { signal }));
    }
    assert.equal(
      clickhouse.requests.filter((request) =>
        request.body.startsWith('CREATE TABLE')
      ).length,
      1
    );
    const quiet = new FakeClickHouse();
    quiet.tables.set(TABLE, []);
    expectOk(
      await adapterFor(quiet, { createTable: false }).get('k', { signal })
    );
    assert.ok(
      !quiet.requests.some((request) => request.body.startsWith('CREATE'))
    );
  });

  void it('tries to create the table again after it failed', async () => {
    const clickhouse = new FakeClickHouse();
    clickhouse.failures.push({ status: 503, body: 'overloaded' });
    const adapter = adapterFor(clickhouse);
    const error = expectFailure(
      await adapter.get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.match(error, /could not create table "storage_entry"/);
    expectOk(await adapter.get('k', { signal }));
  });

  void it('uses the database and table it is given, and says which when one is missing', async () => {
    const clickhouse = new FakeClickHouse();
    clickhouse.databases.add('app');
    const adapter = adapterFor(clickhouse, {
      database: 'app',
      table: 'settings',
    });
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.equal(clickhouse.rowsFor('app.settings', 'k').length, 1);
    const other = adapterFor(new FakeClickHouse(), { database: 'nope' });
    const error = expectFailure(
      await other.get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.match(error, /database "nope"/);
    const bare = adapterFor(new FakeClickHouse(), { createTable: false });
    assert.match(
      expectFailure(await bare.get('k', { signal }), 'unavailable', 'k'),
      /check that the table "storage_entry" in database "default" exists/
    );
  });

  void it('refuses a database or table name that is not an identifier, naming the key', async () => {
    const clickhouse = new FakeClickHouse();
    for (const more of [
      { table: 'a`; DROP TABLE x; --' },
      { database: 'two words' },
      { table: '' },
    ]) {
      const adapter = adapterFor(clickhouse, more);
      expectFailure(await adapter.get('k', { signal }), 'invalid', 'k');
      expectFailure(await adapter.set('k', 'v', { signal }), 'invalid', 'k');
      expectFailure(await removeKey(adapter, 'k'), 'invalid', 'k');
    }
    assert.equal(clickhouse.requests.length, 0);
  });

  void it('escapes keys and values, so SQL in them is only data', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    const nasty = "x' OR 1=1; DROP TABLE storage_entry; --\\";
    expectOk(await adapter.set(nasty, nasty, { signal }));
    assert.equal(expectOk(await adapter.get(nasty, { signal }))?.value, nasty);
    assert.deepEqual(
      expectOk(
        (await adapter.list?.("x'", { signal })) ?? { ok: true, value: [] }
      ),
      [nasty]
    );
    assert.ok(
      !clickhouse.requests.some((request) =>
        /;\s*DROP/.test(request.body.replace(/'(?:[^'\\]|\\.)*'/g, ''))
      )
    );
  });

  void it('refuses a key or value that is not valid text, or too long, and sends nothing', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    expectFailure(
      await adapter.set('\ud800', 'v', { signal }),
      'invalid',
      '\ud800'
    );
    expectFailure(await adapter.set('k', '\udc00', { signal }), 'invalid', 'k');
    expectFailure(
      await adapter.set('k'.repeat(1025), 'v', { signal }),
      'invalid',
      'k'.repeat(1025)
    );
    expectFailure(
      await adapter.set('k', 'x'.repeat(4_000_001), { signal }),
      'invalid',
      'k'
    );
    const prefix = await adapter.list?.('\ud800', { signal });
    assert.ok(prefix !== undefined && !prefix.ok && prefix.code === 'invalid');
    assert.equal(clickhouse.requests.length, 0);
  });

  void it('reports an aborted request without sending it', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    const aborted: AbortSignal = AbortSignal.abort();
    expectFailure(
      await adapter.get('k', { signal: aborted }),
      'unavailable',
      'k'
    );
    assert.equal(clickhouse.requests.length, 0);
  });

  void it('gives each write a higher revision', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    let previous = 0n;
    for (let index = 0; index < 20; index += 1) {
      const written = expectOk(
        await adapter.set('k', String(index), { signal })
      );
      assert.ok(BigInt(written.revision as string) > previous);
      previous = BigInt(written.revision as string);
    }
  });

  void it('creates a key that holds nothing, or only a removal, when given ifRevision', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    expectOk(await adapter.set('a', 'v', { signal, ifRevision: 'anything' }));
    const first = expectOk(await adapter.set('b', 'one', { signal }));
    expectOk(await removeKey(adapter, 'b'));
    expectOk(
      await adapter.set('b', 'two', {
        signal,
        ifRevision: first.revision as string,
      })
    );
  });

  void it('refuses a stale ifRevision, saying which revision is held, and writes nothing', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    const first = expectOk(await adapter.set('k', 'one', { signal }));
    const second = expectOk(await adapter.set('k', 'two', { signal }));
    const error = expectFailure(
      await adapter.set('k', 'three', {
        signal,
        ifRevision: first.revision as string,
      }),
      'conflict',
      'k'
    );
    assert.ok(error.includes(second.revision as string), error);
    assert.equal(clickhouse.rowsFor(TABLE, 'k').length, 2);
  });

  void it('reports a conflict when another writer got in between and won', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    const base = expectOk(await adapter.set('k', 'base', { signal }));
    clickhouse.beforeInsert = (table, key) => {
      clickhouse.beforeInsert = null;
      clickhouse.put(
        table,
        key,
        'theirs',
        BigInt(base.revision as string) + 5n
      );
    };
    const error = expectFailure(
      await adapter.set('k', 'mine', {
        signal,
        ifRevision: base.revision as string,
      }),
      'conflict',
      'k'
    );
    assert.match(error, /holds revision \d+, but revision \d+ was expected/);
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'theirs');
  });

  void it('reports a conflict, without a revision, when a plain write loses a race', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    clickhouse.afterInsert = (table, key) => {
      clickhouse.afterInsert = null;
      clickhouse.put(table, key, 'theirs', 2n ** 40n);
    };
    const error = expectFailure(
      await adapter.set('k', 'mine', { signal }),
      'conflict',
      'k'
    );
    assert.match(error, /another writer at the same moment/);
  });

  void it('serialises writes to one key made through one adapter', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    expectOk(await adapter.set('n', '0', { signal }));
    const bump = async (): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = expectOk(await adapter.get('n', { signal }));
        const result = await adapter.set(
          'n',
          String(Number(current?.value) + 1),
          {
            signal,
            ifRevision: current?.revision as string,
          }
        );
        if (result.ok) {
          return;
        }
        assert.equal(result.code, 'conflict');
      }
      assert.fail('never got a turn');
    };
    await Promise.all(Array.from({ length: 10 }, bump));
    assert.equal(expectOk(await adapter.get('n', { signal }))?.value, '10');
  });

  void it('writes no row when removing a key that is not there, and one when it is', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    expectOk(await removeKey(adapter, 'never'));
    assert.equal(clickhouse.rowsFor(TABLE, 'never').length, 0);
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    expectOk(await removeKey(adapter, 'k'));
    assert.deepEqual(
      clickhouse.rowsFor(TABLE, 'k').map((row) => row.deleted),
      [0, 1]
    );
    assert.equal(expectOk(await adapter.get('k', { signal })), null);
    assert.deepEqual(
      expectOk(
        (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
      ),
      []
    );
  });

  void it('reports a row it cannot read as corrupt', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    expectOk(await adapter.get('k', { signal }));
    clickhouse.failures.push({
      status: 200,
      body: JSON.stringify({
        data: [{ latest_value: 1, latest_revision: 'x' }],
      }),
    });
    expectFailure(await adapter.get('k', { signal }), 'corrupt', 'k');
    clickhouse.failures.push({ status: 200, body: 'not json' });
    expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k');
  });

  void it('turns server and network failures into results that name the key', async () => {
    const cases: [number | Error, string, string][] = [
      [
        401,
        'Code: 516. DB::Exception: default: Authentication failed',
        'forbidden',
      ],
      [403, 'Code: 497. DB::Exception: Not enough privileges', 'forbidden'],
      [500, 'Code: 241. DB::Exception: Memory limit exceeded', 'unavailable'],
      [400, 'Code: 62. DB::Exception: Syntax error', 'invalid'],
      [500, 'Code: 62. DB::Exception: Max query size exceeded', 'invalid'],
      [503, '', 'unavailable'],
      [new Error('connect ECONNREFUSED'), '', 'unavailable'],
    ];
    for (const [failure, body, code] of cases) {
      const clickhouse = new FakeClickHouse();
      const adapter = adapterFor(clickhouse);
      expectOk(await adapter.get('warm', { signal }));
      clickhouse.failures.push(
        failure instanceof Error
          ? { throws: failure }
          : { status: failure, body }
      );
      const error = expectFailure(
        await adapter.get('k', { signal }),
        code,
        'k'
      );
      if (failure instanceof Error) {
        assert.match(error, /could not be reached \(.*ECONNREFUSED/);
      }
    }
  });

  void it('says it could not confirm a write that it could not read back', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    expectOk(await adapter.get('warm', { signal }));
    clickhouse.afterInsert = () => {
      clickhouse.afterInsert = null;
      clickhouse.failures.push({ status: 503, body: 'down' });
    };
    const error = expectFailure(
      await adapter.set('k', 'v', { signal }),
      'unavailable',
      'k'
    );
    assert.match(error, /was written but could not be read back to confirm it/);
  });

  void it('lists keys in code-unit order, under a prefix', async () => {
    const clickhouse = new FakeClickHouse();
    const adapter = adapterFor(clickhouse);
    for (const key of ['b', 'a2', 'a1', 'ab', '😀', 'é']) {
      expectOk(await adapter.set(key, key, { signal }));
    }
    const list = async (prefix: string): Promise<readonly string[]> =>
      expectOk(
        (await adapter.list?.(prefix, { signal })) ?? { ok: true, value: [] }
      );
    assert.deepEqual(await list('a'), ['a1', 'a2', 'ab']);
    assert.deepEqual(await list(''), ['a1', 'a2', 'ab', 'b', 'é', '😀']);
  });

  void it('hears changes made through another adapter when polling, and own writes once', async () => {
    const clickhouse = new FakeClickHouse();
    const listener = adapterFor(clickhouse, { pollIntervalMs: 50 });
    const writer = adapterFor(clickhouse);
    const seen: (StoredValue | null)[] = [];
    const stop =
      listener.subscribe?.('k', (stored) => seen.push(stored)) ??
      (() => undefined);
    await tick(150);
    const written = expectOk(await writer.set('k', 'v', { signal }));
    await eventually(() => seen.length === 1, 'the write');
    expectOk(await removeKey(writer, 'k'));
    await eventually(() => seen.length === 2, 'the removal');
    for (let index = 0; index < 5; index += 1) {
      expectOk(await listener.set('own', String(index), { signal }));
    }
    stop();
    assert.deepEqual(seen, [written, null]);

    const own: (StoredValue | null)[] = [];
    const stopOwn =
      listener.subscribe?.('own2', (stored) => own.push(stored)) ??
      (() => undefined);
    await tick(150);
    for (let index = 0; index < 5; index += 1) {
      expectOk(await listener.set('own2', String(index), { signal }));
    }
    await tick(200);
    stopOwn();
    assert.deepEqual(
      own.map((stored) => stored?.value),
      ['0', '1', '2', '3', '4']
    );
  });

  void it('reports poll failures once per run through onPollError, naming the table', async () => {
    const clickhouse = new FakeClickHouse();
    const messages: string[] = [];
    const adapter = adapterFor(clickhouse, {
      pollIntervalMs: 50,
      onPollError: (message) => messages.push(message),
    });
    const stop = adapter.subscribe?.('k', () => undefined) ?? (() => undefined);
    await tick(100);
    for (let index = 0; index < 6; index += 1) {
      clickhouse.failures.push({ status: 503, body: 'down' });
    }
    await eventually(() => messages.length >= 1, 'a poll failure');
    stop();
    assert.equal(messages.length, 1);
    assert.match(
      messages[0] ?? '',
      /table "storage_entry" in database "default"/
    );
  });
});
