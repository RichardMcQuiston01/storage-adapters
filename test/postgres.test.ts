import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  postgresAdapter,
  type PostgresClientLike,
  type PostgresParameter,
  type PostgresResultLike,
} from '../src/postgres/index.js';
import type { StoredValue, StoreResult } from '../src/storage.js';

const signal: AbortSignal = new AbortController().signal;

interface Call {
  readonly sql: string;
  readonly parameters: PostgresParameter[];
}

/** A client that records every call and answers from `respond`. */
function scriptedClient(
  respond: (call: Call, index: number) => PostgresResultLike | Error
): PostgresClientLike & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query: (sql, parameters) => {
      const call: Call = { sql, parameters };
      calls.push(call);
      const answer = respond(call, calls.length - 1);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
}

/** Answers the table setup with nothing and everything else with `rows`. */
function answering(
  ...rows: readonly (readonly unknown[])[]
): ReturnType<typeof scriptedClient> {
  let next = 0;
  return scriptedClient((call) => {
    if (call.sql.startsWith('CREATE TABLE')) {
      return { rows: [] };
    }
    const answer = rows[Math.min(next, rows.length - 1)] ?? [];
    next += 1;
    return { rows: answer };
  });
}

function sqlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
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
): string {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  assert.ok(
    result.error.includes(`"${key}"`),
    `error should name the key: ${result.error}`
  );
  assert.ok(result.error.startsWith('Postgres '), result.error);
  return result.error;
}

