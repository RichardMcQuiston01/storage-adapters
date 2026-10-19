/**
 * The ArangoDB adapter, over an in-memory stand-in for ArangoDB's HTTP API
 * (test/support/fake-arangodb.ts), so the default test run stays offline.
 * test/arangodb-server.test.ts runs the same adapter against a real server.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  arangoDbAdapter,
  decodeArangoKey,
  encodeArangoKey,
  type ArangoDbAdapterOptions,
} from '../src/arangodb/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeArangoDb } from './support/fake-arangodb.js';

const signal: AbortSignal = new AbortController().signal;
const COLLECTION = 'storage_entry';

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
  assert.ok(result.error.startsWith('ArangoDB '), result.error);
  return result.error;
}

function adapterFor(
  arango: FakeArangoDb,
  more: Partial<ArangoDbAdapterOptions> = {}
): StorageAdapter {
  return arangoDbAdapter({
    url: 'http://arango.test:8529/',
    fetch: arango.fetch,
    ...more,
  });
}

const removeKey = async (
  adapter: StorageAdapter,
  key: string
): Promise<StoreResult<null>> =>
  adapter.remove?.(key, { signal }) ?? { ok: true, value: null };

/** The revision of a stored value, which this adapter always gives. */
function revisionOf(stored: StoredValue): string {
  assert.ok(stored.revision !== undefined, 'expected a revision');
  return stored.revision;
}

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

runConformance('arangoDbAdapter over a fake ArangoDB', {
  ownWrites: 'notifies',
  create: () => {
    const arango = new FakeArangoDb();
    return {
      adapter: adapterFor(arango),
      reopen: () => adapterFor(arango),
    };
  },
});

void describe('arangoDbAdapter: keys and documents', () => {
  void it('escapes every byte ArangoDB keys may not hold, and keeps prefixes', () => {
    assert.equal(encodeArangoKey('theme-1_a'), 'theme-1_a');
    assert.equal(encodeArangoKey('a.b'), 'a=2Eb');
    assert.equal(encodeArangoKey('a=b'), 'a=3Db');
    assert.equal(encodeArangoKey('a b/*>'), 'a=20b=2F=2A=3E');
    assert.equal(encodeArangoKey('é😀'), '=C3=A9=F0=9F=98=80');
    assert.ok(
      (encodeArangoKey('user/1') ?? '').startsWith(
        encodeArangoKey('user/') ?? '?'
      )
    );
  });

  void it('round-trips awkward keys, and refuses names it did not make', () => {
    for (const key of [
      'a',
      'a.b.c',
      'user/1',
      'é😀',
      'A B',
      '=',
      '..',
      '-',
      '_',
    ]) {
      const name: string | undefined = encodeArangoKey(key);
      assert.ok(name !== undefined, key);
      assert.equal(decodeArangoKey(name), key);
    }
    assert.equal(encodeArangoKey(''), undefined);
    assert.equal(encodeArangoKey('\ud800'), undefined);
    assert.equal(encodeArangoKey('k'.repeat(300)), undefined);
    assert.equal(decodeArangoKey('a.b'), undefined);
    assert.equal(decodeArangoKey('a=2e'), undefined);
    assert.equal(decodeArangoKey('=FF'), undefined);
    assert.equal(decodeArangoKey('=41'), undefined);
  });

  void it('stores each entry as a document with an escaped _key and a text value', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    expectOk(await adapter.set('user/1 é', 'dark', { signal }));
    const documents = arango.collections.get(COLLECTION);
    assert.equal(documents?.get('user=2F1=20=C3=A9')?.value, 'dark');
    assert.equal(
      expectOk(await adapter.get('user/1 é', { signal }))?.value,
      'dark'
    );
  });

  void it('uses the document _rev as the revision', async () => {
    const adapter = adapterFor(new FakeArangoDb());
    const first = expectOk(await adapter.set('k', 'one', { signal }));
    const second = expectOk(await adapter.set('k', 'two', { signal }));
    assert.match(first.revision ?? '', /^_[0-9a-z]{8}---$/);
    assert.notEqual(first.revision, second.revision);
    assert.equal(
      expectOk(await adapter.get('k', { signal }))?.revision,
      second.revision
    );
  });

  void it('refuses keys it cannot store, without asking ArangoDB', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    for (const key of ['', '\ud800', 'k'.repeat(300)]) {
      expectFailure(await adapter.get(key, { signal }), 'invalid', key);
      expectFailure(await adapter.set(key, 'v', { signal }), 'invalid', key);
    }
    assert.deepEqual(arango.requests, []);
  });

  void it('refuses a database or collection name that is not a plain name', async () => {
    const arango = new FakeArangoDb();
    for (const more of [
      { collection: 'bad name' },
      { database: 'a/b' },
      { collection: '' },
    ]) {
      const message = expectFailure(
        await adapterFor(arango, more).get('k', { signal }),
        'invalid',
        'k'
      );
      assert.match(message, /names may hold only letters, digits, _ and -/);
    }
    assert.deepEqual(arango.requests, []);
  });

  void it('uses the database and collection it is given', async () => {
    const arango = new FakeArangoDb('app', ['settings']);
    const adapter = adapterFor(arango, {
      database: 'app',
      collection: 'settings',
    });
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.equal(arango.collections.get('settings')?.size, 1);
    assert.ok(
      arango.requests.every((request) => request.includes('/_db/app/_api/'))
    );
  });

  void it('reports a document that is not an entry as corrupt', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    expectOk(await adapter.set('other', 'x', { signal }));
    arango.failures.push({
      status: 200,
      body: JSON.stringify({ _key: 'k', _rev: '_abc---', other: 1 }),
    });
    expectFailure(await adapter.get('k', { signal }), 'corrupt', 'k');
  });
});

