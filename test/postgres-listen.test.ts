/**
 * The Postgres adapter's `listener` option, against a real PostgreSQL server (it needs
 * `LISTEN`/`NOTIFY`, which PGlite does not offer through this interface). Skipped unless
 * TEST_POSTGRES_URL is set. Every test gets its own table and drops it afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';

import pg from 'pg';

import {
  postgresAdapter,
  type PostgresListenClientLike,
} from '../src/postgres/index.js';
import type { StorageAdapter, StoredValue } from '../src/storage.js';

const signal: AbortSignal = new AbortController().signal;
const postgresUrl: string | undefined = process.env.TEST_POSTGRES_URL;

const freshTable = (): string =>
  `test_listen_${randomBytes(6).toString('hex')}`;
const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Waits until `check` passes, for notifications, which arrive a moment later. */
async function eventually(
  check: () => boolean,
  describeWait: string
): Promise<void> {
  const deadline: number = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${describeWait}`);
    }
    await pause(20);
  }
}

if (postgresUrl === undefined || postgresUrl === '') {
  void describe('postgresAdapter listening for other processes', () => {
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
  const clients: pg.Client[] = [];
  after(async () => {
    for (const client of clients) {
      await client.end();
    }
    await pool.end();
  });

  const listenerClient = async (): Promise<pg.Client> => {
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    clients.push(client);
    return client;
  };

  /** Runs a test with a table, a listening adapter, and a plain adapter as "another process". */
  async function withTable(
    test: (setup: {
      table: string;
      listening: StorageAdapter;
      other: StorageAdapter;
      problems: string[];
      listener: pg.Client;
    }) => Promise<void>
  ): Promise<void> {
    const table: string = freshTable();
    const problems: string[] = [];
    const listener: pg.Client = await listenerClient();
    try {
      await test({
        table,
        listener,
        problems,
        listening: postgresAdapter({
          client: pool,
          table,
          listener,
          onListenError: (message) => problems.push(message),
        }),
        other: postgresAdapter({ client: pool, table }),
      });
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      await pool.query(`DROP FUNCTION IF EXISTS ${table}_notify() CASCADE`);
    }
  }

  const collect = (
    adapter: StorageAdapter,
    key: string
  ): { heard: (StoredValue | null)[]; stop: () => void } => {
    const heard: (StoredValue | null)[] = [];
    const stop = adapter.subscribe?.(key, (stored) => heard.push(stored));
    return { heard, stop: stop ?? ((): void => undefined) };
  };

  void describe('postgresAdapter listening for other processes', () => {
    void it('hears a write another connection made, once, and not what was there already', async () => {
      await withTable(async ({ listening, other, problems }) => {
        assert.ok((await other.set('k', 'before', { signal })).ok);
        const { heard, stop } = collect(listening, 'k');
        await pause(500);
        assert.deepEqual(heard, [], 'the starting value is not a change');
        assert.ok((await other.set('k', 'one', { signal })).ok);
        await eventually(() => heard.length >= 1, 'the first change');
        assert.ok((await other.set('k', 'two', { signal })).ok);
        await eventually(() => heard.length >= 2, 'the second change');
        assert.ok((await other.remove?.('k', { signal }))?.ok);
        await eventually(() => heard.length >= 3, 'the removal');
        stop();
        await pause(300);
        assert.deepEqual(heard, [
          { value: 'one', revision: '2' },
          { value: 'two', revision: '3' },
          null,
        ]);
        assert.deepEqual(problems, []);
      });
    });

    void it('hears changes made with plain SQL', async () => {
      await withTable(async ({ table, listening, other }) => {
        assert.ok((await other.set('k', 'v', { signal })).ok);
        const { heard, stop } = collect(listening, 'k');
        await pause(500);
        await pool.query(
          `UPDATE ${table} SET entry_value = 'by sql', revision = revision + 1 WHERE entry_key = 'k'`
        );
        await eventually(() => heard.length >= 1, 'the update');
        await pool.query(`DELETE FROM ${table} WHERE entry_key = 'k'`);
        await eventually(() => heard.length >= 2, 'the delete');
        stop();
        assert.deepEqual(heard, [{ value: 'by sql', revision: '2' }, null]);
      });
    });

    void it('tells a subscriber about its own write once', async () => {
      await withTable(async ({ listening }) => {
        const { heard, stop } = collect(listening, 'mine');
        await pause(500);
        assert.ok((await listening.set('mine', 'v', { signal })).ok);
        await pause(600);
        stop();
        assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
      });
    });

    void it('only tells subscribers about their own key', async () => {
      await withTable(async ({ listening, other }) => {
        const first = collect(listening, 'a');
        const second = collect(listening, 'b');
        await pause(500);
        assert.ok((await other.set('b', 'v', { signal })).ok);
        await eventually(() => second.heard.length >= 1, 'the change to b');
        await pause(200);
        first.stop();
        second.stop();
        assert.deepEqual(first.heard, []);
        assert.deepEqual(second.heard, [{ value: 'v', revision: '1' }]);
      });
    });

    void it('still hears a change to a key too long to send in a notification', async () => {
      await withTable(async ({ listening, other }) => {
        const longKey = `long-${'x'.repeat(7500)}`;
        const { heard, stop } = collect(listening, longKey);
        await pause(500);
        assert.ok((await other.set(longKey, 'v', { signal })).ok);
        await eventually(() => heard.length >= 1, 'the change');
        stop();
        assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
      });
    });

    void it('stops listening when the last subscriber leaves, and starts again', async () => {
      await withTable(async ({ listening, other, listener }) => {
        const notifications: string[] = [];
        listener.on('notification', (message) =>
          notifications.push(message.payload ?? '')
        );
        const first = collect(listening, 'k');
        await pause(500);
        first.stop();
        await pause(300);
        assert.ok((await other.set('k', 'unheard', { signal })).ok);
        await pause(300);
        assert.deepEqual(notifications, [], 'UNLISTEN means nothing arrives');
        assert.deepEqual(first.heard, []);
        const second = collect(listening, 'k');
        await pause(500);
        assert.ok((await other.set('k', 'heard', { signal })).ok);
        await eventually(() => second.heard.length >= 1, 'the change');
        second.stop();
        assert.deepEqual(second.heard, [{ value: 'heard', revision: '2' }]);
      });
    });

    void it('says so when listening cannot start, and still reports its own writes', async () => {
      const table: string = freshTable();
      const problems: string[] = [];
      const broken: PostgresListenClientLike = {
        query: () => Promise.reject(new Error('connection terminated')),
        on: () => undefined,
        removeListener: () => undefined,
      };
      const adapter = postgresAdapter({
        client: pool,
        table,
        listener: broken,
        onListenError: (message) => problems.push(message),
      });
      try {
        const { heard, stop } = collect(adapter, 'k');
        await eventually(() => problems.length > 0, 'the failure report');
        assert.ok(problems[0]?.includes(`"${table}"`), problems[0]);
        assert.ok(problems[0]?.includes('connection terminated'), problems[0]);
        assert.ok((await adapter.set('k', 'v', { signal })).ok);
        stop();
        assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
        await pool.query(`DROP FUNCTION IF EXISTS ${table}_notify() CASCADE`);
      }
    });

    void it('reports a table name whose channel is too long', async () => {
      const table = `test_listen_${'x'.repeat(60)}`;
      const problems: string[] = [];
      const listener: pg.Client = await listenerClient();
      const adapter = postgresAdapter({
        client: pool,
        table,
        listener,
        onListenError: (message) => problems.push(message),
      });
      const { stop } = collect(adapter, 'k');
      await eventually(() => problems.length > 0, 'the failure report');
      stop();
      assert.ok(problems[0]?.includes('63 bytes'), problems[0]);
    });
  });
}
