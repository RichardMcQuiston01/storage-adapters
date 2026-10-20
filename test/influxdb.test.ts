/**
 * The InfluxDB adapter, over an in-memory stand-in for InfluxDB's HTTP API
 * (test/support/fake-influxdb.ts), so the default test run stays offline.
 * test/influxdb-server.test.ts runs the same adapter against a real server.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeInfluxKey,
  encodeInfluxKey,
  escapeInfluxValue,
  influxDbAdapter,
  unescapeInfluxValue,
  type InfluxDbAdapterOptions,
} from '../src/influxdb/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeInfluxDb } from './support/fake-influxdb.js';

const signal: AbortSignal = new AbortController().signal;
const MEASUREMENT = 'storage_entry';

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
  assert.ok(result.error.startsWith('InfluxDB '), result.error);
  return result.error;
}

function adapterFor(
  influx: FakeInfluxDb,
  more: Partial<InfluxDbAdapterOptions> = {}
): StorageAdapter {
  return influxDbAdapter({
    url: 'http://influx.test:8086/',
    fetch: influx.fetch,
    org: 'my-org',
    bucket: 'app',
    ...more,
  });
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

runConformance('influxDbAdapter over a fake server', {
  ownWrites: 'notifies',
  create: () => {
    const influx = new FakeInfluxDb();
    return {
      adapter: adapterFor(influx),
      reopen: () => adapterFor(influx),
    };
  },
});

void describe('influxDbAdapter: key and value escaping', () => {
  void it('keeps letters, digits and _.:@/- and escapes every other byte', () => {
    assert.equal(encodeInfluxKey('user/1.v2:a@b-c_d'), 'user/1.v2:a@b-c_d');
    assert.equal(encodeInfluxKey('a b,c=d'), 'a%20b%2Cc%3Dd');
    assert.equal(encodeInfluxKey('é😀'), '%C3%A9%F0%9F%98%80');
    assert.equal(encodeInfluxKey('new\nline'), 'new%0Aline');
    assert.equal(encodeInfluxKey('100%'), '100%25');
  });

  void it('stores the empty key as ~, and a real ~ as %7E', () => {
    assert.equal(encodeInfluxKey(''), '~');
    assert.equal(encodeInfluxKey('~'), '%7E');
    assert.equal(decodeInfluxKey('~'), '');
    assert.equal(decodeInfluxKey('%7E'), '~');
  });

  void it('round-trips keys, and refuses what it could not have written', () => {
    for (const key of [
      '',
      'a',
      'a b',
      '😀/é',
      '~',
      '%',
      '%41',
      'x'.repeat(300),
    ]) {
      assert.equal(decodeInfluxKey(encodeInfluxKey(key) ?? ''), key);
    }
    for (const name of ['a b', 'a%2', 'a%zz', '%FF', 'é', 'a%41', '%e9']) {
      assert.equal(decodeInfluxKey(name), undefined, name);
    }
  });

  void it('refuses a lone surrogate, and a key over 1024 escaped characters', () => {
    assert.equal(encodeInfluxKey('\ud800'), undefined);
    assert.equal(encodeInfluxKey('k'.repeat(1024))?.length, 1024);
    assert.equal(encodeInfluxKey('k'.repeat(1025)), undefined);
    assert.equal(encodeInfluxKey('é'.repeat(200)), undefined);
  });

  void it('escapes backslash, newline, carriage return and NUL in values, and reverses it', () => {
    const value = 'a\\b\nc\rd\0e "q", \\n';
    const escaped = escapeInfluxValue(value);
    assert.doesNotMatch(escaped, /[\n\r\0]/);
    assert.equal(unescapeInfluxValue(escaped), value);
    assert.equal(unescapeInfluxValue(''), '');
    assert.equal(unescapeInfluxValue('plain 😀'), 'plain 😀');
    assert.equal(unescapeInfluxValue('bad \\x escape'), undefined);
    assert.equal(unescapeInfluxValue('dangling \\'), undefined);
  });
});

void describe('influxDbAdapter: entries and revisions', () => {
  void it('gives every write a new revision, and get returns what set did', async () => {
    const adapter = adapterFor(new FakeInfluxDb());
    const seen = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const written = expectOk(
        await adapter.set('k', `v${String(index)}`, { signal })
      );
      assert.ok(!seen.has(written.revision as string));
      seen.add(written.revision as string);
      assert.deepEqual(expectOk(await adapter.get('k', { signal })), written);
    }
  });

  void it('writes one line at the fixed timestamp, with the key as the tag', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
    const written = expectOk(await adapter.set('a b,c', 'x "y"', { signal }));
    const request = influx.requests[0];
    assert.equal(request?.method, 'POST');
    assert.equal(
      request?.path,
      '/api/v2/write?org=my-org&bucket=app&precision=ns'
    );
    assert.match(
      request?.body ?? '',
      new RegExp(
        `^${MEASUREMENT},entry_key=a%20b%2Cc value="x \\\\"y\\\\"",revision="${written.revision as string}",updated_at=\\d+i 0$`
      )
    );
  });

  void it('writes without reading first when no revision is given', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
    expectOk(await adapter.set('k', 'one', { signal }));
    expectOk(await adapter.set('k', 'two', { signal }));
    assert.deepEqual(
      influx.requests.map((request) => request.path.split('?')[0]),
      ['/api/v2/write', '/api/v2/write']
    );
  });

  void it('reads, compares and then writes when given a revision, and says who holds the key when it differs', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
    const first = expectOk(await adapter.set('k', 'one', { signal }));
    influx.requests.length = 0;
    const second = expectOk(
      await adapter.set('k', 'two', {
        signal,
        ifRevision: first.revision as string,
      })
    );
    assert.deepEqual(
      influx.requests.map((request) => request.path.split('?')[0]),
      ['/api/v2/query', '/api/v2/write']
    );
    const message = expectFailure(
      await adapter.set('k', 'three', {
        signal,
        ifRevision: first.revision as string,
      }),
      'conflict',
      'k'
    );
    assert.ok(
      message.includes(
        `holds revision ${second.revision as string}, but revision ${first.revision as string} was expected`
      ),
      message
    );
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'two');
  });

  void it('creates a key with nothing stored, even when given a revision', async () => {
    const adapter = adapterFor(new FakeInfluxDb());
    expectOk(await adapter.set('k', 'v', { signal, ifRevision: 'old' }));
    expectOk(await removeKey(adapter, 'k'));
    expectOk(await adapter.set('k', 'again', { signal, ifRevision: 'old' }));
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'again');
  });

  void it('lets the writers that share an adapter take turns, so only one holding the same revision wins', async () => {
    const influx = new FakeInfluxDb();
    influx.writeLatencyMs = 15;
    const adapter = adapterFor(influx);
    const first = expectOk(await adapter.set('k', 'start', { signal }));
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        adapter.set('k', `writer ${String(index)}`, {
          signal,
          ifRevision: first.revision as string,
        })
      )
    );
    assert.equal(results.filter((result) => result.ok).length, 1);
  });

  void it('cannot stop another process writing between its read and its write (last write wins)', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
    const first = expectOk(await adapter.set('k', 'one', { signal }));
    influx.beforeWrite = (measurement, key) => {
      influx.beforeWrite = null;
      influx.put(measurement, key, {
        value: 'from elsewhere',
        revision: 'theirs',
        updatedAt: '1',
      });
    };
    const written = await adapter.set('k', 'mine', {
      signal,
      ifRevision: first.revision as string,
    });
    assert.ok(written.ok);
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'mine');
  });

  void it('removes with the delete API, and removing a missing key is fine', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
    expectOk(await adapter.set('a b', 'x', { signal }));
    influx.requests.length = 0;
    expectOk(await removeKey(adapter, 'a b'));
    expectOk(await removeKey(adapter, 'never there'));
    const request = influx.requests[0];
    assert.equal(request?.path, '/api/v2/delete?org=my-org&bucket=app');
    assert.deepEqual(JSON.parse(request?.body ?? '{}'), {
      start: '1970-01-01T00:00:00Z',
      stop: '1970-01-01T00:00:01Z',
      predicate: '_measurement="storage_entry" AND entry_key="a%20b"',
    });
    assert.equal(expectOk(await adapter.get('a b', { signal })), null);
  });

  void it('reports a point that is not an entry as corrupt, and lets a remove clear it', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
    for (const point of [
      { value: 'no revision' },
      { value: 'another tag', revision: 'r1', extraTags: { extra: 'tag' } },
      { value: 'bad \\x escape', revision: 'r1' },
      { value: null, revision: null },
    ]) {
      influx.put(MEASUREMENT, 'k', point);
      const message = expectFailure(
        await adapter.get('k', { signal }),
        'corrupt',
        'k'
      );
      assert.match(message, /remove the key to start again/);
      expectOk(await removeKey(adapter, 'k'));
      assert.equal(expectOk(await adapter.get('k', { signal })), null);
    }
  });
});

void describe('influxDbAdapter: requests', () => {
  void it('sends the headers it is given, and calls a function for each request', async () => {
    const influx = new FakeInfluxDb();
    let calls = 0;
    const adapter = adapterFor(influx, {
      headers: () => {
        calls += 1;
        return { Authorization: `Token t${String(calls)}` };
      },
    });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await adapter.get('k', { signal }));
    assert.deepEqual(
      influx.requests.map((request) => request.headers.Authorization),
      ['Token t1', 'Token t2']
    );
    const fixed = new FakeInfluxDb();
    expectOk(
      await adapterFor(fixed, { headers: { Authorization: 'Token abc' } }).get(
        'k',
        { signal }
      )
    );
    assert.equal(fixed.requests[0]?.headers.Authorization, 'Token abc');
  });

  void it('asks for Flux, in the organization, over the fixed time range', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
    expectOk(await adapter.get('k', { signal }));
    const request = influx.requests[0];
    assert.equal(request?.path, '/api/v2/query?org=my-org');
    assert.equal(request?.headers['Content-Type'], 'application/vnd.flux');
    assert.equal(request?.headers.Accept, 'application/csv');
    assert.match(
      request?.body ?? '',
      /^from\(bucket: "app"\) \|> range\(start: 1970-01-01T00:00:00Z, stop: 1970-01-01T00:00:01Z\) \|> filter\(fn: \(r\) => r\._measurement == "storage_entry" and r\.entry_key == "k"\)/
    );
  });

  void it('quotes bucket, measurement and key safely in Flux', async () => {
    const influx = new FakeInfluxDb();
    influx.buckets.add('we"ird\\bucket');
    const adapter = adapterFor(influx, { bucket: 'we"ird\\bucket' });
    expectOk(await adapter.get('${x}', { signal }));
    const body = influx.requests[0]?.body ?? '';
    assert.ok(body.includes('from(bucket: "we\\"ird\\\\bucket")'), body);
    assert.ok(body.includes('r.entry_key == "%24%7Bx%7D"'), body);
  });

  void it('refuses a measurement that is not a plain name, without asking InfluxDB', async () => {
    const influx = new FakeInfluxDb();
    for (const measurement of [
      'bad name',
      'a;drop',
      'a.b',
      '1abc',
      'x" or 1==1',
    ]) {
      const adapter = adapterFor(influx, { measurement });
      const message = expectFailure(
        await adapter.get('k', { signal }),
        'invalid',
        'k'
      );
      assert.match(message, /cannot use measurement/);
      const listed = await adapter.list?.('', { signal });
      assert.ok(
        listed !== undefined && !listed.ok && listed.code === 'invalid'
      );
    }
    assert.deepEqual(influx.requests, []);
  });

  void it('uses a measurement it is given', async () => {
    const influx = new FakeInfluxDb();
    expectOk(
      await adapterFor(influx, { measurement: 'settings' }).set('k', 'v', {
        signal,
      })
    );
    assert.ok(influx.measurements.get('settings')?.has('k'));
    assert.ok(!influx.measurements.has(MEASUREMENT));
  });
});

void describe('influxDbAdapter: listing', () => {
  void it('lists keys under a prefix, in order, whatever they contain', async () => {
    const adapter = adapterFor(new FakeInfluxDb());
    const keys = [
      'user/2',
      'user/1',
      'users',
      'é😀',
      'a b',
      'a,b',
      '',
      'new\nline',
    ];
    for (const key of keys) {
      expectOk(await adapter.set(key, key, { signal }));
    }
    const list = async (prefix: string): Promise<readonly string[]> =>
      expectOk(
        (await adapter.list?.(prefix, { signal })) ?? { ok: true, value: [] }
      );
    assert.deepEqual(await list('user/'), ['user/1', 'user/2']);
    assert.deepEqual(await list('a'), ['a b', 'a,b']);
    assert.deepEqual(await list('é'), ['é😀']);
    assert.deepEqual(await list('nothing'), []);
    assert.deepEqual(await list(''), [...keys].sort());
  });

  void it('skips tag values it did not write, and points without a revision', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
    expectOk(await adapter.set('mine', 'v', { signal }));
    influx.put(MEASUREMENT, 'not an escaped key', {
      value: 'x',
      revision: 'r',
    });
    influx.put(MEASUREMENT, 'noRevision', { value: 'x' });
    assert.deepEqual(
      expectOk(
        (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
      ),
      ['mine']
    );
  });

  void it('does not list removed keys', async () => {
    const adapter = adapterFor(new FakeInfluxDb());
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
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
    influx.failures.push({ status: 503, body: 'service unavailable' });
    const result = await adapter.list?.('user/', { signal });
    assert.ok(result !== undefined && !result.ok);
    assert.equal(result.code, 'unavailable');
    assert.ok(
      result.error.includes('"user/"') && result.error.includes('503'),
      result.error
    );
  });
});

void describe('influxDbAdapter: failures', () => {
  void it('refuses keys and values it cannot hold, without asking InfluxDB', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
    expectFailure(await adapter.get('\ud800', { signal }), 'invalid', '\ud800');
    const huge = 'k'.repeat(1025);
    expectFailure(await adapter.set(huge, 'v', { signal }), 'invalid', huge);
    expectFailure(await adapter.set('k', '\udc00', { signal }), 'invalid', 'k');
    const prefix = await adapter.list?.('\ud800', { signal });
    assert.ok(prefix !== undefined && !prefix.ok && prefix.code === 'invalid');
    assert.deepEqual(influx.requests, []);
  });

  const cases: readonly [number, string, string][] = [
    [
      401,
      '{"code":"unauthorized","message":"unauthorized access"}',
      'forbidden',
    ],
    [
      403,
      '{"code":"forbidden","message":"insufficient permissions"}',
      'forbidden',
    ],
    [400, '{"code":"invalid","message":"invalid flux"}', 'invalid'],
    [413, '{"code":"request too large","message":"too large"}', 'quota'],
    [429, '{"code":"too many requests","message":"slow down"}', 'unavailable'],
    [500, '{"error":"engine failed"}', 'unavailable'],
    [503, 'service unavailable', 'unavailable'],
  ];
  for (const [status, body, code] of cases) {
    void it(`maps HTTP ${String(status)} to ${code}, naming the key and what InfluxDB said`, async () => {
      const influx = new FakeInfluxDb();
      const adapter = adapterFor(influx);
      influx.failures.push({ status, body });
      const error = expectFailure(
        await adapter.get('k', { signal }),
        code,
        'k'
      );
      assert.ok(error.includes(`HTTP ${String(status)}`), error);
      const said = /"(?:message|error)":"([^"]+)"/.exec(body)?.[1] ?? body;
      assert.ok(error.includes(said), error);
    });
  }

  void it('says so when the bucket does not exist', async () => {
    const adapter = adapterFor(new FakeInfluxDb(), { bucket: 'nope' });
    for (const result of [
      await adapter.get('k', { signal }),
      await adapter.set('k', 'v', { signal }),
      await removeKey(adapter, 'k'),
    ]) {
      const error = expectFailure(result, 'unavailable', 'k');
      assert.match(
        error,
        /check that the organization "my-org" and the bucket "nope" exist/
      );
    }
  });

  void it('explains a bucket with a retention period', async () => {
    const influx = new FakeInfluxDb();
    influx.retention = true;
    const error = expectFailure(
      await adapterFor(influx).set('k', 'v', { signal }),
      'invalid',
      'k'
    );
    assert.match(error, /has a retention period.*keep data forever/);
  });

  void it('reports a query that fails while it runs', async () => {
    const influx = new FakeInfluxDb();
    influx.failures.push({
      status: 200,
      body: 'error,reference\r\n"runtime error @1:1-1:9: boom",897\r\n',
    });
    const error = expectFailure(
      await adapterFor(influx).get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.match(
      error,
      /could not be read \(query failed \(runtime error.*boom\)\)/
    );
  });

  void it('reports a network failure, and does not throw', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
    for (const attempt of [
      () => adapter.get('k', { signal }),
      () => adapter.set('k', 'v', { signal }),
      () => removeKey(adapter, 'k'),
    ]) {
      influx.failures.push({ throws: new Error('connect ECONNREFUSED') });
      const error = expectFailure(await attempt(), 'unavailable', 'k');
      assert.match(error, /could not be reached \(connect ECONNREFUSED\)/);
    }
    influx.failures.push({ throws: new Error('connect ECONNREFUSED') });
    const listed = await adapter.list?.('', { signal });
    assert.ok(listed !== undefined && !listed.ok);
  });

  void it('does not touch the network when the request was aborted', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
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
    assert.deepEqual(influx.requests, []);
  });
});

void describe('influxDbAdapter: subscribe', () => {
  void it('reports writes and removals made through the same adapter, once each, without polling', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx);
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
    assert.ok(influx.requests.every((r) => !r.body.includes('contains(')));
  });

  void it('hears a write and a removal made by another process when polling', async () => {
    const influx = new FakeInfluxDb();
    const adapter = adapterFor(influx, { pollIntervalMs: 50 });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(80);
    influx.put(MEASUREMENT, 'k', {
      value: 'from elsewhere',
      revision: 'r4',
    });
    await eventually(() => seen.length === 1, 'the write');
    influx.delete(MEASUREMENT, 'k');
    await eventually(() => seen.length === 2, 'the removal');
    stop();
    assert.deepEqual(seen, [{ value: 'from elsewhere', revision: 'r4' }, null]);
  });

  void it('does not report what was stored when it subscribed, or an own write twice', async () => {
    const influx = new FakeInfluxDb();
    influx.put(MEASUREMENT, 'k', { value: 'old', revision: 'r1' });
    const adapter = adapterFor(influx, { pollIntervalMs: 50 });
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
    const influx = new FakeInfluxDb();
    influx.writeLatencyMs = 60;
    const adapter = adapterFor(influx, { pollIntervalMs: 50 });
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

  void it('reports a failing poll once per run of failures, naming the bucket, and carries on', async () => {
    const influx = new FakeInfluxDb();
    const messages: string[] = [];
    const adapter = adapterFor(influx, {
      pollIntervalMs: 50,
      onPollError: (message) => messages.push(message),
    });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ?? unsubscribed;
    await tick(80);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      influx.failures.push({ status: 503, body: 'restarting' });
    }
    await tick(300);
    assert.equal(messages.length, 1);
    assert.match(
      messages[0] ?? '',
      /could not poll bucket "app" for changes \(.*503.*restarting/
    );
    influx.put(MEASUREMENT, 'k', { value: 'after the outage', revision: 'r2' });
    await eventually(() => seen.length === 1, 'recovery');
    stop();
    assert.equal(seen[0]?.value, 'after the outage');
  });

  void it('survives a listener that throws', async () => {
    const adapter = adapterFor(new FakeInfluxDb());
    const stop =
      adapter.subscribe?.('k', () => {
        throw new Error('listener bug');
      }) ?? unsubscribed;
    expectOk(await adapter.set('k', 'v', { signal }));
    stop();
  });
});
