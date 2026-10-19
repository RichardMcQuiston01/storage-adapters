/**
 * The Cassandra adapter against a real Cassandra node, through `cassandra-driver`.
 * Skipped unless a contact point is named:
 *
 *   TEST_CASSANDRA_CONTACT_POINT=127.0.0.1   (port 9042)
 *   TEST_CASSANDRA_DATACENTER=datacenter1    (the default)
 *
 * The tests create a keyspace called `adapter_test` and, in it, one table per test,
 * which they drop afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Client } from 'cassandra-driver';

import {
  cassandraAdapter,
  type CassandraAdapterOptions,
  type CassandraClientLike,
} from '../src/cassandra/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;
const KEYSPACE = 'adapter_test';

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

/** Waits until a condition holds, or fails after eight seconds. */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const contactPoint: string | undefined =
  process.env.TEST_CASSANDRA_CONTACT_POINT;
if (contactPoint === undefined || contactPoint === '') {
  void describe('cassandraAdapter on a Cassandra node', () => {
    void it(
      'is skipped: set TEST_CASSANDRA_CONTACT_POINT to run it',
      { skip: true },
      () => {
        // Nothing to run without a server.
      }
    );
  });
} else {
  const driver = new Client({
    contactPoints: [contactPoint],
    localDataCenter: process.env.TEST_CASSANDRA_DATACENTER ?? 'datacenter1',
  });
  // A Client fits the adapter as it is.
  const client: CassandraClientLike = driver;

  before(async () => {
    await driver.connect();
    await driver.execute(
      `CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`
    );
  });
  after(async () => {
    await driver.shutdown();
  });

  const freshTable = (): string =>
    `${KEYSPACE}.t_${randomBytes(6).toString('hex')}`;
  const dropTable = async (table: string): Promise<void> => {
    await driver.execute(`DROP TABLE IF EXISTS ${table}`);
  };
  const adapterFor = (
    table: string,
    more: Partial<CassandraAdapterOptions> = {}
  ): StorageAdapter => cassandraAdapter({ client, table, ...more });

  runConformance('cassandraAdapter on a Cassandra node', {
    ownWrites: 'notifies',
    create: () => {
      const table: string = freshTable();
      return {
        adapter: adapterFor(table),
        reopen: () => adapterFor(table),
        cleanup: () => dropTable(table),
      };
    },
  });

  void describe('cassandraAdapter on a Cassandra node: beyond the contract', () => {
    const withTable = async (
      body: (table: string) => Promise<void>
    ): Promise<void> => {
      const table: string = freshTable();
      try {
        await body(table);
      } finally {
        await dropTable(table);
      }
    };

    void it('counts revisions per key from 1, and starts again after a removal', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        assert.equal(
          expectOk(await adapter.set('a', 'x', { signal })).revision,
          '1'
        );
        assert.equal(
          expectOk(await adapter.set('a', 'y', { signal })).revision,
          '2'
        );
        assert.equal(
          expectOk(await adapter.set('b', 'z', { signal })).revision,
          '1'
        );
        assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
          value: 'y',
          revision: '2',
        });
        expectOk(
          (await adapter.remove?.('a', { signal })) ?? { ok: true, value: null }
        );
        assert.equal(
          expectOk(await adapter.set('a', 'again', { signal })).revision,
          '1'
        );
      });
    });

    void it('keeps the row readable in CQL, with both timestamps', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(await adapter.set('theme', 'dark', { signal }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expectOk(await adapter.set('theme', 'light', { signal }));
        const result = await driver.execute(
          `SELECT entry_key, entry_value, revision, created_at, updated_at FROM ${table} WHERE entry_key = ?`,
          ['theme'],
          { prepare: true }
        );
        const row = result.rows[0];
        assert.equal(row?.entry_key, 'theme');
        assert.equal(row?.entry_value, 'light');
        assert.equal(String(row?.revision), '2');
        assert.ok(
          row?.created_at instanceof Date && row.updated_at instanceof Date
        );
        assert.ok(row.updated_at.getTime() > row.created_at.getTime());
      });
    });

    void it('lets only one of two adapters holding the same revision win, and names the winner', async () => {
      await withTable(async (table) => {
        const first = adapterFor(table);
        const second = adapterFor(table);
        const written = expectOk(await first.set('k', 'one', { signal }));
        const results = await Promise.all([
          first.set('k', 'from first', {
            signal,
            ifRevision: written.revision as string,
          }),
          second.set('k', 'from second', {
            signal,
            ifRevision: written.revision as string,
          }),
        ]);
        assert.equal(results.filter((result) => result.ok).length, 1);
        const loser = results.find((result) => !result.ok);
        assert.ok(loser !== undefined && !loser.ok);
        assert.equal(loser.code, 'conflict');
        assert.match(
          loser.error,
          /holds revision 2, but revision 1 was expected/
        );
      });
    });

    void it('loses no update when two adapters count together', async () => {
      await withTable(async (table) => {
        const adapters: StorageAdapter[] = [
          adapterFor(table),
          adapterFor(table),
        ];
        expectOk(
          (await adapters[0]?.set('n', '0', { signal })) ?? {
            ok: true,
            value: { value: '' },
          }
        );
        const bump = async (adapter: StorageAdapter): Promise<void> => {
          for (let done = 0; done < 10;) {
            const current = expectOk(await adapter.get('n', { signal }));
            const next: string = String(Number(current?.value ?? '0') + 1);
            const result = await adapter.set('n', next, {
              signal,
              ...(current?.revision === undefined
                ? {}
                : { ifRevision: current.revision }),
            });
            if (result.ok) {
              done += 1;
            } else {
              assert.equal(result.code, 'conflict');
            }
          }
        };
        await Promise.all(adapters.map(bump));
        const total = expectOk(
          (await adapters[1]?.get('n', { signal })) ?? { ok: true, value: null }
        );
        assert.equal(total?.value, '20');
        assert.equal(total?.revision, '21');
      });
    });

    void it('counts every unconditional write from several adapters', async () => {
      await withTable(async (table) => {
        const adapters: StorageAdapter[] = [
          adapterFor(table),
          adapterFor(table),
          adapterFor(table),
        ];
        const write = async (adapter: StorageAdapter): Promise<void> => {
          for (let done = 0; done < 8; done += 1) {
            expectOk(await adapter.set('k', 'v', { signal }));
          }
        };
        await Promise.all(adapters.map(write));
        assert.equal(
          expectOk(
            (await adapters[0]?.get('k', { signal })) ?? {
              ok: true,
              value: null,
            }
          )?.revision,
          '24'
        );
      });
    });

    void it('keeps the value exactly, including emoji, newlines, quotes and a 5 MB value', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        for (const value of [
          'line one\nline two 😀 é\t"quoted" \\ back',
          '{"r":1}',
          '',
          '123',
          'x'.repeat(5 * 1024 * 1024),
        ]) {
          expectOk(await adapter.set('k', value, { signal }));
          assert.equal(
            expectOk(await adapter.get('k', { signal }))?.value,
            value
          );
        }
      });
    });

    void it('stores awkward keys and lists them under a prefix', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        const keys = [
          'user/1',
          'user/2 é',
          'users',
          'a b?#&=%',
          '😀',
          "it's",
          'k'.repeat(3000),
        ];
        for (const key of keys) {
          expectOk(await adapter.set(key, key, { signal }));
          assert.equal(
            expectOk(await adapter.get(key, { signal }))?.value,
            key
          );
        }
        const list = async (prefix: string): Promise<readonly string[]> =>
          expectOk(
            (await adapter.list?.(prefix, { signal })) ?? {
              ok: true,
              value: [],
            }
          );
        assert.deepEqual(await list('user/'), ['user/1', 'user/2 é']);
        assert.deepEqual(await list(''), [...keys].sort());
      });
    });

    void it('lists every page of a table', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(await adapter.set('warm-up', 'creates the table', { signal }));
        const keys: string[] = [];
        const pending: Promise<unknown>[] = [];
        for (let index = 0; index < 2150; index += 1) {
          const key = `n${String(index).padStart(5, '0')}`;
          keys.push(key);
          pending.push(
            driver.execute(
              `INSERT INTO ${table} (entry_key, entry_value, revision) VALUES (?, ?, ?)`,
              [key, 'v', 1],
              { prepare: true }
            )
          );
          if (pending.length >= 100) {
            await Promise.all(pending.splice(0));
          }
        }
        await Promise.all(pending);
        const listed = expectOk(
          (await adapter.list?.('n', { signal })) ?? { ok: true, value: [] }
        );
        assert.deepEqual(listed, keys);
      });
    });

    void it('hears writes and removals made through another adapter when polling', async () => {
      await withTable(async (table) => {
        const listener = adapterFor(table, { pollIntervalMs: 100 });
        const writer = adapterFor(table);
        expectOk(await writer.set('other', 'warm-up', { signal }));
        const seen: (StoredValue | null)[] = [];
        const stop =
          listener.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 400));
        const written = expectOk(await writer.set('k', 'v', { signal }));
        await eventually(() => seen.length === 1, 'the write');
        expectOk(
          (await writer.remove?.('k', { signal })) ?? { ok: true, value: null }
        );
        await eventually(() => seen.length === 2, 'the removal');
        stop();
        assert.deepEqual(seen, [written, null]);
      });
    });

    void it('reports a row that is not an entry as corrupt, and lets a remove clear it', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(await adapter.set('warm-up', 'creates the table', { signal }));
        await driver.execute(
          `INSERT INTO ${table} (entry_key, entry_value) VALUES (?, ?)`,
          ['k', 'written by something else'],
          { prepare: true }
        );
        for (const result of [
          await adapter.get('k', { signal }),
          await adapter.set('k', 'v', { signal }),
        ]) {
          assert.ok(!result.ok);
          assert.equal(result.code, 'corrupt');
          assert.ok(result.error.includes('"k"'), result.error);
        }
        expectOk(
          (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
        );
        assert.equal(
          expectOk(await adapter.set('k', 'v', { signal })).revision,
          '1'
        );
      });
    });

    void it('refuses an empty key and a value over the request limit, naming the key', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        const empty = await adapter.set('', 'v', { signal });
        assert.ok(!empty.ok);
        assert.equal(empty.code, 'invalid');
        const big = await adapter.set('big', 'x'.repeat(20 * 1024 * 1024), {
          signal,
        });
        assert.ok(!big.ok);
        assert.equal(big.code, 'invalid');
        assert.ok(
          big.error.includes('"big"') && /too big/.test(big.error),
          big.error
        );
        assert.equal(expectOk(await adapter.get('big', { signal })), null);
      });
    });

    void it('says so when the table or keyspace does not exist and it may not create one', async () => {
      const missingTable = adapterFor(`${KEYSPACE}.no_such_table_here`, {
        createTable: false,
      });
      const first = await missingTable.get('k', { signal });
      assert.ok(!first.ok);
      assert.equal(first.code, 'unavailable');
      assert.match(first.error, /does not exist/);
      assert.ok(first.error.includes('"k"'), first.error);
      const missingKeyspace = adapterFor('no_such_keyspace.t', {
        createTable: false,
      });
      const second = await missingKeyspace.set('k', 'v', { signal });
      assert.ok(!second.ok);
      assert.equal(second.code, 'unavailable');
      assert.match(second.error, /does not exist/);
    });

    void it('reads at LOCAL_SERIAL when asked to', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table, { readConsistency: 'localSerial' });
        expectOk(await adapter.set('k', 'v', { signal }));
        assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'v');
      });
    });
  });
}
