/**
 * The adapter contract against real database servers. PGlite (PostgreSQL compiled
 * to WebAssembly) always runs, so the default test run stays offline. A real
 * PostgreSQL or MySQL server is used only when its connection string is set:
 *
 *   TEST_POSTGRES_URL=postgres://user:password@localhost:5432/adapters
 *   TEST_MYSQL_URL=mysql://user:password@localhost:3306/adapters
 *
 * Every test gets its own table and drops it afterwards.
 */
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { createPool, type Pool as MysqlPool } from 'mysql2/promise';
import pg from 'pg';

import { mysqlAdapter, type MysqlClientLike } from '../src/mysql/index.js';
import {
  postgresAdapter,
  type PostgresClientLike,
} from '../src/postgres/index.js';
import type { StorageAdapter } from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;

/**
 * Two adapters on one table, each adding to one shared counter with
 * compare-and-set, retrying when told `conflict`. If the check and the write were
 * not atomic, increments would be lost and the total would come out short.
 */
async function countTogether(
  first: StorageAdapter,
  second: StorageAdapter,
  perWriter: number
): Promise<number> {
  const add = async (adapter: StorageAdapter): Promise<void> => {
    for (let done = 0; done < perWriter;) {
      const read = await adapter.get('counter', { signal });
      assert.ok(read.ok, JSON.stringify(read));
      const current: number = Number(read.value?.value ?? '0');
      const written = await adapter.set('counter', String(current + 1), {
        signal,
        ...(read.value?.revision === undefined
          ? {}
          : { ifRevision: read.value.revision }),
      });
      if (written.ok) {
        done += 1;
      } else {
        assert.equal(written.code, 'conflict', JSON.stringify(written));
      }
    }
  };
  // Start from a stored value: with nothing stored there is no revision to check,
  // so the first write of each side would be a plain overwrite, not a compare-and-set.
  assert.ok((await first.set('counter', '0', { signal })).ok);
  await Promise.all([add(first), add(second)]);
  const total = await first.get('counter', { signal });
  assert.ok(total.ok, JSON.stringify(total));
  return Number(total.value?.value);
}

/** Keys that differ only in case, spacing or by an emoji must stay different keys. */
async function keepsLookAlikeKeysApart(adapter: StorageAdapter): Promise<void> {
  const keys: readonly string[] = [
    'a',
    'A',
    'a ',
    ' a',
    'caf\u00e9',
    'cafe\u0301',
    '\u{1F600}',
  ];
  for (const key of keys) {
    const written = await adapter.set(key, `value of ${JSON.stringify(key)}`, {
      signal,
    });
    assert.ok(written.ok, JSON.stringify(written));
  }
  for (const key of keys) {
    const read = await adapter.get(key, { signal });
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.value?.value, `value of ${JSON.stringify(key)}`);
  }
}

/** A table name that is new for each test. */
function freshTable(): string {
  return `storage_entry_${randomBytes(6).toString('hex')}`;
}

// Starting PGlite takes seconds, so every test shares one and gets its own table.
const pglite = new PGlite();
after(() => pglite.close());

runConformance('postgresAdapter on PGlite', {
  ownWrites: 'notifies',
  create: async () => {
    await pglite.waitReady;
    const client: PostgresClientLike = pglite;
    const table: string = freshTable();
    return {
      adapter: postgresAdapter({ client, table }),
      reopen: () => postgresAdapter({ client, table }),
      cleanup: async () => {
        await pglite.query(`DROP TABLE IF EXISTS ${table}`);
      },
    };
  },
});

