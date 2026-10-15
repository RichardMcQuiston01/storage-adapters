import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mysqlAdapter,
  type MysqlClientLike,
  type MysqlParameter,
} from '../src/mysql/index.js';
import type { StoredValue, StoreResult } from '../src/storage.js';

const signal: AbortSignal = new AbortController().signal;

interface Call {
  readonly sql: string;
  readonly parameters: MysqlParameter[];
}

type Answer = readonly [unknown, ...unknown[]] | Error;

/** A client that records every call and answers from `respond`. */
function scriptedClient(
  respond: (call: Call, index: number) => Answer
): MysqlClientLike & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query: (sql, parameters) => {
      const call: Call = { sql, parameters };
      calls.push(call);
      const answer: Answer = respond(call, calls.length - 1);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
}

/** Answers table setup with a header and everything else with `answers` in turn. */
function answering(
  ...answers: readonly Answer[]
): ReturnType<typeof scriptedClient> {
  let next = 0;
  return scriptedClient((call) => {
    if (call.sql.startsWith('CREATE TABLE')) {
      return [{ insertId: 0 }, undefined];
    }
    const answer: Answer | undefined =
      answers[Math.min(next, answers.length - 1)];
    next += 1;
    return answer ?? [[], undefined];
  });
}

const header = (insertId: unknown): Answer => [{ insertId }, undefined];
const rows = (...found: unknown[]): Answer => [found, undefined];

function mysqlError(errno: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { errno, code });
}

const duplicate: Error = mysqlError(
  1062,
  'ER_DUP_ENTRY',
  "Duplicate entry 'k'"
);

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
  assert.ok(result.error.startsWith('MySQL '), result.error);
  return result.error;
}