void describe('arangoDbAdapter: writes', () => {
  void it('replaces or creates in one request when no revision is asked for', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    expectOk(await adapter.set('k', 'one', { signal }));
    arango.requests.length = 0;
    expectOk(await adapter.set('k', 'two', { signal }));
    assert.deepEqual(arango.requests, [
      `POST /_db/_system/_api/document/${COLLECTION}?overwriteMode=replace`,
    ]);
  });

  void it('sends the revision in If-Match, quoted, and writes when it matches', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    const first = expectOk(await adapter.set('k', 'one', { signal }));
    const next = expectOk(
      await adapter.set('k', 'two', { signal, ifRevision: revisionOf(first) })
    );
    assert.notEqual(next.revision, first.revision);
    const put = arango.sentHeaders.at(-1);
    assert.equal(put?.['If-Match'], `"${first.revision ?? ''}"`);
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'two');
  });

  void it('reports a conflict naming both revisions and leaves the value alone', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    const first = expectOk(await adapter.set('k', 'one', { signal }));
    const second = expectOk(await adapter.set('k', 'two', { signal }));
    const message = expectFailure(
      await adapter.set('k', 'three', {
        signal,
        ifRevision: revisionOf(first),
      }),
      'conflict',
      'k'
    );
    assert.ok(
      message.includes(`holds revision ${second.revision ?? ''}`),
      message
    );
    assert.ok(
      message.includes(`revision ${first.revision ?? ''} was expected`),
      message
    );
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'two');
  });

  void it('creates a key with nothing stored, even when given a revision', async () => {
    const adapter = adapterFor(new FakeArangoDb());
    expectOk(
      await adapter.set('k', 'v', { signal, ifRevision: '_zzzzzzzz---' })
    );
    expectOk(await removeKey(adapter, 'k'));
    expectOk(
      await adapter.set('k', 'again', { signal, ifRevision: '_zzzzzzzz---' })
    );
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'again');
  });

  void it('treats text that is not a revision as one that never matches, without sending it', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    expectOk(await adapter.set('k', 'v', { signal }));
    arango.requests.length = 0;
    for (const ifRevision of ['', 'has space', 'quo"te', 'x'.repeat(100)]) {
      expectFailure(
        await adapter.set('k', 'w', { signal, ifRevision }),
        'conflict',
        'k'
      );
    }
    assert.ok(
      arango.requests.every((request) => request.startsWith('GET ')),
      arango.requests.join()
    );
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'v');
  });

  void it('reports a conflict, and writes nothing, when another process wrote between the read and the write', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    const first = expectOk(await adapter.set('k', 'one', { signal }));
    let sneaked = false;
    arango.beforeWrite = (collection, key) => {
      if (!sneaked) {
        sneaked = true;
        arango.put(collection, key, 'sneaked in');
      }
    };
    expectFailure(
      await adapter.set('k', 'mine', { signal, ifRevision: revisionOf(first) }),
      'conflict',
      'k'
    );
    assert.equal(
      expectOk(await adapter.get('k', { signal }))?.value,
      'sneaked in'
    );
  });

  void it('reports a conflict when another process created the key between the read and the create', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    expectOk(await adapter.set('other', 'x', { signal }));
    arango.beforeWrite = (collection, key) => {
      if (key === 'k') {
        arango.put(collection, key, 'created first');
        arango.beforeWrite = null;
      }
    };
    expectFailure(
      await adapter.set('k', 'mine', { signal, ifRevision: '_zzzzzzzz---' }),
      'conflict',
      'k'
    );
    assert.equal(
      expectOk(await adapter.get('k', { signal }))?.value,
      'created first'
    );
  });

  void it('removes a key; removing nothing succeeds', async () => {
    const adapter = adapterFor(new FakeArangoDb());
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    assert.equal(expectOk(await adapter.get('k', { signal })), null);
    expectOk(await removeKey(adapter, 'k'));
    expectOk(await removeKey(adapter, 'never'));
  });
});

