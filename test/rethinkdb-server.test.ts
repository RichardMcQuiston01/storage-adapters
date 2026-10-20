/**
 * The RethinkDB adapter against a real RethinkDB server, through `rethinkdb-ts`.
 * Skipped unless a host is named:
 *
 *   TEST_RETHINKDB_HOST=127.0.0.1
 *   TEST_RETHINKDB_PORT=28015        (the default)
 *   TEST_RETHINKDB_USER / TEST_RETHINKDB_PASSWORD   (if the server needs a login)
 *
 * Each test uses a table of its own in the `test` database, which it drops afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { r, type Connection } from 'rethinkdb-ts';

import {
  rethinkDbAdapter,
  type ReqlBuilderLike,
  type RethinkDbAdapterOptions,
} from '../src/rethinkdb/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;
const DATABASE = 'test';

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

const host: string | undefined = process.env.TEST_RETHINKDB_HOST;
if (host === undefined || host === '') {
  void describe('rethinkDbAdapter on a RethinkDB server', () => {
    void it(
      'is skipped: set TEST_RETHINKDB_HOST to run it',
      { skip: true },
      () => {
        // Nothing to run without a server.
      }
    );
  });
} else {
  // `rethinkdb-ts`'s `r` fits the adapter as it is.
  const builder: ReqlBuilderLike = r;
  let connection: Connection;

  before(async () => {
    const user: string | undefined = process.env.TEST_RETHINKDB_USER;
    connection = await r.connect({
      host,
      port: Number(process.env.TEST_RETHINKDB_PORT ?? '28015'),
      ...(user === undefined
        ? {}
        : { user, password: process.env.TEST_RETHINKDB_PASSWORD ?? '' }),
    });
  });
  after(async () => {
    await connection.close();
  });

  const freshTable = (): string => `t_${randomBytes(6).toString('hex')}`;
  const dropTable = async (table: string): Promise<void> => {
    try {
      await r.db(DATABASE).tableDrop(table).run(connection);
    } catch {
      // The test may never have created it.
    }
  };
  const adapterFor = (
    table: string,
    more: Partial<RethinkDbAdapterOptions> = {}
  ): StorageAdapter =>
    rethinkDbAdapter({
      r: builder,
      connection,
      db: DATABASE,
      table,
      ...more,
    });

  runConformance('rethinkDbAdapter on a RethinkDB server', {
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

  void describe('rethinkDbAdapter on a RethinkDB server: beyond the contract', () => {
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
        expectOk(
          (await adapter.remove?.('a', { signal })) ?? { ok: true, value: null }
        );
        assert.equal(
          expectOk(await adapter.set('a', 'again', { signal })).revision,
          '1'
        );
      });
    });

    void it('keeps the document readable in ReQL, with both timestamps', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(await adapter.set('theme', 'dark', { signal }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expectOk(await adapter.set('theme', 'light', { signal }));
        const doc = (await r
          .db(DATABASE)
          .table(table)
          .get('theme')
          .run(connection)) as Record<string, unknown>;
        assert.equal(doc.id, 'theme');
        assert.equal(doc.value, 'light');
        assert.equal(doc.revision, 2);
        assert.ok(
          doc.created_at instanceof Date && doc.updated_at instanceof Date
        );
        assert.ok(doc.updated_at.getTime() > doc.created_at.getTime());
      });
    });

    void it('lets exactly one of many writers holding the same revision win', async () => {
      await withTable(async (table) => {
        const adapters: StorageAdapter[] = Array.from({ length: 8 }, () =>
          adapterFor(table)
        );
        const seeded = expectOk(
          (await adapters[0]?.set('k', 'start', { signal })) ?? {
            ok: true,
            value: { value: '', revision: '' },
          }
        );
        const results = await Promise.all(
          adapters.map((adapter, index) =>
            adapter.set('k', `writer ${String(index)}`, {
              signal,
              ifRevision: seeded.revision as string,
            })
          )
        );
        assert.equal(results.filter((result) => result.ok).length, 1);
        for (const result of results) {
          if (!result.ok) {
            assert.equal(result.code, 'conflict');
            assert.match(
              result.error,
              /holds revision 2, but revision 1 was expected/
            );
          }
        }
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
        // Create the table first: processes that all create it at once can leave
        // RethinkDB with two tables of the same name.
        expectOk(
          (await adapters[0]?.set('warm-up', 'creates the table', {
            signal,
          })) ?? {
            ok: true,
            value: { value: '' },
          }
        );
        const write = async (adapter: StorageAdapter): Promise<void> => {
          for (let done = 0; done < 15; done += 1) {
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
          '45'
        );
      });
    });

    void it('creates a key once when several adapters write it for the first time', async () => {
      await withTable(async (table) => {
        const adapters: StorageAdapter[] = Array.from({ length: 6 }, () =>
          adapterFor(table)
        );
        // Create the table first: processes that all create it at once can leave
        // RethinkDB with two tables of the same name.
        expectOk(
          (await adapters[0]?.set('warm-up', 'creates the table', {
            signal,
          })) ?? {
            ok: true,
            value: { value: '' },
          }
        );
        const results = await Promise.all(
          adapters.map((adapter, index) =>
            adapter.set('fresh', `writer ${String(index)}`, { signal })
          )
        );
        for (const result of results) {
          expectOk(result);
        }
        const count = await r
          .db(DATABASE)
          .table(table)
          .filter({ id: 'fresh' })
          .count()
          .run(connection);
        assert.equal(count, 1);
        assert.equal(
          expectOk(
            (await adapters[0]?.get('fresh', { signal })) ?? {
              ok: true,
              value: null,
            }
          )?.revision,
          '6'
        );
      });
    });

    void it('keeps the value exactly, including emoji, newlines, quotes and a 5 MB value', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        for (const value of [
          'line one\nline two 😀 é\t"quoted" \\ back',
          'carriage\r\nreturns\rand\nnewlines\n\n',
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

    void it('stores awkward keys, including the longest allowed, and lists them under a prefix', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        const keys = [
          'user/1',
          'user/2 é',
          'users',
          'a b?#&=%',
          '😀',
          '😀😀',
          "it's",
          'say "hi"',
          'new\nline',
          '${nope}',
          'k'.repeat(127),
          '😀'.repeat(31),
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
        assert.deepEqual(
          await list('😀'),
          ['😀', '😀'.repeat(31), '😀😀'].sort()
        );
        assert.deepEqual(await list(''), [...keys].sort());
      });
    });

    void it('stores the empty key', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(await adapter.set('', 'empty', { signal }));
        assert.equal(
          expectOk(await adapter.get('', { signal }))?.value,
          'empty'
        );
        assert.deepEqual(
          expectOk(
            (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
          ),
          ['']
        );
      });
    });

    void it('refuses a key over 127 bytes, naming the key', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        const long: string = 'k'.repeat(128);
        const result = await adapter.set(long, 'v', { signal });
        assert.ok(!result.ok);
        assert.equal(result.code, 'invalid');
        assert.ok(result.error.includes('127'), result.error);
      });
    });

    void it('lists many keys', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(await adapter.set('warm-up', 'creates the table', { signal }));
        const docs = Array.from({ length: 2150 }, (_, index) => ({
          id: `n${String(index).padStart(5, '0')}`,
          value: 'v',
          revision: 1,
        }));
        await r.db(DATABASE).table(table).insert(docs).run(connection);
        const listed = expectOk(
          (await adapter.list?.('n', { signal })) ?? { ok: true, value: [] }
        );
        assert.deepEqual(
          listed,
          docs.map((doc) => doc.id)
        );
      });
    });

    void it('hears writes and removals made through another adapter, through the changefeed', async () => {
      await withTable(async (table) => {
        const listener = adapterFor(table);
        const writer = adapterFor(table);
        expectOk(await writer.set('other', 'warm-up', { signal }));
        const seen: (StoredValue | null)[] = [];
        const stop =
          listener.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 500));
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

    void it('tells a subscriber about its own writes once', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(await adapter.set('other', 'warm-up', { signal }));
        const seen: (StoredValue | null)[] = [];
        const stop =
          adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 500));
        for (let index = 0; index < 8; index += 1) {
          expectOk(await adapter.set('k', `v${String(index)}`, { signal }));
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        stop();
        assert.deepEqual(
          seen.map((stored) => stored?.value),
          Array.from({ length: 8 }, (_, index) => `v${String(index)}`)
        );
      });
    });

    void it('reports a document that is not an entry as corrupt, and lets a remove clear it', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(await adapter.set('warm-up', 'creates the table', { signal }));
        for (const doc of [
          { id: 'k', value: 'no revision' },
          { id: 'k', value: 'text revision', revision: 'five' },
        ]) {
          await r.db(DATABASE).table(table).insert(doc).run(connection);
          for (const result of [
            await adapter.get('k', { signal }),
            await adapter.set('k', 'v', { signal }),
          ]) {
            assert.ok(!result.ok, JSON.stringify(doc));
            assert.equal(result.code, 'corrupt', JSON.stringify(doc));
            assert.ok(result.error.includes('"k"'), result.error);
          }
          expectOk(
            (await adapter.remove?.('k', { signal })) ?? {
              ok: true,
              value: null,
            }
          );
          assert.equal(
            expectOk(await adapter.set('k', 'v', { signal })).revision,
            '1'
          );
          expectOk(
            (await adapter.remove?.('k', { signal })) ?? {
              ok: true,
              value: null,
            }
          );
        }
      });
    });

    void it('says so when the table does not exist and it may not create one', async () => {
      const adapter = adapterFor(freshTable(), { createTable: false });
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.equal(result.code, 'unavailable');
      assert.ok(result.error.includes('"k"'), result.error);
      assert.match(result.error, /does not exist/);
    });

    void it('says so when the database does not exist', async () => {
      const adapter = adapterFor(freshTable(), {
        db: 'no_such_database',
        createTable: false,
      });
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.equal(result.code, 'unavailable');
      assert.match(result.error, /does not exist/);
    });
  });
}