void describe('mysqlAdapter', () => {
  void it('creates the table once, on first use, with a UUID key and timestamps', async () => {
    const client = answering(rows());
    const adapter = mysqlAdapter({ client });
    assert.equal(client.calls.length, 0);
    await adapter.get('a', { signal });
    await adapter.get('b', { signal });
    const creates = client.calls.filter((call) =>
      call.sql.startsWith('CREATE TABLE')
    );
    assert.equal(creates.length, 1);
    const create = creates[0]?.sql ?? '';
    assert.match(create, /storage_entry_id CHAR\(36\) NOT NULL PRIMARY KEY/);
    assert.match(create, /entry_key VARBINARY\(1024\) NOT NULL/);
    assert.match(create, /created_at TIMESTAMP\(3\) NOT NULL/);
    assert.match(create, /updated_at TIMESTAMP\(3\) NOT NULL/);
    assert.match(create, /UNIQUE KEY entry_key \(entry_key\)/);
  });

  void it('does not remember a failed setup, so the next call tries again', async () => {
    let creates = 0;
    const client = scriptedClient((call) => {
      if (call.sql.startsWith('CREATE TABLE')) {
        creates += 1;
        return creates <= 2 ? new Error('connection lost') : header(0);
      }
      return rows();
    });
    const adapter = mysqlAdapter({ client });
    assert.match(
      expectFailure(await adapter.get('a', { signal }), 'unavailable', 'a'),
      /connection lost/
    );
    assert.deepEqual(await adapter.get('a', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('reads a new key as revision 1 and a bumped key as the id the server returned', async () => {
    for (const [insertId, revision] of [
      [0, '1'],
      [7, '7'],
      ['12', '12'],
      [5n, '5'],
    ] as const) {
      const client = answering(header(insertId));
      const stored = expectOk(
        await mysqlAdapter({ client }).set('k', 'v', { signal })
      );
      assert.deepEqual(stored, { value: 'v', revision }, String(insertId));
    }
    const client = answering(header(0));
    await mysqlAdapter({ client }).set('k', 'v', { signal });
    const write = client.calls.at(-1);
    assert.match(write?.sql ?? '', /ON DUPLICATE KEY UPDATE/);
    assert.match(
      write?.sql ?? '',
      /revision = LAST_INSERT_ID\(revision \+ 1\)/
    );
    assert.deepEqual(write?.parameters, ['k', 'v']);
  });

  void it('updates only a row whose revision matches, and takes the new revision from insertId', async () => {
    const client = answering(header(6));
    const stored = expectOk(
      await mysqlAdapter({ client }).set('k', 'v', { signal, ifRevision: '5' })
    );
    assert.deepEqual(stored, { value: 'v', revision: '6' });
    const write = client.calls.at(-1);
    assert.match(write?.sql ?? '', /^UPDATE storage_entry SET/);
    assert.match(write?.sql ?? '', /WHERE entry_key = \? AND revision = \?/);
    assert.deepEqual(write?.parameters, ['v', 'k', '5']);
    assert.equal(
      client.calls.filter((call) => call.sql.startsWith('INSERT')).length,
      0
    );
  });

  void it('creates the key when nothing matched and nothing is stored', async () => {
    const client = answering(header(0), header(0));
    const stored = expectOk(
      await mysqlAdapter({ client }).set('k', 'v', { signal, ifRevision: '5' })
    );
    assert.deepEqual(stored, { value: 'v', revision: '1' });
    assert.match(client.calls.at(-1)?.sql ?? '', /^INSERT INTO storage_entry/);
  });

  void it('reports a conflict when nothing matched and the key exists, naming both revisions', async () => {
    for (const error of [
      duplicate,
      Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }),
    ]) {
      const client = answering(header(0), error, rows({ revision: '9' }));
      const message = expectFailure(
        await mysqlAdapter({ client }).set('k', 'v', {
          signal,
          ifRevision: '5',
        }),
        'conflict',
        'k'
      );
      assert.match(message, /holds revision 9, but revision 5 was expected/);
    }
  });

  void it('still reports a conflict if the row is gone by the time it looks', async () => {
    const client = answering(header(0), duplicate, rows());
    const message = expectFailure(
      await mysqlAdapter({ client }).set('k', 'v', { signal, ifRevision: '5' }),
      'conflict',
      'k'
    );
    assert.match(message, /changed since revision 5 was read/);
  });

  void it('does not mistake another insert failure for a conflict', async () => {
    const client = answering(
      header(0),
      mysqlError(1045, 'ER_ACCESS_DENIED_ERROR', 'Access denied')
    );
    expectFailure(
      await mysqlAdapter({ client }).set('k', 'v', { signal, ifRevision: '5' }),
      'forbidden',
      'k'
    );
  });

  void it('turns a revision that is not a number into one that cannot match', async () => {
    for (const odd of ['abc', '', '1.5', '-3', '9'.repeat(30)]) {
      const client = answering(header(0), header(0));
      await mysqlAdapter({ client }).set('k', 'v', { signal, ifRevision: odd });
      const update = client.calls.find((call) => call.sql.startsWith('UPDATE'));
      assert.equal(update?.parameters[2], '0', odd);
    }
  });

  void it('reads a stored entry', async () => {
    const client = answering(rows({ entry_value: 'dark', revision: '2' }));
    assert.deepEqual(await mysqlAdapter({ client }).get('k', { signal }), {
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
      const client = answering(rows(row));
      expectFailure(
        await mysqlAdapter({ client }).get('k', { signal }),
        'corrupt',
        'k'
      );
    }
  });

  void it('treats a result that is not rows as nothing stored', async () => {
    const client = answering([undefined, undefined]);
    assert.deepEqual(await mysqlAdapter({ client }).get('k', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('refuses a key longer than 1024 bytes of UTF-8, counting bytes not characters', async () => {
    const client = answering(header(0));
    const adapter = mysqlAdapter({ client });
    expectOk(await adapter.set('k'.repeat(1024), 'v', { signal }));
    const tooLong = '\u{1F600}'.repeat(300); // 1200 bytes, only 300 characters
    const message = expectFailure(
      await adapter.set(tooLong, 'v', { signal }),
      'invalid',
      tooLong
    );
    assert.match(message, /longer than 1024 bytes/);
    expectFailure(
      await adapter.set('z'.repeat(1025), 'v', { signal }),
      'invalid',
      'z'.repeat(1025)
    );
  });

  void it('does not touch the database for an aborted request', async () => {
    const client = answering(rows());
    const adapter = mysqlAdapter({ client });
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
      '`q`',
    ]) {
      const client = answering(rows());
      const adapter = mysqlAdapter({ client, table });
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

  void it('maps database errors to error codes, naming the key and the cause', async () => {
    const cases: readonly [Error, string][] = [
      [
        mysqlError(
          1114,
          'ER_RECORD_FILE_FULL',
          "The table 'storage_entry' is full"
        ),
        'quota',
      ],
      [mysqlError(1021, 'ER_DISK_FULL', 'Disk full'), 'quota'],
      [
        mysqlError(
          1153,
          'ER_NET_PACKET_TOO_LARGE',
          'Got a packet bigger than max_allowed_packet'
        ),
        'quota',
      ],
      [
        mysqlError(
          1142,
          'ER_TABLEACCESS_DENIED_ERROR',
          'INSERT command denied'
        ),
        'forbidden',
      ],
      [
        mysqlError(1836, 'ER_READ_ONLY_MODE', 'Running in read-only mode'),
        'forbidden',
      ],
      [
        mysqlError(
          1366,
          'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
          'Incorrect string value'
        ),
        'invalid',
      ],
      [mysqlError(1406, 'ER_DATA_TOO_LONG', 'Data too long'), 'invalid'],
      [
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
        'unavailable',
      ],
      [
        mysqlError(2013, 'PROTOCOL_CONNECTION_LOST', 'Lost connection'),
        'unavailable',
      ],
    ];
    for (const [error, code] of cases) {
      const client = scriptedClient((call) =>
        call.sql.startsWith('CREATE TABLE') ? header(0) : error
      );
      const adapter = mysqlAdapter({ client });
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
    const client = answering(header(0));
    const adapter = mysqlAdapter({ client });
    const seen: (StoredValue | null)[] = [];
    const stop = adapter.subscribe?.('k', (stored) => seen.push(stored));
    assert.ok(adapter.remove !== undefined, 'adapter should implement remove');
    await adapter.remove('k', { signal });
    stop?.();
    assert.deepEqual(seen, [null]);
    assert.match(client.calls.at(-1)?.sql ?? '', /^DELETE FROM storage_entry/);
  });

  void it('keeps a successful write successful when a subscriber throws, and does not notify a conflict', async () => {
    const client = answering(
      header(2),
      header(0),
      duplicate,
      rows({ revision: '9' })
    );
    const adapter = mysqlAdapter({ client });
    const seen: unknown[] = [];
    adapter.subscribe?.('k', () => {
      throw new Error('listener bug');
    });
    adapter.subscribe?.('k', (stored) => seen.push(stored));
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.equal(seen.length, 1);
    expectFailure(
      await adapter.set('k', 'w', { signal, ifRevision: '1' }),
      'conflict',
      'k'
    );
    assert.equal(seen.length, 1);
  });
});
