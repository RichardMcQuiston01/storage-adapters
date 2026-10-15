import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  sqliteAdapter,
  type SqliteDatabaseLike,
  type SqliteStatementLike,
} from '../src/sqlite/index.js';
import type { StoredValue, StoreResult } from '../src/storage.js';

const signal: AbortSignal = new AbortController().signal;

function memoryDatabase(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

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
): void {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  assert.ok(
    result.error.includes(`"${key}"`),
    `error should name the key: ${result.error}`
  );
}

/** An error shaped like the ones `node:sqlite` and `bun:sqlite` throw. */
function sqliteError(message: string, errcode: number): Error {
  return Object.assign(new Error(message), { errcode });
}

/** A database that throws `error` from every `prepare`, after `exec` succeeds. */
function failingDatabase(error: Error): SqliteDatabaseLike {
  return {
    exec: () => undefined,
    prepare: (): SqliteStatementLike => ({
      run: () => {
        throw error;
      },
      get: () => {
        throw error;
      },
    }),
  };
}

void describe('sqliteAdapter', () => {
  void it('returns null for a missing key', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('stores a value and counts revisions up', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    assert.deepEqual(expectOk(await adapter.set('a', 'one', { signal })), {
      value: 'one',
      revision: '1',
    });
    assert.deepEqual(expectOk(await adapter.set('a', 'two', { signal })), {
      value: 'two',
      revision: '2',
    });
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
      value: 'two',
      revision: '2',
    });
  });

  void it('round-trips quotes, unicode and SQL-looking text unchanged', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    const key = `it's "a" key; DROP TABLE storage_entry;--`;
    const value = `{"name":"Zoë","note":"it's 日本語 \\ ' \\" ; --"}`;
    expectOk(await adapter.set(key, value, { signal }));
    assert.deepEqual(expectOk(await adapter.get(key, { signal })), {
      value,
      revision: '1',
    });
  });

  void it('keeps keys apart', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    expectOk(await adapter.set('a', 'A', { signal }));
    expectOk(await adapter.set('b', 'B', { signal }));
    assert.equal(expectOk(await adapter.get('a', { signal }))?.value, 'A');
    assert.equal(expectOk(await adapter.get('b', { signal }))?.value, 'B');
  });

  void it('keeps data between adapters on the same database', async () => {
    const database = memoryDatabase();
    expectOk(await sqliteAdapter({ database }).set('a', 'kept', { signal }));
    assert.deepEqual(
      expectOk(await sqliteAdapter({ database }).get('a', { signal })),
      { value: 'kept', revision: '1' }
    );
  });

  void it('reports a conflict for a stale ifRevision and keeps the value', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    expectOk(await adapter.set('a', 'one', { signal }));
    expectFailure(
      await adapter.set('a', 'two', { signal, ifRevision: '9' }),
      'conflict',
      'a'
    );
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
      value: 'one',
      revision: '1',
    });
  });

  void it('names both revisions in a conflict', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    expectOk(await adapter.set('a', 'one', { signal }));
    const result = await adapter.set('a', 'two', { signal, ifRevision: '9' });
    assert.ok(!result.ok);
    assert.match(result.error, /holds revision 1, but revision 9 was expected/);
  });

  void it('writes when ifRevision matches, or when nothing is stored', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    assert.equal(
      expectOk(await adapter.set('a', 'one', { signal, ifRevision: '5' }))
        .revision,
      '1'
    );
    assert.equal(
      expectOk(await adapter.set('a', 'two', { signal, ifRevision: '1' }))
        .revision,
      '2'
    );
  });

  void it('overwrites without ifRevision, whatever the revision is', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    expectOk(await adapter.set('a', 'one', { signal }));
    expectOk(await adapter.set('a', 'two', { signal }));
    assert.deepEqual(expectOk(await adapter.set('a', 'three', { signal })), {
      value: 'three',
      revision: '3',
    });
  });

  void it('removes a key, and removing a missing key succeeds', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    expectOk(await adapter.set('a', 'one', { signal }));
    assert.deepEqual(await adapter.remove?.('a', { signal }), {
      ok: true,
      value: null,
    });
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
    assert.deepEqual(await adapter.remove?.('never', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('starts a removed key again at revision 1', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    expectOk(await adapter.set('a', 'one', { signal }));
    expectOk(await adapter.set('a', 'two', { signal }));
    await adapter.remove?.('a', { signal });
    assert.equal(
      expectOk(await adapter.set('a', 'again', { signal })).revision,
      '1'
    );
  });

  void it('replaces a row whose revision is not a number, counting it as 0', async () => {
    const database = memoryDatabase();
    const adapter = sqliteAdapter({ database });
    expectOk(await adapter.set('a', 'one', { signal }));
    database
      .prepare("UPDATE storage_entry SET revision = 'junk' WHERE entry_key = ?")
      .run('a');
    assert.deepEqual(expectOk(await adapter.set('a', 'fixed', { signal })), {
      value: 'fixed',
      revision: '1',
    });
  });

  void it('uses the documented table: singular name, snake_case columns, UUID id, timestamps', async () => {
    const database = memoryDatabase();
    const adapter = sqliteAdapter({ database });
    expectOk(await adapter.set('a', 'one', { signal }));

    const columns = (
      database.prepare('PRAGMA table_info(storage_entry)').all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    assert.deepEqual(columns, [
      'storage_entry_id',
      'entry_key',
      'entry_value',
      'revision',
      'created_at',
      'updated_at',
    ]);

    const first = database
      .prepare('SELECT * FROM storage_entry WHERE entry_key = ?')
      .get('a') as Record<string, string>;
    assert.match(
      first['storage_entry_id'] ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    assert.match(
      first['created_at'] ?? '',
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );

    expectOk(await adapter.set('a', 'two', { signal }));
    const second = database
      .prepare('SELECT * FROM storage_entry WHERE entry_key = ?')
      .get('a') as Record<string, string>;
    assert.equal(second['storage_entry_id'], first['storage_entry_id']);
    assert.equal(second['created_at'], first['created_at']);
    assert.ok((second['updated_at'] ?? '') >= (first['updated_at'] ?? ''));

    expectOk(await adapter.set('b', 'x', { signal }));
    const ids = (
      database.prepare('SELECT storage_entry_id FROM storage_entry').all() as {
        storage_entry_id: string;
      }[]
    ).map((row) => row.storage_entry_id);
    assert.equal(new Set(ids).size, 2);
  });

  void it('does not touch the database when the request is already aborted', async () => {
    let touched = 0;
    const database: SqliteDatabaseLike = {
      exec: () => {
        touched += 1;
      },
      prepare: () => {
        touched += 1;
        throw new Error('should not be called');
      },
    };
    const adapter = sqliteAdapter({ database });
    const controller = new AbortController();
    controller.abort();
    const stoppedOptions = { signal: controller.signal };
    expectFailure(await adapter.get('a', stoppedOptions), 'unavailable', 'a');
    expectFailure(
      await adapter.set('a', 'v', stoppedOptions),
      'unavailable',
      'a'
    );
    expectFailure(
      (await adapter.remove?.('a', stoppedOptions)) as StoreResult<null>,
      'unavailable',
      'a'
    );
    assert.equal(touched, 0);
  });

  void it('maps SQLite result codes to error codes', async () => {
    const cases: [string, number, string][] = [
      ['database or disk is full', 13, 'quota'],
      ['attempt to write a readonly database', 8, 'forbidden'],
      ['authorization denied', 23, 'forbidden'],
      ['database disk image is malformed', 11, 'corrupt'],
      ['file is not a database', 26, 'corrupt'],
      ['database is locked', 5, 'unavailable'],
      ['unable to open database file', 14, 'unavailable'],
    ];
    for (const [message, errcode, expected] of cases) {
      const adapter = sqliteAdapter({
        database: failingDatabase(sqliteError(message, errcode)),
      });
      const written = await adapter.set('a', 'v', { signal });
      expectFailure(written, expected, 'a');
      assert.ok(!written.ok && written.error.includes(message));
      expectFailure(await adapter.get('a', { signal }), expected, 'a');
      expectFailure(
        (await adapter.remove?.('a', { signal })) as StoreResult<null>,
        expected,
        'a'
      );
    }
  });

  void it('reads the primary code out of an extended result code', async () => {
    // SQLITE_READONLY_DBMOVED is 8 | (4 << 8).
    const adapter = sqliteAdapter({
      database: failingDatabase(sqliteError('moved', 8 | (4 << 8))),
    });
    expectFailure(await adapter.set('a', 'v', { signal }), 'forbidden', 'a');
  });

  void it('maps an error with no code, by message, and otherwise to unavailable', async () => {
    const full = sqliteAdapter({
      database: failingDatabase(new Error('database or disk is full')),
    });
    expectFailure(await full.set('a', 'v', { signal }), 'quota', 'a');
    const other = sqliteAdapter({
      database: failingDatabase(new Error('something odd')),
    });
    expectFailure(await other.set('a', 'v', { signal }), 'unavailable', 'a');
  });

  void it('does not remember a failed setup, so the next call tries again', async () => {
    const real = memoryDatabase();
    let attempts = 0;
    const database: SqliteDatabaseLike = {
      exec: (sql) => {
        attempts += 1;
        if (attempts === 1) {
          throw sqliteError('unable to open database file', 14);
        }
        return real.exec(sql);
      },
      prepare: (sql) => real.prepare(sql),
    };
    const adapter = sqliteAdapter({ database });
    expectFailure(await adapter.get('a', { signal }), 'unavailable', 'a');
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('tells subscribers about writes and removals through the adapter', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    const seen: (StoredValue | null)[] = [];
    const unsubscribe: () => void =
      adapter.subscribe?.('a', (stored) => seen.push(stored)) ?? (() => {});

    expectOk(await adapter.set('other', 'x', { signal }));
    expectOk(await adapter.set('a', 'one', { signal }));
    await adapter.remove?.('a', { signal });
    assert.deepEqual(seen, [{ value: 'one', revision: '1' }, null]);

    unsubscribe();
    expectOk(await adapter.set('a', 'two', { signal }));
    assert.equal(seen.length, 2);
  });

  void it('does not notify for a conflict or a failure', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    expectOk(await adapter.set('a', 'one', { signal }));
    const seen: (StoredValue | null)[] = [];
    adapter.subscribe?.('a', (stored) => seen.push(stored));
    await adapter.set('a', 'two', { signal, ifRevision: '9' });
    assert.equal(seen.length, 0);

    const broken = sqliteAdapter({
      database: failingDatabase(sqliteError('full', 13)),
    });
    broken.subscribe?.('a', (stored) => seen.push(stored));
    await broken.set('a', 'v', { signal });
    assert.equal(seen.length, 0);
  });

  void it('keeps a successful write successful when a subscriber throws', async () => {
    const adapter = sqliteAdapter({ database: memoryDatabase() });
    adapter.subscribe?.('a', () => {
      throw new Error('bad listener');
    });
    assert.equal(
      expectOk(await adapter.set('a', 'one', { signal })).revision,
      '1'
    );
  });

  void describe('with a database file shared by two connections', () => {
    /**
     * Runs `run` with a function that opens connections to one database file. Every
     * connection is closed afterwards, even when a check fails, because Windows will
     * not delete a file that is still open. Removing the folder is best effort: a
     * leftover temporary folder must not fail a test that otherwise passed.
     */
    async function withFile(
      run: (open: () => DatabaseSync) => Promise<void>
    ): Promise<void> {
      const directory: string = mkdtempSync(join(tmpdir(), 'sqlite-adapter-'));
      const path: string = join(directory, 'store.db');
      const opened: DatabaseSync[] = [];
      try {
        await run(() => {
          const database = new DatabaseSync(path);
          opened.push(database);
          return database;
        });
      } finally {
        for (const database of opened) {
          try {
            database.close();
          } catch {
            // Already closed by the test.
          }
        }
        try {
          rmSync(directory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
          });
        } catch {
          // The operating system clears its temporary folder in time.
        }
      }
    }

    void it('keeps data after the connection is closed and reopened', () =>
      withFile(async (open) => {
        const first = open();
        expectOk(
          await sqliteAdapter({ database: first }).set('a', 'kept', { signal })
        );
        first.close();
        assert.deepEqual(
          expectOk(
            await sqliteAdapter({ database: open() }).get('a', { signal })
          ),
          { value: 'kept', revision: '1' }
        );
      }));

    void it('lets exactly one of two writers with the same ifRevision win', () =>
      withFile(async (open) => {
        const first = sqliteAdapter({ database: open() });
        const second = sqliteAdapter({ database: open() });
        expectOk(await first.set('a', 'start', { signal }));
        const results = await Promise.all([
          first.set('a', 'from first', { signal, ifRevision: '1' }),
          second.set('a', 'from second', { signal, ifRevision: '1' }),
        ]);
        assert.equal(results.filter((result) => result.ok).length, 1);
        const loser = results.find((result) => !result.ok);
        assert.ok(loser !== undefined);
        expectFailure(loser, 'conflict', 'a');
        assert.equal(
          expectOk(await second.get('a', { signal }))?.revision,
          '2'
        );
      }));

    void it('reports a write made by the other connection as a conflict', () =>
      withFile(async (open) => {
        const first = sqliteAdapter({ database: open() });
        const second = sqliteAdapter({ database: open() });
        const loaded = expectOk(await first.set('a', 'v1', { signal }));
        expectOk(await second.set('a', 'v2', { signal }));
        expectFailure(
          await first.set('a', 'stale', {
            signal,
            ifRevision: loaded.revision ?? '',
          }),
          'conflict',
          'a'
        );
      }));
  });
});
