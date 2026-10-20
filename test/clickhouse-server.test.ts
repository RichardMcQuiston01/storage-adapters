/**
 * The ClickHouse adapter against a real ClickHouse server, through `fetch`.
 * Skipped unless a URL is named:
 *
 *   TEST_CLICKHOUSE_URL=http://127.0.0.1:8123
 *   TEST_CLICKHOUSE_USER=default        (if the server needs a login)
 *   TEST_CLICKHOUSE_PASSWORD=...
 *   TEST_CLICKHOUSE_DATABASE=default    (must exist)
 *
 * Each test uses a table of its own, which it drops afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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

const signal: AbortSignal = new AbortController().signal;

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

const url: string | undefined = process.env.TEST_CLICKHOUSE_URL;
if (url === undefined || url === '') {
  void describe('clickHouseAdapter on a ClickHouse server', () => {
    void it(
      'is skipped: set TEST_CLICKHOUSE_URL to run it',
      { skip: true },
      () => {
        // Nothing to run without a server.
      }
    );
  });
} else {
  const baseUrl: string = url.replace(/\/+$/, '');
  const database: string = process.env.TEST_CLICKHOUSE_DATABASE ?? 'default';
  const user: string | undefined = process.env.TEST_CLICKHOUSE_USER;
  const password: string | undefined = process.env.TEST_CLICKHOUSE_PASSWORD;
  const headers: Record<string, string> =
    user === undefined
      ? {}
      : {
          'X-ClickHouse-User': user,
          'X-ClickHouse-Key': password ?? '',
        };

  /** SQL of our own, outside the adapter. Returns the answer text. */
  const sql = async (statement: string): Promise<string> => {
    const response = await fetch(`${baseUrl}/?wait_end_of_query=1`, {
      method: 'POST',
      headers,
      body: statement,
    });
    const text: string = await response.text();
    assert.equal(response.status, 200, text);
    return text;
  };

  const freshTable = (): string => `t_${randomBytes(6).toString('hex')}`;
  const dropTable = async (table: string): Promise<void> => {
    await sql(`DROP TABLE IF EXISTS \`${database}\`.\`${table}\``);
  };

  const adapterFor = (
    table: string,
    more: Partial<ClickHouseAdapterOptions> = {}
  ): StorageAdapter =>
    clickHouseAdapter({
      url: baseUrl,
      fetch,
      database,
      table,
      headers,
      ...more,
    });

  runConformance('clickHouseAdapter on a ClickHouse server', {
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

  void describe('clickHouseAdapter on a ClickHouse server: beyond the contract', () => {
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

    void it('gives every write a higher revision, and get returns what set did', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        let previous = 0n;
        for (let index = 0; index < 40; index += 1) {
          const written = expectOk(
            await adapter.set('k', `v${String(index)}`, { signal })
          );
          assert.ok(BigInt(written.revision as string) > previous);
          previous = BigInt(written.revision as string);
          assert.deepEqual(
            expectOk(await adapter.get('k', { signal })),
            written
          );
        }
      });
    });

    void it('keeps the value exactly, including newlines, NUL, quotes, backslashes, emoji and a 3 MB value', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        for (const value of [
          'line one\nline two 😀 é\t"quoted" \\ back, comma',
          'carriage\r\nreturns\rand\nnewlines\n\n',
          'nul \0 byte \b \f',
          "it's ''' ok",
          '\\n is not a newline, \\\\ is two backslashes\\',
          '{"r":1}',
          '',
          '123',
          '  padded  ',
          'x'.repeat(3_000_000),
        ]) {
          expectOk(await adapter.set('k', value, { signal }));
          assert.equal(
            expectOk(await adapter.get('k', { signal }))?.value,
            value
          );
        }
      });
    });

    void it('refuses a value over the limit, naming the key, and keeps the old value', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(await adapter.set('big', 'small', { signal }));
        const result = await adapter.set('big', 'x'.repeat(4_000_001), {
          signal,
        });
        assert.ok(!result.ok);
        assert.equal(result.code, 'invalid');
        assert.ok(result.error.includes('"big"'), result.error);
        assert.equal(
          expectOk(await adapter.get('big', { signal }))?.value,
          'small'
        );
      });
    });

    void it('stores awkward keys, including an empty one, and lists them under a prefix', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        const keys = [
          'user/1',
          'user/2 é',
          'users',
          'a b,c=d',
          'a b?#&=%',
          '😀',
          "it's",
          'say "hi"',
          '${nope}',
          'back\\slash',
          'new\nline',
          'tab\tkey',
          'nul\0key',
          '%',
          '_',
          'k'.repeat(1000),
        ];
        for (const key of keys) {
          expectOk(await adapter.set(key, key, { signal }));
          assert.equal(
            expectOk(await adapter.get(key, { signal }))?.value,
            key
          );
        }
        expectOk(await adapter.set('', 'empty', { signal }));
        assert.equal(
          expectOk(await adapter.get('', { signal }))?.value,
          'empty'
        );
        const list = async (prefix: string): Promise<readonly string[]> =>
          expectOk(
            (await adapter.list?.(prefix, { signal })) ?? {
              ok: true,
              value: [],
            }
          );
        assert.deepEqual(await list('user/'), ['user/1', 'user/2 é']);
        assert.deepEqual(await list('a b'), ['a b,c=d', 'a b?#&=%']);
        assert.deepEqual(await list('say "'), ['say "hi"']);
        assert.deepEqual(await list('%'), ['%']);
        assert.deepEqual(await list('_'), ['_']);
        assert.deepEqual(await list(''), ['', ...keys].sort());
        expectOk(
          (await adapter.remove?.('new\nline', { signal })) ?? {
            ok: true,
            value: null,
          }
        );
        assert.equal(
          expectOk(await adapter.get('new\nline', { signal })),
          null
        );
        assert.equal((await list('')).length, keys.length);
      });
    });

    void it('refuses a key that is too long, naming the key', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        const result = await adapter.set('k'.repeat(1025), 'v', { signal });
        assert.ok(!result.ok);
        assert.equal(result.code, 'invalid');
        assert.ok(result.error.includes('key'), result.error);
      });
    });

    void it('lists many keys', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(await adapter.set('seed', 'v', { signal }));
        const keys: string[] = [];
        const rows: string[] = [];
        for (let index = 0; index < 5000; index += 1) {
          const key = `n${String(index).padStart(5, '0')}`;
          keys.push(key);
          rows.push(`('${key}', 'v', 1, 'w', 0, now64(3))`);
        }
        await sql(
          `INSERT INTO \`${database}\`.\`${table}\` (entry_key, entry_value, revision, writer, deleted, updated_at) VALUES ${rows.join(', ')}`
        );
        const listed = expectOk(
          (await adapter.list?.('n', { signal })) ?? { ok: true, value: [] }
        );
        assert.deepEqual(listed, keys);
      });
    });

    void it('lets writers sharing an adapter use ifRevision without losing updates', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(await adapter.set('n', '0', { signal }));
        const bump = async (): Promise<void> => {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const current = expectOk(await adapter.get('n', { signal }));
            const result = await adapter.set(
              'n',
              String(Number(current?.value) + 1),
              { signal, ifRevision: current?.revision as string }
            );
            if (result.ok) {
              return;
            }
            assert.equal(result.code, 'conflict');
          }
          assert.fail('never got a turn');
        };
        await Promise.all(Array.from({ length: 12 }, bump));
        assert.equal(expectOk(await adapter.get('n', { signal }))?.value, '12');
      });
    });

    void it('refuses a stale revision, saying which one is held, and keeps the value', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        const first = expectOk(await adapter.set('k', 'one', { signal }));
        const second = expectOk(await adapter.set('k', 'two', { signal }));
        const result = await adapter.set('k', 'three', {
          signal,
          ifRevision: first.revision as string,
        });
        assert.ok(!result.ok);
        assert.equal(result.code, 'conflict');
        assert.ok(result.error.includes('"k"'), result.error);
        assert.ok(result.error.includes(second.revision as string));
        assert.equal(
          expectOk(await adapter.get('k', { signal }))?.value,
          'two'
        );
      });
    });

    void it('creates a key that was removed when given its old revision, and keeps counting up', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        const first = expectOk(await adapter.set('k', 'one', { signal }));
        expectOk(
          (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
        );
        const again = expectOk(
          await adapter.set('k', 'two', {
            signal,
            ifRevision: first.revision as string,
          })
        );
        assert.ok(
          BigInt(again.revision as string) > BigInt(first.revision as string)
        );
      });
    });

    void it('leaves one row marked deleted for a removed key, and none for a key never stored', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table);
        expectOk(
          (await adapter.remove?.('never', { signal })) ?? {
            ok: true,
            value: null,
          }
        );
        expectOk(await adapter.set('k', 'v', { signal }));
        expectOk(
          (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
        );
        expectOk(
          (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
        );
        const rows = await sql(
          `SELECT entry_key, deleted FROM \`${database}\`.\`${table}\` ORDER BY revision FORMAT CSV`
        );
        assert.equal(rows.trim(), '"k",0\n"k",1');
      });
    });

    void it('at most one of two adapters racing on the same revision succeeds, or both are told the truth', async () => {
      await withTable(async (table) => {
        const left = adapterFor(table);
        const right = adapterFor(table);
        for (let round = 0; round < 10; round += 1) {
          const base = expectOk(await left.set('k', 'base', { signal }));
          const results = await Promise.all([
            left.set('k', 'left', {
              signal,
              ifRevision: base.revision as string,
            }),
            right.set('k', 'right', {
              signal,
              ifRevision: base.revision as string,
            }),
          ]);
          const stored = expectOk(await left.get('k', { signal }));
          // Whichever was told it succeeded, the stored value is one of the two.
          assert.ok(['left', 'right'].includes(stored?.value ?? ''));
          for (const result of results) {
            if (result.ok && result.value.value === stored?.value) {
              assert.equal(result.value.revision, stored.revision);
            }
            if (!result.ok) {
              assert.equal(result.code, 'conflict');
            }
          }
          assert.ok(results.some((result) => result.ok));
        }
      });
    });

    void it('hears writes and removals made through another adapter when polling', async () => {
      await withTable(async (table) => {
        const listener = adapterFor(table, { pollIntervalMs: 100 });
        const writer = adapterFor(table);
        expectOk(await writer.set('seed', 'v', { signal }));
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

    void it('tells a polling subscriber about its own writes once', async () => {
      await withTable(async (table) => {
        const adapter = adapterFor(table, { pollIntervalMs: 50 });
        const seen: (StoredValue | null)[] = [];
        const stop =
          adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 200));
        for (let index = 0; index < 8; index += 1) {
          expectOk(await adapter.set('k', `v${String(index)}`, { signal }));
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        stop();
        assert.deepEqual(
          seen.map((stored) => stored?.value),
          Array.from({ length: 8 }, (_, index) => `v${String(index)}`)
        );
      });
    });

    void it('works against a table it did not create when createTable is off', async () => {
      await withTable(async (table) => {
        await sql(
          `CREATE TABLE \`${database}\`.\`${table}\` (entry_key String, entry_value String, revision UInt64, writer String, deleted UInt8, updated_at DateTime64(3)) ENGINE = ReplacingMergeTree(revision) ORDER BY entry_key`
        );
        const adapter = adapterFor(table, { createTable: false });
        expectOk(await adapter.set('k', 'v', { signal }));
        assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'v');
      });
    });

    void it('says so when the table is missing and createTable is off, naming the key', async () => {
      const adapter = adapterFor(freshTable(), { createTable: false });
      for (const result of [
        await adapter.get('k', { signal }),
        await adapter.set('k', 'v', { signal }),
      ]) {
        assert.ok(!result.ok);
        assert.equal(result.code, 'unavailable');
        assert.ok(result.error.includes('"k"'), result.error);
        assert.match(result.error, /exists/);
      }
    });

    void it('says so when the database does not exist, naming the key', async () => {
      const adapter = adapterFor(freshTable(), {
        database: 'no_such_database_here',
      });
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.equal(result.code, 'unavailable');
      assert.ok(result.error.includes('"k"'), result.error);
      assert.match(result.error, /no_such_database_here/);
    });

    void it('refuses a table name that is not an identifier, naming the key', async () => {
      const adapter = adapterFor('bad`; DROP TABLE x; --');
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.equal(result.code, 'invalid');
      assert.ok(result.error.includes('"k"'), result.error);
    });
  });
}