void describe('postgresAdapter', () => {
  void it('creates the table once, on first use, with a UUID key and timestamps', async () => {
    const client = answering([]);
    const adapter = postgresAdapter({ client });
    assert.equal(client.calls.length, 0);
    await adapter.get('a', { signal });
    await adapter.get('b', { signal });
    const creates = client.calls.filter((call) =>
      call.sql.startsWith('CREATE TABLE')
    );
    assert.equal(creates.length, 1);
    const create = creates[0]?.sql ?? '';
    assert.match(
      create,
      /storage_entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/
    );
    assert.match(create, /created_at timestamptz NOT NULL/);
    assert.match(create, /updated_at timestamptz NOT NULL/);
    assert.match(create, /entry_key text NOT NULL UNIQUE/);
  });

  void it('does not remember a failed setup, so the next call tries again', async () => {
    let creates = 0;
    const client = scriptedClient((call) => {
      if (call.sql.startsWith('CREATE TABLE')) {
        creates += 1;
        return creates <= 2 ? new Error('connection refused') : { rows: [] };
      }
      return { rows: [] };
    });
    const adapter = postgresAdapter({ client });
    const first = await adapter.get('a', { signal });
    assert.match(
      expectFailure(first, 'unavailable', 'a'),
      /connection refused/
    );
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('retries the table setup once, in case another process is creating it', async () => {
    let creates = 0;
    const client = scriptedClient((call) => {
      if (call.sql.startsWith('CREATE TABLE')) {
        creates += 1;
        return creates === 1
          ? sqlError('23505', 'duplicate key')
          : { rows: [] };
      }
      return { rows: [] };
    });
    expectOk(await postgresAdapter({ client }).get('a', { signal }));
    assert.equal(creates, 2);
  });

  void it('sends the key and value, and reads the new revision from the row', async () => {
    const client = answering([{ revision: '4' }]);
    const stored = expectOk(
      await postgresAdapter({ client }).set('k', 'v', { signal })
    );
    assert.deepEqual(stored, { value: 'v', revision: '4' });
    const write = client.calls.at(-1);
    assert.match(write?.sql ?? '', /INSERT INTO storage_entry/);
    assert.match(write?.sql ?? '', /ON CONFLICT \(entry_key\) DO UPDATE/);
    assert.deepEqual(write?.parameters, ['k', 'v']);
  });

  void it('puts the revision check in the same statement as the write', async () => {
    const client = answering([{ revision: '6' }]);
    expectOk(
      await postgresAdapter({ client }).set('k', 'v', {
        signal,
        ifRevision: '5',
      })
    );
    const write = client.calls.at(-1);
    assert.match(
      write?.sql ?? '',
      /WHERE storage_entry\.revision = \$3::bigint/
    );
    assert.deepEqual(write?.parameters, ['k', 'v', '5']);
  });

  void it('turns a revision that is not a number into one that cannot match', async () => {
    for (const odd of ['abc', '', '1.5', '-3', '9'.repeat(30)]) {
      const client = answering([{ revision: '1' }]);
      await postgresAdapter({ client }).set('k', 'v', {
        signal,
        ifRevision: odd,
      });
      assert.equal(client.calls.at(-1)?.parameters[2], '-1', odd);
    }
  });

  void it('names both revisions in a conflict', async () => {
    const client = answering([], [{ revision: '9' }]);
    const message = expectFailure(
      await postgresAdapter({ client }).set('k', 'v', {
        signal,
        ifRevision: '3',
      }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 9, but revision 3 was expected/);
  });

  void it('writes again when the row vanished between the write and the check', async () => {
    const client = answering([], [], [{ revision: '1' }]);
    const stored = expectOk(
      await postgresAdapter({ client }).set('k', 'v', {
        signal,
        ifRevision: '3',
      })
    );
    assert.equal(stored.revision, '1');
  });

  void it('gives up when the row keeps vanishing', async () => {
    const client = answering([]);
    expectFailure(
      await postgresAdapter({ client }).set('k', 'v', {
        signal,
        ifRevision: '3',
      }),
      'unavailable',
      'k'
    );
  });

  void it('reads a stored entry', async () => {
    const client = answering([{ entry_value: 'dark', revision: '2' }]);
    assert.deepEqual(await postgresAdapter({ client }).get('k', { signal }), {
      ok: true,
      value: { value: 'dark', revision: '2' },
    });
  });

  void it('calls a row that is not a stored entry corrupt, naming the key', async () => {
    for (const row of [
      { entry_value: 5, revision: '1' },
      { entry_value: 'x', revision: 'one' },
      { entry_value: 'x' },
    ]) {
      const client = answering([row]);
      expectFailure(
        await postgresAdapter({ client }).get('k', { signal }),
        'corrupt',
        'k'
      );
    }
  });

  void it('accepts a revision the driver returned as a number or bigint', async () => {
    for (const revision of [3, 3n]) {
      const client = answering([{ entry_value: 'x', revision }]);
      const stored = expectOk(
        await postgresAdapter({ client }).get('k', { signal })
      );
      assert.equal(stored?.revision, '3');
    }
  });

  void it('does not touch the database for an aborted request', async () => {
    const client = answering([]);
    const adapter = postgresAdapter({ client });
    const controller = new AbortController();
    controller.abort();
    const aborted = { signal: controller.signal };
    expectFailure(await adapter.get('k', aborted), 'unavailable', 'k');
    expectFailure(await adapter.set('k', 'v', aborted), 'unavailable', 'k');
    assert.ok(adapter.remove !== undefined, 'adapter should implement remove');
    expectFailure(await adapter.remove('k', aborted), 'unavailable', 'k');
    assert.equal(client.calls.length, 0);
  });

  void it('refuses a table name that is not plain letters, digits and underscores', async () => {
    for (const table of [
      'a b',
      'x;DROP TABLE y',
      '1table',
      'a.b.c',
      '',
      '"q"',
    ]) {
      const client = answering([]);
      const adapter = postgresAdapter({ client, table });
      const message = expectFailure(
        await adapter.get('k', { signal }),
        'invalid',
        'k'
      );
      assert.ok(message.includes(`"${table}"`), message);
      expectFailure(await adapter.set('k', 'v', { signal }), 'invalid', 'k');
      assert.equal(client.calls.length, 0, table);
    }
  });

  void it('accepts a schema-qualified table name', async () => {
    const client = answering([]);
    expectOk(
      await postgresAdapter({ client, table: 'app.settings' }).get('k', {
        signal,
      })
    );
    assert.match(
      client.calls[0]?.sql ?? '',
      /CREATE TABLE IF NOT EXISTS app\.settings/
    );
  });

  void it('maps database errors to error codes, naming the key and the cause', async () => {
    const cases: readonly [Error, string][] = [
      [sqlError('53100', 'could not extend file'), 'quota'],
      [new Error('No space left on device'), 'quota'],
      [
        sqlError('42501', 'permission denied for table storage_entry'),
        'forbidden',
      ],
      [sqlError('28P01', 'password authentication failed'), 'forbidden'],
      [
        sqlError('25006', 'cannot execute INSERT in a read-only transaction'),
        'forbidden',
      ],
      [
        sqlError('22021', 'invalid byte sequence for encoding "UTF8": 0x00'),
        'invalid',
      ],
      [sqlError('57P03', 'the database system is starting up'), 'unavailable'],
      [
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
        'unavailable',
      ],
    ];
    for (const [error, code] of cases) {
      const client = scriptedClient((call) =>
        call.sql.startsWith('CREATE TABLE') ? { rows: [] } : error
      );
      const adapter = postgresAdapter({ client });
      const message = expectFailure(
        await adapter.set('k', 'v', { signal }),
        code,
        'k'
      );
      assert.ok(message.includes(error.message), message);
      expectFailure(await adapter.get('k', { signal }), code, 'k');
    }
  });

  void it('removes a key and tells subscribers', async () => {
    const client = answering([]);
    const adapter = postgresAdapter({ client });
    const seen: (StoredValue | null)[] = [];
    const stop = adapter.subscribe?.('k', (stored) => seen.push(stored));
    await adapter.remove?.('k', { signal });
    stop?.();
    assert.deepEqual(seen, [null]);
    assert.match(client.calls.at(-1)?.sql ?? '', /^DELETE FROM storage_entry/);
  });

  void it('keeps a successful write successful when a subscriber throws', async () => {
    const client = answering([{ revision: '1' }]);
    const adapter = postgresAdapter({ client });
    adapter.subscribe?.('k', () => {
      throw new Error('listener bug');
    });
    expectOk(await adapter.set('k', 'v', { signal }));
  });

  void it('does not tell subscribers about a conflict', async () => {
    const client = answering([], [{ revision: '9' }]);
    const adapter = postgresAdapter({ client });
    const seen: unknown[] = [];
    adapter.subscribe?.('k', (stored) => seen.push(stored));
    await adapter.set('k', 'v', { signal, ifRevision: '1' });
    assert.deepEqual(seen, []);
  });
});