const postgresUrl: string | undefined = process.env.TEST_POSTGRES_URL;
if (postgresUrl === undefined || postgresUrl === '') {
  void describe('postgresAdapter on a PostgreSQL server', () => {
    void it(
      'is skipped: set TEST_POSTGRES_URL to run it',
      { skip: true },
      () => {
        // Nothing to run without a server.
      }
    );
  });
} else {
  const pool = new pg.Pool({ connectionString: postgresUrl, max: 8 });
  after(() => pool.end());
  runConformance('postgresAdapter on a PostgreSQL server', {
    ownWrites: 'notifies',
    create: () => {
      const client: PostgresClientLike = pool;
      const table: string = freshTable();
      return {
        adapter: postgresAdapter({ client, table }),
        reopen: () => postgresAdapter({ client, table }),
        cleanup: async () => {
          await pool.query(`DROP TABLE IF EXISTS ${table}`);
        },
      };
    },
  });

  void describe('postgresAdapter on a PostgreSQL server: beyond the contract', () => {
    void it('loses no update when two adapters count together', async () => {
      const table: string = freshTable();
      try {
        const first = postgresAdapter({ client: pool, table });
        const second = postgresAdapter({ client: pool, table });
        assert.equal(await countTogether(first, second, 25), 50);
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
      }
    });

    void it('keeps look-alike keys apart', async () => {
      const table: string = freshTable();
      try {
        await keepsLookAlikeKeysApart(postgresAdapter({ client: pool, table }));
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
      }
    });

    void it('stores a UUID id and both timestamps', async () => {
      const table: string = freshTable();
      try {
        await postgresAdapter({ client: pool, table }).set('k', 'v', {
          signal,
        });
        const result = await pool.query(
          `SELECT storage_entry_id::text AS id, created_at, updated_at FROM ${table}`
        );
        const row = result.rows[0] as {
          id: string;
          created_at: Date;
          updated_at: Date;
        };
        assert.match(
          row.id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
        assert.ok(
          row.created_at instanceof Date && row.updated_at instanceof Date
        );
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
      }
    });
  });
}

const mysqlUrl: string | undefined = process.env.TEST_MYSQL_URL;
if (mysqlUrl === undefined || mysqlUrl === '') {
  void describe('mysqlAdapter on a MySQL server', () => {
    void it('is skipped: set TEST_MYSQL_URL to run it', { skip: true }, () => {
      // Nothing to run without a server.
    });
  });
} else {
  const pool: MysqlPool = createPool({
    uri: mysqlUrl,
    connectionLimit: 8,
    charset: 'utf8mb4',
  });
  after(() => pool.end());
  runConformance('mysqlAdapter on a MySQL server', {
    ownWrites: 'notifies',
    create: () => {
      const client: MysqlClientLike = pool;
      const table: string = freshTable();
      return {
        adapter: mysqlAdapter({ client, table }),
        reopen: () => mysqlAdapter({ client, table }),
        cleanup: async () => {
          await pool.query(`DROP TABLE IF EXISTS ${table}`);
        },
      };
    },
  });

  void describe('mysqlAdapter on a MySQL server: beyond the contract', () => {
    void it('loses no update when two adapters count together', async () => {
      const table: string = freshTable();
      try {
        const first = mysqlAdapter({ client: pool, table });
        const second = mysqlAdapter({ client: pool, table });
        assert.equal(await countTogether(first, second, 25), 50);
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
      }
    });

    void it('keeps look-alike keys apart, including case and trailing spaces', async () => {
      const table: string = freshTable();
      try {
        await keepsLookAlikeKeysApart(mysqlAdapter({ client: pool, table }));
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
      }
    });

    void it('stores a UUID id and both timestamps', async () => {
      const table: string = freshTable();
      try {
        await mysqlAdapter({ client: pool, table }).set('k', 'v', { signal });
        const [rows] = await pool.query(
          `SELECT storage_entry_id AS id, created_at, updated_at FROM ${table}`
        );
        const row = (
          rows as { id: string; created_at: Date; updated_at: Date }[]
        )[0];
        assert.match(
          row?.id ?? '',
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
        assert.ok(
          row?.created_at instanceof Date && row.updated_at instanceof Date
        );
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
      }
    });

    void it('accepts the longest key and refuses one byte more', async () => {
      const table: string = freshTable();
      try {
        const adapter = mysqlAdapter({ client: pool, table });
        const longest: string = 'k'.repeat(1024);
        assert.ok((await adapter.set(longest, 'v', { signal })).ok);
        const read = await adapter.get(longest, { signal });
        assert.ok(read.ok && read.value?.value === 'v');
        const tooLong = await adapter.set(`${longest}k`, 'v', { signal });
        assert.ok(!tooLong.ok && tooLong.code === 'invalid');
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
      }
    });
  });
}
