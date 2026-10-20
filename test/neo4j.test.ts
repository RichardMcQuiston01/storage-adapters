/**
 * The Neo4j adapter, over an in-memory stand-in for a Neo4j driver
 * (test/support/fake-neo4j.ts), so the default test run stays offline.
 * test/neo4j-server.test.ts runs the same adapter against a real server.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { neo4jAdapter, type Neo4jAdapterOptions } from '../src/neo4j/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeNeo4j, FakeNeo4jError } from './support/fake-neo4j.js';

const signal: AbortSignal = new AbortController().signal;
const LABEL = 'StorageEntry';

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
  assert.ok(result.error.startsWith('Neo4j '), result.error);
  return result.error;
}

function adapterFor(
  neo4j: FakeNeo4j,
  more: Partial<Neo4jAdapterOptions> = {}
): StorageAdapter {
  return neo4jAdapter({ driver: neo4j, ...more });
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

const unsubscribed = (): void => undefined;

const deadlock = (): FakeNeo4jError =>
  new FakeNeo4jError(
    'ForsetiClient can not acquire UpdateLock',
    'Neo.TransientError.Transaction.DeadlockDetected'
  );

runConformance('neo4jAdapter over a fake driver', {
  ownWrites: 'notifies',
  create: () => {
    const neo4j = new FakeNeo4j();
    return {
      adapter: adapterFor(neo4j),
      reopen: () => adapterFor(neo4j),
    };
  },
});

void describe('neo4jAdapter: nodes and revisions', () => {
  void it('counts revisions per key from 1', async () => {
    const adapter = adapterFor(new FakeNeo4j());
    const first = expectOk(await adapter.set('a', 'x', { signal }));
    const second = expectOk(await adapter.set('a', 'y', { signal }));
    const other = expectOk(await adapter.set('b', 'z', { signal }));
    assert.deepEqual(
      [first.revision, second.revision, other.revision],
      ['1', '2', '1']
    );
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
      value: 'y',
      revision: '2',
    });
  });

  void it('reads revisions whether the driver gives numbers or Integer objects', async () => {
    for (const integerObjects of [true, false]) {
      const neo4j = new FakeNeo4j();
      neo4j.integerObjects = integerObjects;
      const adapter = adapterFor(neo4j);
      expectOk(await adapter.set('k', 'one', { signal }));
      const second = expectOk(await adapter.set('k', 'two', { signal }));
      assert.equal(second.revision, '2');
      assert.equal(expectOk(await adapter.get('k', { signal }))?.revision, '2');
    }
  });

  void it('writes when the revision matches in one statement, and says who holds the key when it does not', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('k', 'two', { signal }));
    neo4j.statements.length = 0;
    const next = expectOk(
      await adapter.set('k', 'three', { signal, ifRevision: '2' })
    );
    assert.equal(next.revision, '3');
    assert.equal(neo4j.statements.length, 1);
    assert.match(neo4j.statements[0]?.query ?? '', /FOREACH/);
    const message = expectFailure(
      await adapter.set('k', 'four', { signal, ifRevision: '1' }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 3, but revision 1 was expected/);
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'three');
  });

  void it('sends the expected revision as text, so it stays a whole number in Cypher', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    expectOk(await adapter.set('k', 'one', { signal }));
    const sent: unknown[] = [];
    const session = neo4j.session.bind(neo4j);
    neo4j.session = (config) => {
      const opened = session(config);
      return {
        run: (query, parameters) => {
          sent.push(parameters?.expected);
          return opened.run(query, parameters);
        },
        close: () => opened.close(),
      };
    };
    expectOk(await adapter.set('k', 'two', { signal, ifRevision: '1' }));
    assert.deepEqual(sent, ['1']);
  });

  void it('creates a key with nothing stored, even when given a revision', async () => {
    const adapter = adapterFor(new FakeNeo4j());
    assert.equal(
      expectOk(await adapter.set('k', 'v', { signal, ifRevision: '41' }))
        .revision,
      '1'
    );
    expectOk(await removeKey(adapter, 'k'));
    assert.equal(
      expectOk(await adapter.set('k', 'again', { signal, ifRevision: '1' }))
        .revision,
      '1'
    );
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'again');
  });

  void it('treats text that is not a revision as one that never matches', async () => {
    const adapter = adapterFor(new FakeNeo4j());
    expectOk(await adapter.set('k', 'v', { signal }));
    for (const ifRevision of ['abc', '', '1.5', '0', '99999999999999999999']) {
      expectFailure(
        await adapter.set('k', 'w', { signal, ifRevision }),
        'conflict',
        'k'
      );
    }
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'v');
    expectOk(await removeKey(adapter, 'k'));
    assert.equal(
      expectOk(await adapter.set('k', 'new', { signal, ifRevision: 'abc' }))
        .revision,
      '1'
    );
  });

  void it('starts a removed key again at revision 1', async () => {
    const adapter = adapterFor(new FakeNeo4j());
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('k', 'two', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    assert.equal(expectOk(await adapter.get('k', { signal })), null);
    assert.equal(
      expectOk(await adapter.set('k', 'again', { signal })).revision,
      '1'
    );
  });

  void it('reports a node that is not an entry as corrupt, and lets a remove clear it', async () => {
    const neo4j = new FakeNeo4j([LABEL]);
    const adapter = adapterFor(neo4j);
    for (const revision of [null, 'five']) {
      neo4j.put(LABEL, 'k', 'written by something else', revision);
      const message = expectFailure(
        await adapter.get('k', { signal }),
        'corrupt',
        'k'
      );
      assert.match(message, /remove the key to start again/);
      expectFailure(await adapter.set('k', 'v', { signal }), 'corrupt', 'k');
      expectFailure(
        await adapter.set('k', 'v', { signal, ifRevision: '1' }),
        'corrupt',
        'k'
      );
      expectOk(await removeKey(adapter, 'k'));
      expectOk(await adapter.set('k', 'v', { signal }));
      expectOk(await removeKey(adapter, 'k'));
    }
  });

  void it('reports a node with no value as corrupt when read, and a write repairs it', async () => {
    const neo4j = new FakeNeo4j([LABEL]);
    const adapter = adapterFor(neo4j);
    neo4j.put(LABEL, 'k', null, 3);
    expectFailure(await adapter.get('k', { signal }), 'corrupt', 'k');
    assert.equal(
      expectOk(await adapter.set('k', 'v', { signal })).revision,
      '4'
    );
  });
});

void describe('neo4jAdapter: races', () => {
  void it('replaces whatever is stored in one statement, however often it changes', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    expectOk(await adapter.set('k', 'one', { signal }));
    neo4j.statements.length = 0;
    const stored = expectOk(await adapter.set('k', 'mine', { signal }));
    assert.equal(stored.revision, '2');
    assert.equal(neo4j.statements.length, 1);
    assert.match(neo4j.statements[0]?.query ?? '', /^MERGE/);
  });

  void it('tries again when another writer created the key first and the uniqueness constraint refused', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    expectOk(await adapter.set('other', 'x', { signal }));
    let refusals = 3;
    neo4j.failures.length = 0;
    const run = neo4j.session.bind(neo4j);
    neo4j.session = (config) => {
      const opened = run(config);
      return {
        run: (query, parameters) => {
          if (/^MERGE/.test(query) && refusals > 0) {
            refusals -= 1;
            return Promise.reject(
              new FakeNeo4jError(
                "Node(1) already exists with label `StorageEntry` and property `key` = 'k'",
                'Neo.ClientError.Schema.ConstraintValidationFailed'
              )
            );
          }
          return opened.run(query, parameters);
        },
        close: () => opened.close(),
      };
    };
    assert.equal(
      expectOk(await adapter.set('k', 'mine', { signal })).revision,
      '1'
    );
    assert.equal(refusals, 0);
  });

  void it('gives up on an unconditional write that always meets the uniqueness constraint', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    expectOk(await adapter.set('other', 'x', { signal }));
    const run = neo4j.session.bind(neo4j);
    neo4j.session = (config) => {
      const opened = run(config);
      return {
        run: (query, parameters) =>
          /^MERGE/.test(query)
            ? Promise.reject(
                new FakeNeo4jError(
                  'already exists',
                  'Neo.ClientError.Schema.ConstraintValidationFailed'
                )
              )
            : opened.run(query, parameters),
        close: () => opened.close(),
      };
    };
    const message = expectFailure(
      await adapter.set('k', 'mine', { signal }),
      'conflict',
      'k'
    );
    assert.match(message, /kept changing.*gave up after 12 tries/);
  });

  void it('retries a statement that meets a lock conflict, and gives up after twelve', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j, { createConstraint: false });
    neo4j.failures.push(deadlock(), deadlock());
    assert.equal(
      expectOk(await adapter.set('k', 'v', { signal })).revision,
      '1'
    );
    assert.equal(neo4j.statements.length, 3);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      neo4j.failures.push(deadlock());
    }
    const message = expectFailure(
      await adapter.set('k', 'w', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /DeadlockDetected|can not acquire/);
    assert.equal(neo4j.failures.length, 0);
  });

  void it('does not retry a failure that is not a lock conflict', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j, { createConstraint: false });
    neo4j.failures.push(
      new FakeNeo4jError('bad syntax', 'Neo.ClientError.Statement.SyntaxError')
    );
    expectFailure(await adapter.set('k', 'v', { signal }), 'invalid', 'k');
    assert.equal(neo4j.statements.length, 1);
  });

  void it('reports a conflict when another process created the key between the compare and the create', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    expectOk(await adapter.set('other', 'x', { signal }));
    neo4j.beforeWrite = (label, key) => {
      if (key === 'k' && !neo4j.labels.get(label)?.has('k')) {
        neo4j.put(label, key, 'created first', 1);
      }
    };
    const message = expectFailure(
      await adapter.set('k', 'mine', { signal, ifRevision: '3' }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 1, but revision 3 was expected/);
    assert.equal(
      expectOk(await adapter.get('k', { signal }))?.value,
      'created first'
    );
  });

  void it('reports a conflict when the key appears between a compare that found nothing and the create', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    expectOk(await adapter.set('other', 'x', { signal }));
    let created = false;
    neo4j.beforeWrite = (label, key) => {
      if (
        key === 'k' &&
        !created &&
        neo4j.statements.some((s) => /^CREATE \(n:/.test(s.query))
      ) {
        created = true;
        neo4j.put(label, key, 'created first', 1);
      }
    };
    const message = expectFailure(
      await adapter.set('k', 'mine', { signal, ifRevision: '3' }),
      'conflict',
      'k'
    );
    assert.match(message, /changed while it was being written/);
  });
});

void describe('neo4jAdapter: the constraint, label and sessions', () => {
  void it('creates the uniqueness constraint once, before first use', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    expectOk(await adapter.set('a', '1', { signal }));
    expectOk(await adapter.get('a', { signal }));
    expectOk(await adapter.set('b', '2', { signal }));
    const creations = neo4j.statements.filter((s) =>
      /^CREATE CONSTRAINT/.test(s.query)
    );
    assert.equal(creations.length, 1);
    assert.match(
      creations[0]?.query ?? '',
      /CREATE CONSTRAINT StorageEntry_key_unique IF NOT EXISTS FOR \(n:StorageEntry\) REQUIRE n\.key IS UNIQUE/
    );
    assert.equal(neo4j.statements[0], creations[0]);
    assert.ok(neo4j.constraints.has('StorageEntry_key_unique'));
  });

  void it('uses a label it is given, for the constraint and every statement', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j, { label: 'Setting' });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await adapter.get('k', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    expectOk((await adapter.list?.('', { signal })) ?? { ok: true, value: [] });
    assert.ok(neo4j.statements.every((s) => /:Setting\b/.test(s.query)));
    assert.ok(neo4j.constraints.has('Setting_key_unique'));
  });

  void it('refuses a label that is not a plain name, without asking Neo4j', async () => {
    const neo4j = new FakeNeo4j();
    for (const label of [
      'bad label',
      'a;drop',
      'a.b',
      '1abc',
      'x}) DELETE (n',
    ]) {
      const adapter = adapterFor(neo4j, { label });
      const message = expectFailure(
        await adapter.get('k', { signal }),
        'invalid',
        'k'
      );
      assert.match(message, /cannot use label/);
      const listed = await adapter.list?.('', { signal });
      assert.ok(
        listed !== undefined && !listed.ok && listed.code === 'invalid'
      );
    }
    assert.deepEqual(neo4j.statements, []);
    assert.deepEqual(neo4j.sessions, []);
  });

  void it('reports a failed constraint creation and tries again next time', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    neo4j.failures.push(
      new FakeNeo4jError('Connection refused', 'ServiceUnavailable')
    );
    expectFailure(await adapter.set('k', 'v', { signal }), 'unavailable', 'k');
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.equal(
      neo4j.statements.filter((s) => /^CREATE CONSTRAINT/.test(s.query)).length,
      2
    );
  });

  void it('does not create anything when told not to', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j, { createConstraint: false });
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.ok(neo4j.statements.every((s) => !/CONSTRAINT/.test(s.query)));
  });

  void it('reads in READ sessions and writes in WRITE sessions, adding the session settings it is given', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j, {
      createConstraint: false,
      sessionConfig: { database: 'neo4j', fetchSize: 500 },
    });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await adapter.get('k', { signal }));
    expectOk((await adapter.list?.('', { signal })) ?? { ok: true, value: [] });
    expectOk(await removeKey(adapter, 'k'));
    assert.deepEqual(
      neo4j.statements.map((s) => s.mode),
      ['WRITE', 'READ', 'READ', 'WRITE']
    );
    assert.ok(
      neo4j.sessions.every(
        (s) => s.config.database === 'neo4j' && s.config.fetchSize === 500
      )
    );
  });

  void it('closes every session, even when the statement failed', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    expectOk(await adapter.set('k', 'v', { signal }));
    // A lock conflict that is retried, then a failure that is not; then a failed read.
    neo4j.failures.push(
      deadlock(),
      new FakeNeo4jError('boom', 'Neo.DatabaseError.General.UnknownError')
    );
    expectFailure(await adapter.set('k', 'w', { signal }), 'unavailable', 'k');
    neo4j.failures.push(
      new FakeNeo4jError('boom', 'Neo.DatabaseError.General.UnknownError')
    );
    expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k');
    assert.ok(neo4j.sessions.length > 3);
    assert.ok(neo4j.sessions.every((s) => s.closed));
  });

  void it('says so when the database does not exist', async () => {
    const adapter = adapterFor(new FakeNeo4j(), {
      sessionConfig: { database: 'nope' },
    });
    const message = expectFailure(
      await adapter.get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /the database does not exist/);
  });
});

void describe('neo4jAdapter: listing', () => {
  void it('lists keys under a prefix, in order', async () => {
    const neo4j = new FakeNeo4j([LABEL]);
    const adapter = adapterFor(neo4j);
    const keys: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const key = `n${String(index).padStart(3, '0')}`;
      keys.push(key);
      neo4j.put(LABEL, key, 'v', 1);
    }
    for (const key of ['user/2', 'user/1', 'users', 'é😀']) {
      expectOk(await adapter.set(key, key, { signal }));
    }
    const list = async (prefix: string): Promise<readonly string[]> =>
      expectOk(
        (await adapter.list?.(prefix, { signal })) ?? { ok: true, value: [] }
      );
    assert.deepEqual(await list('n'), keys);
    assert.deepEqual(await list('user/'), ['user/1', 'user/2']);
    assert.deepEqual(await list('é'), ['é😀']);
    assert.deepEqual(await list('nothing'), []);
    assert.equal((await list('')).length, 44);
  });

  void it('does not list removed keys', async () => {
    const adapter = adapterFor(new FakeNeo4j());
    expectOk(await adapter.set('a', '1', { signal }));
    expectOk(await adapter.set('b', '2', { signal }));
    expectOk(await removeKey(adapter, 'a'));
    assert.deepEqual(
      expectOk(
        (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
      ),
      ['b']
    );
  });

  void it('names the prefix when listing fails', async () => {
    const neo4j = new FakeNeo4j([LABEL]);
    const adapter = adapterFor(neo4j, { createConstraint: false });
    neo4j.failures.push(new FakeNeo4jError('timed out', 'ServiceUnavailable'));
    const result = await adapter.list?.('user/', { signal });
    assert.ok(result !== undefined && !result.ok);
    assert.equal(result.code, 'unavailable');
    assert.ok(
      result.error.includes('"user/"') && result.error.includes('timed out'),
      result.error
    );
  });
});

void describe('neo4jAdapter: keys, values and failures', () => {
  void it('refuses keys and values Neo4j cannot hold, without asking it', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    expectFailure(await adapter.get('\ud800', { signal }), 'invalid', '\ud800');
    const huge = 'k'.repeat(8001);
    expectFailure(await adapter.set(huge, 'v', { signal }), 'invalid', huge);
    expectFailure(await adapter.set('k', '\udc00', { signal }), 'invalid', 'k');
    assert.deepEqual(neo4j.statements, []);
  });

  void it('accepts the empty key and a key of exactly the limit', async () => {
    const adapter = adapterFor(new FakeNeo4j());
    expectOk(await adapter.set('', 'empty', { signal }));
    assert.equal(expectOk(await adapter.get('', { signal }))?.value, 'empty');
    const longest = '😀'.repeat(2000);
    expectOk(await adapter.set(longest, 'long', { signal }));
    assert.equal(
      expectOk(await adapter.get(longest, { signal }))?.value,
      'long'
    );
  });

  const cases: readonly [string, string, string][] = [
    [
      'The client is unauthorized due to authentication failure.',
      'Neo.ClientError.Security.Unauthorized',
      'forbidden',
    ],
    ['Permission denied', 'Neo.ClientError.Security.Forbidden', 'forbidden'],
    [
      'Property value is too large to index, please see index documentation',
      'Neo.DatabaseError.Statement.ExecutionFailed',
      'invalid',
    ],
    ['Invalid input', 'Neo.ClientError.Statement.SyntaxError', 'invalid'],
    [
      'There is not enough memory to perform the current task (out of memory)',
      'Neo.TransientError.General.MemoryPoolOutOfMemoryError',
      'quota',
    ],
    ['Failed to connect to any server', 'ServiceUnavailable', 'unavailable'],
    ['Session expired', 'SessionExpired', 'unavailable'],
  ];
  for (const [message, errorCode, code] of cases) {
    void it(`maps "${message.slice(0, 40)}" to ${code}, naming the key`, async () => {
      const neo4j = new FakeNeo4j();
      const adapter = adapterFor(neo4j, { createConstraint: false });
      neo4j.failures.push(new FakeNeo4jError(message, errorCode));
      const error = expectFailure(
        await adapter.get('k', { signal }),
        code,
        'k'
      );
      assert.ok(error.includes(message), error);
    });
  }

  void it('warns that a write that lost its connection may have been applied', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j, { createConstraint: false });
    neo4j.failures.push(
      new FakeNeo4jError('Connection was closed by server', 'SessionExpired')
    );
    const message = expectFailure(
      await adapter.set('k', 'v', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /may or may not have been applied/);
    neo4j.failures.push(
      new FakeNeo4jError('Connection was closed by server', 'SessionExpired')
    );
    const removed = expectFailure(
      await removeKey(adapter, 'k'),
      'unavailable',
      'k'
    );
    assert.match(removed, /may or may not have been applied/);
    neo4j.failures.push(
      new FakeNeo4jError('Connection was closed by server', 'SessionExpired')
    );
    const read = expectFailure(
      await adapter.get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.doesNotMatch(read, /may or may not/);
  });

  void it('does not touch the driver when the request was aborted', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    const controller = new AbortController();
    controller.abort();
    expectFailure(
      await adapter.get('k', { signal: controller.signal }),
      'unavailable',
      'k'
    );
    expectFailure(
      await adapter.set('k', 'v', { signal: controller.signal }),
      'unavailable',
      'k'
    );
    expectFailure(
      (await adapter.remove?.('k', { signal: controller.signal })) ?? {
        ok: true,
        value: null,
      },
      'unavailable',
      'k'
    );
    const listed = await adapter.list?.('', { signal: controller.signal });
    assert.ok(listed !== undefined && !listed.ok);
    assert.deepEqual(neo4j.statements, []);
    assert.deepEqual(neo4j.sessions, []);
  });
});

void describe('neo4jAdapter: subscribe', () => {
  void it('reports writes and removals made through the same adapter, once each, without polling', async () => {
    const neo4j = new FakeNeo4j();
    const adapter = adapterFor(neo4j);
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('other', 'x', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    stop();
    expectOk(await adapter.set('k', 'two', { signal }));
    assert.deepEqual(
      seen.map((stored) => stored?.value ?? null),
      ['one', null]
    );
    assert.ok(neo4j.statements.every((s) => !/ IN \$keys/.test(s.query)));
  });

  void it('hears a write and a removal made by another process when polling', async () => {
    const neo4j = new FakeNeo4j([LABEL]);
    const adapter = adapterFor(neo4j, { pollIntervalMs: 50 });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(80);
    neo4j.put(LABEL, 'k', 'from elsewhere', 4);
    await eventually(() => seen.length === 1, 'the write');
    neo4j.delete(LABEL, 'k');
    await eventually(() => seen.length === 2, 'the removal');
    stop();
    assert.deepEqual(seen, [{ value: 'from elsewhere', revision: '4' }, null]);
  });

  void it('does not report what was stored when it subscribed, or an own write twice', async () => {
    const neo4j = new FakeNeo4j([LABEL]);
    neo4j.put(LABEL, 'k', 'old', 1);
    const adapter = adapterFor(neo4j, { pollIntervalMs: 50 });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(150);
    assert.equal(seen.length, 0);
    expectOk(await adapter.set('k', 'mine', { signal }));
    await tick(250);
    stop();
    assert.deepEqual(
      seen.map((stored) => stored?.value),
      ['mine']
    );
  });

  void it('hears its own writes once even when a poll reads them before the write has finished', async () => {
    const neo4j = new FakeNeo4j([LABEL]);
    neo4j.writeLatencyMs = 60;
    const adapter = adapterFor(neo4j, {
      pollIntervalMs: 50,
      createConstraint: false,
    });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(150);
    for (let index = 0; index < 8; index += 1) {
      expectOk(await adapter.set('k', `v${String(index)}`, { signal }));
    }
    await tick(250);
    stop();
    assert.deepEqual(
      seen.map((stored) => stored?.value),
      Array.from({ length: 8 }, (_, index) => `v${String(index)}`)
    );
  });

  void it('reports a failing poll once per run of failures, naming the label, and carries on', async () => {
    const neo4j = new FakeNeo4j([LABEL]);
    const messages: string[] = [];
    const adapter = adapterFor(neo4j, {
      pollIntervalMs: 50,
      createConstraint: false,
      onPollError: (message) => messages.push(message),
    });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(80);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      neo4j.failures.push(
        new FakeNeo4jError('node is restarting', 'ServiceUnavailable')
      );
    }
    await tick(300);
    assert.equal(messages.length, 1);
    assert.match(
      messages[0] ?? '',
      /could not poll label "StorageEntry" for changes \(.*restarting/
    );
    neo4j.put(LABEL, 'k', 'after the outage', 2);
    await eventually(() => seen.length === 1, 'recovery');
    stop();
    assert.equal(seen[0]?.value, 'after the outage');
  });

  void it('survives a listener that throws', async () => {
    const adapter = adapterFor(new FakeNeo4j());
    const stop =
      adapter.subscribe?.('k', () => {
        throw new Error('listener bug');
      }) ?? unsubscribed;
    expectOk(await adapter.set('k', 'v', { signal }));
    stop();
  });
});