void describe('arangoDbAdapter: the collection', () => {
  void it('creates the collection once, before the first use', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    expectOk(await adapter.set('a', '1', { signal }));
    expectOk(await adapter.get('a', { signal }));
    expectOk(await adapter.set('b', '2', { signal }));
    assert.equal(
      arango.requests.filter((request) =>
        request.startsWith('POST /_db/_system/_api/collection')
      ).length,
      1
    );
    assert.ok(arango.collections.has(COLLECTION));
  });

  void it('is fine with a collection that is already there', async () => {
    const arango = new FakeArangoDb('_system', [COLLECTION]);
    expectOk(await adapterFor(arango).set('k', 'v', { signal }));
    assert.equal(arango.collections.get(COLLECTION)?.size, 1);
  });

  void it('carries on when the account may not create collections', async () => {
    const arango = new FakeArangoDb('_system', [COLLECTION]);
    arango.failures.push({
      status: 403,
      body: '{"errorNum":11,"errorMessage":"forbidden"}',
    });
    expectOk(await adapterFor(arango).set('k', 'v', { signal }));
  });

  void it('reports a failed creation and tries again next time', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    arango.failures.push({
      status: 503,
      body: '{"errorNum":503,"errorMessage":"unavailable"}',
    });
    const message = expectFailure(
      await adapter.set('k', 'v', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /collection could not be created/);
    expectOk(await adapter.set('k', 'v', { signal }));
  });

  void it('does not create anything when told not to, and says the collection is missing', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango, { createCollection: false });
    const message = expectFailure(
      await adapter.get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /collection "storage_entry" does not exist/);
    assert.ok(
      arango.requests.every((request) => !request.includes('/collection'))
    );
  });

  void it('says when the database is missing', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango, {
      database: 'nope',
      createCollection: false,
    });
    const message = expectFailure(
      await adapter.get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /database "nope" does not exist/);
  });
});

