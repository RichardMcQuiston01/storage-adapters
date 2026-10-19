/**
 * The NATS KV adapter, over an in-memory bucket that behaves like JetStream's
 * (test/support/fake-nats.ts), so the default test run stays offline.
 * test/nats-server.test.ts runs the same adapter against a real server.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeNatsKey,
  encodeNatsKey,
  natsKvAdapter,
} from '../src/nats/index.js';
import type { StoredValue, StoreResult } from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeJetStreamError, FakeNatsKv } from './support/fake-nats.js';

const signal: AbortSignal = new AbortController().signal;

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
  assert.ok(result.error.startsWith('NATS KV '), result.error);
  return result.error;
}

/** Lets pending promises and the watch loop run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 20));

runConformance('natsKvAdapter over a fake bucket', {
  ownWrites: 'notifies',
  create: () => {
    const kv = new FakeNatsKv();
    return {
      adapter: natsKvAdapter({ kv }),
      reopen: () => natsKvAdapter({ kv }),
    };
  },
});

void describe('natsKvAdapter: keys', () => {
  void it('keeps letters, digits, - and _ and escapes every other byte', () => {
    assert.equal(encodeNatsKey('theme-1_a'), 'theme-1_a');
    assert.equal(encodeNatsKey('a.b'), 'a=2Eb');
    assert.equal(encodeNatsKey('a=b'), 'a=3Db');
    assert.equal(encodeNatsKey('a b/*>'), 'a=20b=2F=2A=3E');
    assert.equal(encodeNatsKey('é😀'), '=C3=A9=F0=9F=98=80');
  });

  void it('round-trips awkward keys and keeps prefixes', () => {
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
      const name: string | undefined = encodeNatsKey(key);
      assert.ok(name !== undefined, key);
      assert.equal(decodeNatsKey(name), key);
    }
    const prefix: string = encodeNatsKey('user/') ?? '';
    assert.ok((encodeNatsKey('user/1') ?? '').startsWith(prefix));
  });

  void it('refuses keys it cannot store, and names it did not make', () => {
    assert.equal(encodeNatsKey(''), undefined);
    assert.equal(encodeNatsKey('\ud800'), undefined);
    assert.equal(encodeNatsKey('k'.repeat(2000)), undefined);
    assert.equal(decodeNatsKey('a.b'), undefined);
    assert.equal(decodeNatsKey('a=2e'), undefined);
    assert.equal(decodeNatsKey('=FF'), undefined);
    assert.equal(decodeNatsKey('=41'), undefined); // 'A' should not be escaped
  });

  void it('reports an invalid key without touching the bucket', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    for (const key of ['', '\ud800', 'k'.repeat(2000)]) {
      expectFailure(await adapter.get(key, { signal }), 'invalid', key);
      expectFailure(await adapter.set(key, 'v', { signal }), 'invalid', key);
    }
    assert.equal(kv.latest.size, 0);
  });

  void it('stores keys the bucket would otherwise refuse', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    const key = 'a.b c/*>é😀';
    expectOk(await adapter.set(key, 'v', { signal }));
    assert.equal(expectOk(await adapter.get(key, { signal }))?.value, 'v');
    assert.deepEqual(
      expectOk(
        (await adapter.list?.('a.', { signal })) ??
          ({ ok: true, value: [] } as StoreResult<string[]>)
      ),
      [key]
    );
  });
});

void describe('natsKvAdapter: writes', () => {
  void it('uses the bucket sequence as the revision', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    expectOk(await adapter.set('other', 'x', { signal }));
    const stored: StoredValue = expectOk(
      await adapter.set('k', 'v', { signal })
    );
    assert.equal(stored.revision, '2');
    const next: StoredValue = expectOk(
      await adapter.set('k', 'w', { signal, ifRevision: '2' })
    );
    assert.equal(next.revision, '3');
  });

  void it('reports a conflict naming both revisions', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await adapter.set('k', 'w', { signal }));
    const message: string = expectFailure(
      await adapter.set('k', 'x', { signal, ifRevision: '1' }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 2, but revision 1 was expected/);
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'w');
  });

  void it('creates a key that has nothing stored, even with a revision', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    expectOk(await adapter.set('k', 'v', { signal, ifRevision: '41' }));
    expectOk(
      (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
    );
    expectOk(await adapter.set('k', 'again', { signal, ifRevision: '1' }));
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'again');
  });

  void it('treats a revision that is not a number as one that never matches', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectFailure(
      await adapter.set('k', 'w', { signal, ifRevision: 'abc' }),
      'conflict',
      'k'
    );
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'v');
  });

  void it('reads a removed key as missing', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(
      (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
    );
    assert.equal(expectOk(await adapter.get('k', { signal })), null);
    assert.deepEqual(
      expectOk(
        (await adapter.list?.('', { signal })) ??
          ({ ok: true, value: ['x'] } as StoreResult<string[]>)
      ),
      []
    );
  });
});

void describe('natsKvAdapter: failures', () => {
  const cases: readonly [string, string][] = [
    ['Permissions Violation for Publish to "$KV.x.k"', 'forbidden'],
    ['insufficient storage resources available', 'quota'],
    ["'payload' max_payload size exceeded", 'invalid'],
    ['connection closed', 'unavailable'],
    ['503', 'unavailable'],
  ];
  for (const [message, code] of cases) {
    void it(`maps "${message}" to ${code}`, async () => {
      const kv = new FakeNatsKv();
      const adapter = natsKvAdapter({ kv });
      kv.failures.push(new Error(message));
      const error: string = expectFailure(
        await adapter.set('k', 'v', { signal }),
        code,
        'k'
      );
      assert.ok(error.includes(message) || code === 'invalid', error);
      kv.failures.push(new Error(message));
      expectFailure(
        await adapter.get('k', { signal }),
        code === 'invalid' ? 'invalid' : code,
        'k'
      );
    });
  }

  void it('reports a list failure naming the prefix', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    kv.failures.push(new Error('connection closed'));
    const result = await adapter.list?.('user/', { signal });
    assert.ok(result !== undefined && !result.ok);
    assert.equal(result.code, 'unavailable');
    assert.ok(result.error.includes('"user/"'), result.error);
  });

  void it('does not touch the bucket when the request was aborted', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
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
    assert.equal(kv.latest.size, 0);
  });

  void it('does not report a conflict for an unrelated error during a checked write', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    expectOk(await adapter.set('k', 'v', { signal }));
    kv.failures.push(new FakeJetStreamError('timeout'));
    expectFailure(
      await adapter.set('k', 'w', { signal, ifRevision: '1' }),
      'unavailable',
      'k'
    );
  });
});

void describe('natsKvAdapter: subscribe', () => {
  void it('hears a write made through another adapter on the same bucket', async () => {
    const kv = new FakeNatsKv();
    const listener = natsKvAdapter({ kv });
    const writer = natsKvAdapter({ kv });
    const seen: (StoredValue | null)[] = [];
    const stop =
      listener.subscribe?.('k', (stored) => seen.push(stored)) ??
      (() => undefined);
    await settle();
    expectOk(await writer.set('k', 'v', { signal }));
    await settle();
    expectOk(
      (await writer.remove?.('k', { signal })) ?? { ok: true, value: null }
    );
    await settle();
    stop();
    assert.deepEqual(seen, [{ value: 'v', revision: '1' }, null]);
  });

  void it('reports a write made through the same adapter once', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
      (() => undefined);
    await settle();
    expectOk(await adapter.set('k', 'v', { signal }));
    await settle();
    expectOk(
      (await adapter.remove?.('k', { signal })) ?? { ok: true, value: null }
    );
    await settle();
    stop();
    assert.deepEqual(seen, [{ value: 'v', revision: '1' }, null]);
  });

  void it('shares one watch per key and stops it with the last subscriber', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    const first =
      adapter.subscribe?.('k', () => undefined) ?? (() => undefined);
    const second =
      adapter.subscribe?.('k', () => undefined) ?? (() => undefined);
    await settle();
    assert.equal(kv.watched.length, 1);
    assert.equal(kv.openWatches, 1);
    first();
    first();
    await settle();
    assert.equal(kv.openWatches, 1);
    second();
    await settle();
    assert.equal(kv.openWatches, 0);
  });

  void it('does not watch when nothing is subscribed', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.deepEqual(kv.watched, []);
  });

  void it('watches again after the watch is lost, and catches up', async () => {
    const kv = new FakeNatsKv();
    const listener = natsKvAdapter({ kv, watchRetryMs: 10 });
    const writer = natsKvAdapter({ kv });
    expectOk(await writer.set('k', 'before', { signal }));
    const seen: (StoredValue | null)[] = [];
    const stop =
      listener.subscribe?.('k', (stored) => seen.push(stored)) ??
      (() => undefined);
    await settle();
    kv.dropWatches();
    expectOk(await writer.set('k', 'while down', { signal }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop();
    assert.deepEqual(seen, [{ value: 'while down', revision: '2' }]);
    assert.equal(kv.watched.length, 2);
  });

  void it('reports a failed watch and stops trying once unsubscribed', async () => {
    const kv = new FakeNatsKv();
    const messages: string[] = [];
    const adapter = natsKvAdapter({
      kv,
      watchRetryMs: 10,
      onWatchError: (message) => messages.push(message),
    });
    kv.failures.push(new Error('connection closed'));
    const stop = adapter.subscribe?.('k', () => undefined) ?? (() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    const attempts: number = kv.watched.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(messages.length, 1);
    assert.match(
      messages[0] ?? '',
      /could not watch for key "k" \(connection closed\)/
    );
    assert.equal(kv.watched.length, attempts);
    assert.equal(kv.openWatches, 0);
  });

  void it('survives a listener that throws', async () => {
    const kv = new FakeNatsKv();
    const adapter = natsKvAdapter({ kv });
    const stop =
      adapter.subscribe?.('k', () => {
        throw new Error('listener bug');
      }) ?? (() => undefined);
    await settle();
    expectOk(await adapter.set('k', 'v', { signal }));
    stop();
  });
});
