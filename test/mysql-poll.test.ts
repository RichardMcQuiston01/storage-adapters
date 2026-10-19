/**
 * The MySQL adapter's `pollIntervalMs` option, against a real MySQL or MariaDB server.
 * Skipped unless TEST_MYSQL_URL is set. Every test gets its own table and drops it.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { createPool, type Pool as MysqlPool } from 'mysql2/promise';

import { mysqlAdapter, type MysqlClientLike } from '../src/mysql/index.js';
import type { StorageAdapter, StoredValue } from '../src/storage.js';

const signal: AbortSignal = new AbortController().signal;
const mysqlUrl: string | undefined = process.env.TEST_MYSQL_URL;

const freshTable = (): string => `test_poll_${randomBytes(6).toString('hex')}`;
const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Waits until `check` passes, for polls, which answer a moment later. */
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

if (mysqlUrl === undefined || mysqlUrl === '') {
  void describe('mysqlAdapter polling for other processes', () => {
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

  /** A client that counts polling queries and can fail or hold them. */
  function watchedClient(): {
    client: MysqlClientLike;
    polls: { count: number };
    control: { failing: boolean; hold: Promise<void> | null };
  } {
    const polls = { count: 0 };
    const control: { failing: boolean; hold: Promise<void> | null } = {
      failing: false,
      hold: null,
    };
    const client: MysqlClientLike = {
      query: async (sql, parameters) => {
        if (!/ IN \(/.test(sql)) {
          return pool.query(sql, parameters);
        }
        polls.count += 1;
        if (control.failing) {
          throw new Error('server has gone away');
        }
        // The answer is read first and then held, so it can be older than a later write.
        const answer = await pool.query(sql, parameters);
        await control.hold;
        return answer;
      },
    };
    return { client, polls, control };
  }

  async function withTable(
    test: (setup: {
      table: string;
      other: StorageAdapter;
      make: (
        extra?: Partial<Parameters<typeof mysqlAdapter>[0]>
      ) => StorageAdapter;
    }) => Promise<void>
  ): Promise<void> {
    const table: string = freshTable();
    try {
      await test({
        table,
        other: mysqlAdapter({ client: pool, table }),
        make: (extra = {}) =>
          mysqlAdapter({ client: pool, table, pollIntervalMs: 60, ...extra }),
      });
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
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

  void describe('mysqlAdapter polling for other processes', () => {
    void it('hears a write another connection made, once, and not what was there already', async () => {
      await withTable(async ({ other, make }) => {
        assert.ok((await other.set('k', 'before', { signal })).ok);
        const { heard, stop } = collect(make(), 'k');
        await pause(300);
        assert.deepEqual(heard, [], 'the starting value is not a change');
        assert.ok((await other.set('k', 'one', { signal })).ok);
        await eventually(() => heard.length >= 1, 'the first change');
        assert.ok((await other.set('k', 'two', { signal })).ok);
        await eventually(() => heard.length >= 2, 'the second change');
        assert.ok((await other.remove?.('k', { signal }))?.ok);
        await eventually(() => heard.length >= 3, 'the removal');
        stop();
        await pause(200);
        assert.deepEqual(heard, [
          { value: 'one', revision: '2' },
          { value: 'two', revision: '3' },
          null,
        ]);
      });
    });

    void it('hears changes made with plain SQL', async () => {
      await withTable(async ({ table, other, make }) => {
        assert.ok((await other.set('k', 'v', { signal })).ok);
        const { heard, stop } = collect(make(), 'k');
        await pause(300);
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
      await withTable(async ({ make }) => {
        const adapter = make();
        const { heard, stop } = collect(adapter, 'mine');
        await pause(300);
        assert.ok((await adapter.set('mine', 'v', { signal })).ok);
        await pause(400);
        stop();
        assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
      });
    });

    void it('hears a key removed and made again with the same revision', async () => {
      await withTable(async ({ table, other, make }) => {
        assert.ok((await other.set('k', 'first', { signal })).ok);
        const { heard, stop } = collect(make({ pollIntervalMs: 400 }), 'k');
        await pause(600);
        // Both steps happen between two polls, and the revision is 1 before and after.
        await pool.query(`DELETE FROM ${table} WHERE entry_key = 'k'`);
        assert.ok((await other.set('k', 'second', { signal })).ok);
        await eventually(() => heard.length >= 1, 'the new value');
        stop();
        assert.deepEqual(heard, [{ value: 'second', revision: '1' }]);
      });
    });

    void it('only tells subscribers about their own key, and watches many keys', async () => {
      await withTable(async ({ other, make }) => {
        const adapter = make();
        const keys = Array.from({ length: 250 }, (_, index) => `key-${index}`);
        const listening = keys.map((key) => collect(adapter, key));
        await pause(400);
        assert.ok((await other.set('key-7', 'v7', { signal })).ok);
        assert.ok((await other.set('key-240', 'v240', { signal })).ok);
        assert.ok((await other.set('unwatched', 'x', { signal })).ok);
        await eventually(
          () =>
            (listening[7]?.heard.length ?? 0) >= 1 &&
            (listening[240]?.heard.length ?? 0) >= 1,
          'both changes'
        );
        for (const each of listening) {
          each.stop();
        }
        assert.deepEqual(listening[7]?.heard, [{ value: 'v7', revision: '1' }]);
        assert.deepEqual(listening[240]?.heard, [
          { value: 'v240', revision: '1' },
        ]);
        const quiet = listening.filter(
          (_, index) => index !== 7 && index !== 240
        );
        assert.ok(quiet.every((each) => each.heard.length === 0));
      });
    });

    void it('queries only while something is subscribed, and starts again', async () => {
      await withTable(async ({ other, make }) => {
        const watched = watchedClient();
        const adapter = make({ client: watched.client });
        const first = collect(adapter, 'k');
        await pause(300);
        first.stop();
        await pause(150);
        const after = watched.polls.count;
        assert.ok(after > 0, 'it polled while subscribed');
        await pause(400);
        assert.equal(
          watched.polls.count,
          after,
          'it stopped after unsubscribe'
        );
        const second = collect(adapter, 'k');
        await pause(300);
        assert.ok((await other.set('k', 'again', { signal })).ok);
        await eventually(() => second.heard.length >= 1, 'the change');
        second.stop();
        assert.deepEqual(second.heard, [{ value: 'again', revision: '1' }]);
      });
    });

    void it('does not poll at all without pollIntervalMs', async () => {
      await withTable(async ({ table, other }) => {
        const watched = watchedClient();
        const adapter = mysqlAdapter({ client: watched.client, table });
        const { heard, stop } = collect(adapter, 'k');
        await pause(300);
        assert.ok((await other.set('k', 'v', { signal })).ok);
        await pause(300);
        stop();
        assert.equal(watched.polls.count, 0);
        assert.deepEqual(heard, []);
      });
    });

    void it('reports a failing poll once, keeps going, and recovers', async () => {
      await withTable(async ({ other, make }) => {
        const watched = watchedClient();
        const problems: string[] = [];
        const adapter = make({
          client: watched.client,
          onPollError: (message) => problems.push(message),
        });
        const { heard, stop } = collect(adapter, 'k');
        await pause(300);
        watched.control.failing = true;
        await eventually(() => problems.length >= 1, 'the failure report');
        await pause(300);
        assert.equal(problems.length, 1, 'one report for a run of failures');
        assert.ok(problems[0]?.includes('server has gone away'), problems[0]);
        assert.ok(problems[0]?.includes('test_poll_'), problems[0]);
        watched.control.failing = false;
        assert.ok((await other.set('k', 'back', { signal })).ok);
        await eventually(() => heard.length >= 1, 'the change after recovery');
        watched.control.failing = true;
        await eventually(() => problems.length >= 2, 'a second report');
        stop();
        assert.deepEqual(heard, [{ value: 'back', revision: '1' }]);
      });
    });

    void it('does not report an older answer after its own newer write', async () => {
      await withTable(async ({ make }) => {
        const watched = watchedClient();
        const adapter = make({ client: watched.client });
        const { heard, stop } = collect(adapter, 'k');
        await pause(300);
        // Hold the next poll's answer back, which was read before the write below.
        let release: (() => void) | null = null;
        watched.control.hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const before = watched.polls.count;
        await eventually(() => watched.polls.count > before, 'a poll to start');
        assert.ok((await adapter.set('k', 'mine', { signal })).ok);
        (release as (() => void) | null)?.();
        watched.control.hold = null;
        await pause(400);
        stop();
        assert.deepEqual(heard, [{ value: 'mine', revision: '1' }]);
      });
    });

    void it('treats a pollIntervalMs that is not a positive number as off', async () => {
      await withTable(async ({ table, other }) => {
        for (const pollIntervalMs of [0, -5, Number.NaN]) {
          const watched = watchedClient();
          const adapter = mysqlAdapter({
            client: watched.client,
            table,
            pollIntervalMs,
          });
          const { stop } = collect(adapter, 'k');
          await pause(150);
          stop();
          assert.equal(watched.polls.count, 0, String(pollIntervalMs));
        }
        assert.ok((await other.set('k', 'v', { signal })).ok);
      });
    });
  });
}
