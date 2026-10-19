/**
 * The CouchDB adapter, over an in-memory stand-in for CouchDB's HTTP API
 * (test/support/fake-couchdb.ts), so the default test run stays offline.
 * test/couchdb-server.test.ts runs the same adapter against a real server.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { couchDbAdapter } from '../src/couchdb/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeCouchDb } from './support/fake-couchdb.js';

const signal: AbortSignal = new AbortController().signal;
const REVISION = /^[1-9][0-9]*-[0-9a-f]{32}$/;

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
  assert.ok(result.error.startsWith('CouchDB '), result.error);
  return result.error;
}

function adapterFor(
  couch: FakeCouchDb,
  more: Partial<Parameters<typeof couchDbAdapter>[0]> = {}
): StorageAdapter {
  return couchDbAdapter({
    url: 'http://couch.test:5984/',
    database: couch.database,
    fetch: couch.fetch,
    changesTimeoutMs: 2000,
    changesRetryMs: 20,
    ...more,
  });
}

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

runConformance('couchDbAdapter over a fake CouchDB', {
  ownWrites: 'notifies',
  create: () => {
    const couch = new FakeCouchDb();
    return {
      adapter: adapterFor(couch),
      reopen: () => adapterFor(couch),
    };
  },
});

void describe('couchDbAdapter: keys and documents', () => {
  void it('stores each entry as a document with a prefixed id', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    expectOk(await adapter.set('theme', 'dark', { signal }));
    assert.equal(couch.documents.get('storage:theme')?.value, 'dark');
    assert.ok(
      couch.requests.some((r) => r.startsWith('PUT /settings/storage%3Atheme'))
    );
  });

  void it('keeps slashes, spaces and emoji in the id', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    const key = 'user/1 é😀?#';
    expectOk(await adapter.set(key, 'v', { signal }));
    assert.equal(expectOk(await adapter.get(key, { signal }))?.value, 'v');
    assert.ok(couch.documents.has(`storage:${key}`));
  });

  void it('uses the document revision as the revision', async () => {
    const adapter = adapterFor(new FakeCouchDb());
    const first = expectOk(await adapter.set('k', 'one', { signal }));
    assert.match(first.revision ?? '', REVISION);
    const second = expectOk(await adapter.set('k', 'two', { signal }));
    assert.match(second.revision ?? '', /^2-/);
    assert.notEqual(first.revision, second.revision);
  });

  void it('refuses ids CouchDB cannot hold, without asking it', async () => {
    const couch = new FakeCouchDb();
    const plain = adapterFor(couch, { prefix: '' });
    const message = expectFailure(
      await plain.set('_hidden', 'v', { signal }),
      'invalid',
      '_hidden'
    );
    assert.match(message, /start with "_"/);
    expectFailure(await plain.get('', { signal }), 'invalid', '');
    const prefixed = adapterFor(couch);
    expectFailure(
      await prefixed.set('\ud800', 'v', { signal }),
      'invalid',
      '\ud800'
    );
    expectFailure(
      await prefixed.set('k'.repeat(2000), 'v', { signal }),
      'invalid',
      'k'.repeat(2000)
    );
    expectFailure(
      await prefixed.set('k', '\udc00', { signal }),
      'invalid',
      'k'
    );
    assert.deepEqual(couch.requests, []);
  });

  void it('allows keys that start with an underscore under a prefix', async () => {
    const adapter = adapterFor(new FakeCouchDb());
    expectOk(await adapter.set('_hidden', 'v', { signal }));
    assert.equal(
      expectOk(await adapter.get('_hidden', { signal }))?.value,
      'v'
    );
  });

  void it('keeps adapters with different prefixes apart in one database', async () => {
    const couch = new FakeCouchDb();
    const first = adapterFor(couch, { prefix: 'a:' });
    const second = adapterFor(couch, { prefix: 'b:' });
    expectOk(await first.set('k', '1', { signal }));
    expectOk(await second.set('k', '2', { signal }));
    assert.equal(expectOk(await first.get('k', { signal }))?.value, '1');
    assert.deepEqual(
      expectOk((await first.list?.('', { signal })) ?? { ok: true, value: [] }),
      ['k']
    );
  });

  void it('reports a document that is not an entry as corrupt', async () => {
    const couch = new FakeCouchDb();
    couch.failures.push({
      status: 200,
      body: JSON.stringify({
        _id: 'storage:k',
        _rev: '1-' + 'a'.repeat(32),
        other: 1,
      }),
    });
    expectFailure(await adapterFor(couch).get('k', { signal }), 'corrupt', 'k');
  });
});

void describe('couchDbAdapter: writes', () => {
  void it('reports a conflict naming both revisions and leaves the value alone', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
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

  void it('writes when the revision matches', async () => {
    const adapter = adapterFor(new FakeCouchDb());
    const first = expectOk(await adapter.set('k', 'one', { signal }));
    const next = expectOk(
      await adapter.set('k', 'two', { signal, ifRevision: revisionOf(first) })
    );
    assert.match(next.revision ?? '', /^2-/);
  });

  void it('creates a key with nothing stored, even when given a revision', async () => {
    const adapter = adapterFor(new FakeCouchDb());
    expectOk(
      await adapter.set('k', 'v', { signal, ifRevision: '4-' + 'a'.repeat(32) })
    );
    expectOk(
      (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
    );
    expectOk(
      await adapter.set('k', 'again', {
        signal,
        ifRevision: '1-' + 'b'.repeat(32),
      })
    );
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'again');
  });

  void it('treats text that is not a revision as one that never matches, without sending it', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    expectOk(await adapter.set('k', 'v', { signal }));
    couch.requests.length = 0;
    expectFailure(
      await adapter.set('k', 'w', { signal, ifRevision: 'abc' }),
      'conflict',
      'k'
    );
    assert.ok(
      couch.requests.every((r) => r.startsWith('GET ')),
      couch.requests.join()
    );
  });

  void it('replaces a value that another process changed between the read and the write', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    expectOk(await adapter.set('k', 'one', { signal }));
    let first = true;
    const racing = adapterFor(couch, {
      fetch: async (url, init) => {
        const answer = await couch.fetch(url, init);
        if (first && init.method === 'GET') {
          first = false;
          couch.put('storage:k', 'sneaked in');
        }
        return answer;
      },
    });
    const stored = expectOk(await racing.set('k', 'mine', { signal }));
    assert.match(stored.revision ?? '', /^3-/);
    assert.equal(couch.documents.get('storage:k')?.value, 'mine');
  });

  void it('gives up on a last-write-wins write that always meets a newer revision', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    expectOk(await adapter.set('k', 'one', { signal }));
    const racing = adapterFor(couch, {
      fetch: async (url, init) => {
        if (init.method === 'GET') {
          const answer = await couch.fetch(url, init);
          couch.put('storage:k', 'again');
          return answer;
        }
        return couch.fetch(url, init);
      },
    });
    const message = expectFailure(
      await racing.set('k', 'mine', { signal }),
      'conflict',
      'k'
    );
    assert.match(message, /kept changing/);
  });

  void it('removes a key and reads it as missing; removing nothing succeeds', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(
      (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
    );
    assert.equal(expectOk(await adapter.get('k', { signal })), null);
    expectOk(
      (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
    );
    expectOk(
      (await adapter.remove?.('never', { signal })) ?? { ok: true, value: null }
    );
    expectOk(await adapter.set('k', 'back', { signal }));
    assert.match(couch.documents.get('storage:k')?.revision ?? '', /^3-/);
  });
});

void describe('couchDbAdapter: list', () => {
  void it('lists keys under a prefix in order, skipping other prefixes and design documents', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    for (const key of ['user/2', 'user/1', 'users', 'other', 'é.😀']) {
      expectOk(await adapter.set(key, key, { signal }));
    }
    couch.put('elsewhere', 'not ours');
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
    assert.deepEqual(await list('nothing'), []);
  });

  void it('skips design documents when there is no prefix', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch, { prefix: '' });
    expectOk(await adapter.set('a', '1', { signal }));
    expectOk(await adapter.set('b', '2', { signal }));
    assert.ok(couch.documents.has('_design/views'));
    assert.deepEqual(
      expectOk(
        (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
      ),
      ['a', 'b']
    );
  });

  void it('does not list removed keys', async () => {
    const adapter = adapterFor(new FakeCouchDb());
    expectOk(await adapter.set('a', '1', { signal }));
    expectOk(await adapter.set('b', '2', { signal }));
    expectOk(
      (await adapter.remove?.('a', { signal })) ?? { ok: true, value: null }
    );
    assert.deepEqual(
      expectOk(
        (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
      ),
      ['b']
    );
  });

  void it('reads every page', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    const keys: string[] = [];
    for (let index = 0; index < 2350; index += 1) {
      const key = `n${String(index).padStart(5, '0')}`;
      keys.push(key);
      couch.put(`storage:${key}`, 'v');
    }
    couch.put('zzz-other', 'x');
    const listed = expectOk(
      (await adapter.list?.('n', { signal })) ?? { ok: true, value: [] }
    );
    assert.deepEqual(listed, keys);
    assert.equal(
      couch.requests.filter((r) => r.includes('_all_docs')).length,
      3
    );
  });

  void it('names the prefix when listing fails', async () => {
    const couch = new FakeCouchDb();
    couch.failures.push({
      status: 500,
      body: '{"error":"internal","reason":"boom"}',
    });
    const result = await adapterFor(couch).list?.('user/', { signal });
    assert.ok(result !== undefined && !result.ok);
    assert.equal(result.code, 'unavailable');
    assert.ok(
      result.error.includes('"user/"') && result.error.includes('boom'),
      result.error
    );
  });
});

void describe('couchDbAdapter: failures', () => {
  const cases: readonly [number, string, string][] = [
    [401, 'unauthorized', 'forbidden'],
    [403, 'forbidden', 'forbidden'],
    [413, 'too_large', 'quota'],
    [400, 'bad_request', 'invalid'],
    [500, 'internal', 'unavailable'],
    [503, 'unavailable', 'unavailable'],
  ];
  for (const [status, error, code] of cases) {
    void it(`maps HTTP ${String(status)} to ${code}, naming the key and what CouchDB said`, async () => {
      const couch = new FakeCouchDb();
      couch.failures.push({
        status,
        body: JSON.stringify({ error, reason: 'because' }),
      });
      const message = expectFailure(
        await adapterFor(couch).get('k', { signal }),
        code,
        'k'
      );
      assert.ok(
        message.includes(`HTTP ${String(status)}: ${error}: because`),
        message
      );
    });
  }

  void it('reports a database that does not exist, and says so', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch, { database: 'nope' });
    const message = expectFailure(
      await adapter.get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /database "nope" does not exist/);
  });

  void it('reports a network error as unavailable', async () => {
    const couch = new FakeCouchDb();
    couch.failures.push({
      error: new Error('connect ECONNREFUSED 127.0.0.1:5984'),
    });
    const message = expectFailure(
      await adapterFor(couch).set('k', 'v', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /ECONNREFUSED/);
  });

  void it('does not send anything when the request was aborted', async () => {
    const couch = new FakeCouchDb();
    const controller = new AbortController();
    controller.abort();
    const adapter = adapterFor(couch);
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
    const listed = await adapter.list?.('', { signal: controller.signal });
    assert.ok(listed !== undefined && !listed.ok);
    assert.deepEqual(couch.requests, []);
  });

  void it('sends the configured headers on every request, calling a function each time', async () => {
    const couch = new FakeCouchDb();
    const seen: (string | undefined)[] = [];
    let counter = 0;
    const adapter = adapterFor(couch, {
      headers: () => ({
        Authorization: `Basic token${String((counter += 1))}`,
      }),
      fetch: (url, init) => {
        seen.push(init.headers.Authorization);
        return couch.fetch(url, init);
      },
    });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await adapter.get('k', { signal }));
    assert.ok(seen.length >= 3);
    assert.equal(new Set(seen).size, seen.length);
    assert.ok(seen.every((value) => value?.startsWith('Basic token')));
  });
});

void describe('couchDbAdapter: subscribe', () => {
  void it('hears a write and a removal made by another process', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick();
    const revision = couch.put('storage:k', 'from elsewhere');
    await eventually(() => seen.length === 1, 'the write');
    couch.delete('storage:k');
    await eventually(() => seen.length === 2, 'the removal');
    stop();
    assert.deepEqual(seen, [{ value: 'from elsewhere', revision }, null]);
  });

  void it('reports a write made through the same adapter once', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick();
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('k', 'two', { signal }));
    expectOk(
      (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
    );
    await tick(150);
    stop();
    assert.deepEqual(
      seen.map((stored) => stored?.value ?? null),
      ['one', 'two', null]
    );
  });

  void it('does not report what was stored before it subscribed', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    couch.put('storage:k', 'old');
    couch.put('storage:gone', 'old');
    couch.delete('storage:gone');
    const seen: (StoredValue | null)[] = [];
    const stops = [
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed,
      adapter.subscribe?.('gone', (stored) => seen.push(stored)) ??
        unsubscribed,
    ];
    await tick(150);
    assert.deepEqual(seen, []);
    stops.forEach((stop) => stop());
  });

  void it('does not report a change made before a key was subscribed, when a second key restarts the feed', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    const stopFirst = adapter.subscribe?.('a', unsubscribed) ?? unsubscribed;
    await tick();
    // Nothing for `a` arrives, so the feed's position stays where it was.
    couch.put('storage:b', 'written before anyone subscribed to b');
    const seen: (StoredValue | null)[] = [];
    const stopSecond =
      adapter.subscribe?.('b', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(150);
    assert.equal(seen.length, 0);
    couch.put('storage:b', 'a real change');
    await eventually(() => seen.length === 1, 'the real change');
    assert.equal(seen[0]?.value, 'a real change');
    stopFirst();
    stopSecond();
  });

  void it('does not ask for changes when nothing is subscribed', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    expectOk(await adapter.set('k', 'v', { signal }));
    await tick();
    assert.ok(couch.requests.every((r) => !r.includes('_changes')));
  });

  void it('follows every subscribed key with one request, restarted when a key is added', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    const first: (StoredValue | null)[] = [];
    const second: (StoredValue | null)[] = [];
    const stopFirst =
      adapter.subscribe?.('a', (stored) => first.push(stored)) ?? unsubscribed;
    await tick();
    const stopSecond =
      adapter.subscribe?.('b', (stored) => second.push(stored)) ?? unsubscribed;
    await tick(80);
    assert.equal(couch.openChangesRequests, 1);
    couch.put('storage:a', '1');
    couch.put('storage:b', '2');
    await eventually(
      () => first.length === 1 && second.length === 1,
      'both writes'
    );
    stopFirst();
    stopSecond();
  });

  void it('stops asking for changes when the last subscriber leaves', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    const stopOne = adapter.subscribe?.('k', unsubscribed) ?? unsubscribed;
    const stopTwo = adapter.subscribe?.('k', unsubscribed) ?? unsubscribed;
    await tick();
    assert.equal(couch.openChangesRequests, 1);
    stopOne();
    stopOne();
    await tick();
    assert.equal(couch.openChangesRequests, 1);
    stopTwo();
    await tick();
    assert.equal(couch.openChangesRequests, 0);
    const requests = couch.requests.length;
    await tick(100);
    assert.equal(couch.requests.length, requests);
  });

  void it('reports a failure, then listens again and misses nothing', async () => {
    const couch = new FakeCouchDb();
    const messages: string[] = [];
    const adapter = adapterFor(couch, {
      onChangesError: (message) => messages.push(message),
    });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick();
    couch.failures.push({
      status: 503,
      body: '{"error":"unavailable","reason":"restarting"}',
    });
    couch.put('storage:k', 'during the outage');
    await eventually(
      () => messages.length > 0 && seen.length === 1,
      'recovery'
    );
    stop();
    assert.equal(messages.length, 1);
    assert.match(
      messages[0] ?? '',
      /could not listen for changes for database "settings" \(.*restarting/
    );
    assert.equal(seen[0]?.value, 'during the outage');
  });

  void it('starts again from now when the server rejects the position', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch, { onChangesError: () => undefined });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick();
    couch.failures.push({
      status: 400,
      body: '{"error":"bad_request","reason":"bad since"}',
    });
    couch.put('storage:k', 'one');
    await tick(120);
    couch.put('storage:k', 'two');
    await eventually(
      () => seen.some((stored) => stored?.value === 'two'),
      'the later write'
    );
    stop();
  });

  void it('does not retry when retrying is turned off', async () => {
    const couch = new FakeCouchDb();
    const messages: string[] = [];
    const adapter = adapterFor(couch, {
      changesRetryMs: 0,
      onChangesError: (message) => messages.push(message),
    });
    couch.failures.push({ error: new Error('connect ECONNREFUSED') });
    const stop = adapter.subscribe?.('k', unsubscribed) ?? unsubscribed;
    await tick(120);
    stop();
    assert.equal(messages.length, 1);
    assert.equal(couch.openChangesRequests, 0);
  });

  void it('survives a listener that throws', async () => {
    const couch = new FakeCouchDb();
    const adapter = adapterFor(couch);
    const stop =
      adapter.subscribe?.('k', () => {
        throw new Error('listener bug');
      }) ?? unsubscribed;
    await tick();
    expectOk(await adapter.set('k', 'v', { signal }));
    stop();
  });
});