void describe('arangoDbAdapter: list', () => {
  void it('lists keys under a prefix, in order, skipping documents it did not write', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
    for (const key of ['user/2', 'user/1', 'users', 'other', 'é.😀']) {
      expectOk(await adapter.set(key, key, { signal }));
    }
    arango.put(COLLECTION, 'plain.name', 'written by something else');
    const list = async (prefix: string): Promise<readonly string[]> =>
      expectOk(
        (await adapter.list?.(prefix, { signal })) ?? { ok: true, value: [] }
      );
    assert.deepEqual(await list('user/'), ['user/1', 'user/2']);
    assert.deepEqual(await list(''), [
      'other',
      'user/1',
      'user/2',
      'users',
      'é.😀',
    ]);
    assert.deepEqual(await list('é.'), ['é.😀']);
    assert.deepEqual(await list('nothing'), []);
    assert.deepEqual(await list('\ud800'), []);
  });

  void it('does not list removed keys', async () => {
    const adapter = adapterFor(new FakeArangoDb());
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

  void it('follows the cursor through every batch', async () => {
    const arango = new FakeArangoDb('_system', [COLLECTION]);
    const adapter = adapterFor(arango);
    const keys: string[] = [];
    for (let index = 0; index < 2350; index += 1) {
      const key = `n${String(index).padStart(5, '0')}`;
      keys.push(key);
      arango.put(COLLECTION, key, 'v');
    }
    const listed = expectOk(
      (await adapter.list?.('n', { signal })) ?? { ok: true, value: [] }
    );
    assert.deepEqual(listed, keys);
    assert.equal(
      arango.requests.filter((request) => request.includes('/_api/cursor'))
        .length,
      3
    );
  });

  void it('names the prefix when listing fails', async () => {
    const arango = new FakeArangoDb('_system', [COLLECTION]);
    arango.failures.push({
      status: 500,
      body: '{"errorNum":500,"errorMessage":"boom"}',
    });
    const result = await adapterFor(arango).list?.('user/', { signal });
    assert.ok(result !== undefined && !result.ok);
    assert.equal(result.code, 'unavailable');
    assert.ok(
      result.error.includes('"user/"') && result.error.includes('boom'),
      result.error
    );
  });
});

void describe('arangoDbAdapter: failures', () => {
  const cases: readonly [number, string][] = [
    [401, 'forbidden'],
    [403, 'forbidden'],
    [413, 'quota'],
    [400, 'invalid'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ];
  for (const [status, code] of cases) {
    void it(`maps HTTP ${String(status)} to ${code}, naming the key and what ArangoDB said`, async () => {
      const arango = new FakeArangoDb('_system', [COLLECTION]);
      arango.failures.push({
        status,
        body: JSON.stringify({
          error: true,
          code: status,
          errorNum: 77,
          errorMessage: 'because',
        }),
      });
      const adapter = adapterFor(arango, { createCollection: false });
      const message = expectFailure(
        await adapter.get('k', { signal }),
        code,
        'k'
      );
      assert.ok(
        message.includes(`HTTP ${String(status)}: because (error 77)`),
        message
      );
    });
  }

  void it('reports a network error as unavailable', async () => {
    const arango = new FakeArangoDb('_system', [COLLECTION]);
    arango.failures.push({
      error: new Error('connect ECONNREFUSED 127.0.0.1:8529'),
    });
    const message = expectFailure(
      await adapterFor(arango).set('k', 'v', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /ECONNREFUSED/);
  });

  void it('does not send anything when the request was aborted', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
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
    assert.deepEqual(arango.requests, []);
  });

  void it('sends the configured headers on every request, calling a function each time', async () => {
    const arango = new FakeArangoDb();
    let counter = 0;
    const adapter = adapterFor(arango, {
      headers: () => ({
        Authorization: `Bearer token${String((counter += 1))}`,
      }),
    });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await adapter.get('k', { signal }));
    const tokens = arango.sentHeaders.map((headers) => headers.Authorization);
    assert.ok(tokens.length >= 3);
    assert.equal(new Set(tokens).size, tokens.length);
    assert.ok(tokens.every((value) => value?.startsWith('Bearer token')));
  });
});

void describe('arangoDbAdapter: subscribe', () => {
  void it('reports writes and removals made through the same adapter, once each, without polling', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango);
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
    assert.ok(
      arango.requests.every((request) => !request.includes('/_api/cursor'))
    );
  });

  void it('hears a write and a removal made by another process when polling', async () => {
    const arango = new FakeArangoDb('_system', [COLLECTION]);
    const adapter = adapterFor(arango, { pollIntervalMs: 50 });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(80);
    const revision = arango.put(COLLECTION, 'k', 'from elsewhere');
    await eventually(() => seen.length === 1, 'the write');
    arango.delete(COLLECTION, 'k');
    await eventually(() => seen.length === 2, 'the removal');
    stop();
    assert.deepEqual(seen, [{ value: 'from elsewhere', revision }, null]);
  });

  void it('does not report what was stored when it subscribed', async () => {
    const arango = new FakeArangoDb('_system', [COLLECTION]);
    arango.put(COLLECTION, 'k', 'old');
    const adapter = adapterFor(arango, { pollIntervalMs: 50 });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(200);
    stop();
    assert.equal(seen.length, 0);
  });

  void it('reports a write made through the same adapter once, even while polling', async () => {
    const arango = new FakeArangoDb();
    const adapter = adapterFor(arango, { pollIntervalMs: 50 });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(80);
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('k', 'two', { signal }));
    await tick(250);
    stop();
    assert.deepEqual(
      seen.map((stored) => stored?.value ?? null),
      ['one', 'two']
    );
  });

  void it('does not believe a poll that was answered before a write made through the same adapter', async () => {
    const arango = new FakeArangoDb('_system', [COLLECTION]);
    let slow = false;
    const adapter = adapterFor(arango, {
      pollIntervalMs: 50,
      fetch: async (url, init) => {
        const answer = await arango.fetch(url, init);
        if (slow && url.includes('/_api/cursor')) {
          await tick(150); // The answer was worked out before the write below.
        }
        return answer;
      },
    });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(120);
    const cursorRequests = (): number =>
      arango.requests.filter((request) => request.includes('/_api/cursor'))
        .length;
    slow = true;
    const before: number = cursorRequests();
    await eventually(() => cursorRequests() > before, 'a poll to start');
    expectOk(await adapter.set('k', 'mine', { signal }));
    slow = false;
    await tick(400);
    stop();
    assert.deepEqual(
      seen.map((stored) => stored?.value ?? null),
      ['mine']
    );
  });

  void it('polls every subscribed key with one query, and stops when the last one leaves', async () => {
    const arango = new FakeArangoDb('_system', [COLLECTION]);
    const adapter = adapterFor(arango, { pollIntervalMs: 50 });
    const stopA = adapter.subscribe?.('a', unsubscribed) ?? unsubscribed;
    const stopB = adapter.subscribe?.('b', unsubscribed) ?? unsubscribed;
    await tick(200);
    stopA();
    await tick(120);
    const polledWithOne = arango.requests.length;
    assert.ok(polledWithOne > 0);
    stopB();
    await tick(120);
    const afterStop = arango.requests.length;
    await tick(200);
    assert.equal(arango.requests.length, afterStop);
  });

  void it('reports a failing poll once per run of failures, and carries on', async () => {
    const arango = new FakeArangoDb('_system', [COLLECTION]);
    const messages: string[] = [];
    const adapter = adapterFor(arango, {
      pollIntervalMs: 50,
      onPollError: (message) => messages.push(message),
    });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(80);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      arango.failures.push({
        status: 503,
        body: '{"errorNum":503,"errorMessage":"restarting"}',
      });
    }
    await tick(300);
    assert.equal(messages.length, 1);
    assert.match(
      messages[0] ?? '',
      /could not poll collection "storage_entry" for changes \(.*restarting/
    );
    arango.put(COLLECTION, 'k', 'after the outage');
    await eventually(() => seen.length === 1, 'recovery');
    stop();
    assert.equal(seen[0]?.value, 'after the outage');
  });

  void it('survives a listener that throws', async () => {
    const adapter = adapterFor(new FakeArangoDb());
    const stop =
      adapter.subscribe?.('k', () => {
        throw new Error('listener bug');
      }) ?? unsubscribed;
    expectOk(await adapter.set('k', 'v', { signal }));
    stop();
  });
});
