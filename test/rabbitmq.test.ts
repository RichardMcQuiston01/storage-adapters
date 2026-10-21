/**
 * The RabbitMQ adapter, over an in-memory stand-in for a RabbitMQ stream
 * (test/support/fake-rabbitmq.ts), so the default test run stays offline.
 * test/rabbitmq-server.test.ts runs the same adapter against a real broker.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  rabbitMqAdapter,
  type RabbitMqAdapter,
  type RabbitMqAdapterOptions,
} from '../src/rabbitmq/index.js';
import type { StoredValue, StoreResult } from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeRabbitMq } from './support/fake-rabbitmq.js';

const signal: AbortSignal = new AbortController().signal;
const STREAM = 'storage_entry';

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
  assert.ok(result.error.startsWith('RabbitMQ '), result.error);
  return result.error;
}

const tick = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) {
      return;
    }
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}

const opened: RabbitMqAdapter[] = [];
function adapterFor(
  broker: FakeRabbitMq,
  more: Partial<RabbitMqAdapterOptions> = {}
): RabbitMqAdapter {
  const adapter = rabbitMqAdapter({
    channel: broker.openChannel,
    ...more,
  });
  opened.push(adapter);
  return adapter;
}
async function closeAll(): Promise<void> {
  for (const adapter of opened.splice(0)) {
    await adapter.close();
  }
}

const removeKey = async (
  adapter: RabbitMqAdapter,
  key: string
): Promise<StoreResult<null>> =>
  adapter.remove?.(key, { signal }) ?? { ok: true, value: null };

runConformance('rabbitMqAdapter on a stand-in RabbitMQ', {
  ownWrites: 'notifies',
  create: () => {
    const broker = new FakeRabbitMq();
    return {
      adapter: adapterFor(broker),
      reopen: () => adapterFor(broker),
      cleanup: closeAll,
    };
  },
});

void describe('rabbitMqAdapter', () => {
  void it('declares the stream as a stream, and consumes with a prefetch', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker);
    expectOk(await adapter.get('k', { signal }));
    assert.ok(broker.streams.has(STREAM));
    assert.ok((broker.channels[0]?.prefetched ?? 0) > 0);
    await closeAll();
  });

  void it('uses the stream offset as the revision', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker);
    const first = expectOk(await adapter.set('a', '1', { signal }));
    const second = expectOk(await adapter.set('b', '2', { signal }));
    assert.ok(Number(second.revision) > Number(first.revision));
    // The startup marker is offset 0, so the first write is offset 1.
    assert.equal(first.revision, '1');
    await closeAll();
  });

  void it('acknowledges every message it applies', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker);
    expectOk(await adapter.set('a', '1', { signal }));
    expectOk(await adapter.get('a', { signal }));
    assert.equal(
      broker.channels[0]?.acked.length,
      broker.streams.get(STREAM)?.length
    );
    await closeAll();
  });

  void it('decides ifRevision by order in the stream, across adapters', async () => {
    const broker = new FakeRabbitMq();
    const left = adapterFor(broker);
    const right = adapterFor(broker);
    const base = expectOk(await left.set('k', 'base', { signal }));
    for (let round = 0; round < 5; round += 1) {
      const current = expectOk(await left.get('k', { signal }));
      const results = await Promise.all([
        left.set('k', 'left', {
          signal,
          ifRevision: current?.revision as string,
        }),
        right.set('k', 'right', {
          signal,
          ifRevision: current?.revision as string,
        }),
      ]);
      assert.equal(results.filter((result) => result.ok).length, 1);
      const loser = results.find((result) => !result.ok);
      assert.ok(loser !== undefined && !loser.ok && loser.code === 'conflict');
      assert.match(
        loser.error,
        /holds revision \d+, but revision \d+ was expected/
      );
      assert.deepEqual(
        expectOk(await right.get('k', { signal })),
        expectOk(await left.get('k', { signal }))
      );
    }
    assert.ok(base.revision !== '');
    await closeAll();
  });

  void it('creates a key that holds nothing, or was removed, when given ifRevision', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker);
    expectOk(await adapter.set('a', 'v', { signal, ifRevision: '999' }));
    const first = expectOk(await adapter.set('b', 'one', { signal }));
    expectOk(await removeKey(adapter, 'b'));
    expectOk(
      await adapter.set('b', 'two', {
        signal,
        ifRevision: first.revision as string,
      })
    );
    await closeAll();
  });

  void it('rebuilds its table from the stream in a new adapter, and applies a removal', async () => {
    const broker = new FakeRabbitMq();
    const first = adapterFor(broker);
    expectOk(await first.set('a', '1', { signal }));
    expectOk(await first.set('b', '2', { signal }));
    expectOk(await removeKey(first, 'a'));
    const second = adapterFor(broker);
    assert.equal(expectOk(await second.get('a', { signal })), null);
    assert.equal(expectOk(await second.get('b', { signal }))?.value, '2');
    await closeAll();
  });

  void it('sees another process’s write on a linearizable read, but may lag on a local one', async () => {
    const broker = new FakeRabbitMq();
    const writer = adapterFor(broker);
    const strict = adapterFor(broker);
    const loose = adapterFor(broker, { readConsistency: 'local' });
    expectOk(await strict.get('warm', { signal }));
    expectOk(await loose.get('warm', { signal }));
    broker.holdDelivery = true;
    broker.streams
      .get(STREAM)
      ?.push(
        new TextEncoder().encode(
          JSON.stringify({ id: 'x', op: 'set', key: 'k', value: 'late' })
        )
      );
    // Stored on the broker, not yet delivered: a local read cannot know.
    assert.equal(expectOk(await loose.get('k', { signal })), null);
    const strictRead = strict.get('k', { signal });
    await tick(50);
    broker.resume();
    assert.equal(expectOk(await strictRead)?.value, 'late');
    assert.equal(expectOk(await writer.get('k', { signal }))?.value, 'late');
    await closeAll();
  });

  void it('shares one marker among reads that arrive while another is out', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker);
    expectOk(await adapter.get('warm', { signal }));
    const before = broker.streams.get(STREAM)?.length ?? 0;
    await Promise.all(
      Array.from({ length: 30 }, () => adapter.get('k', { signal }))
    );
    const markers = (broker.streams.get(STREAM)?.length ?? 0) - before;
    assert.ok(markers >= 1 && markers <= 3, `${String(markers)} markers`);
    await closeAll();
  });

  void it('does not announce history replayed on start, only what follows', async () => {
    const broker = new FakeRabbitMq();
    const writer = adapterFor(broker);
    for (let index = 0; index < 4; index += 1) {
      expectOk(await writer.set('k', String(index), { signal }));
    }
    expectOk(await removeKey(writer, 'k'));
    expectOk(await writer.set('k', 'again', { signal }));
    expectOk(await removeKey(writer, 'k'));
    const late = adapterFor(broker);
    const seen: (StoredValue | null)[] = [];
    const stop =
      late.subscribe?.('k', (stored) => seen.push(stored)) ?? (() => undefined);
    expectOk(await late.get('k', { signal }));
    await tick(50);
    assert.deepEqual(seen, []);
    const written = expectOk(await writer.set('k', 'next', { signal }));
    await eventually(() => seen.length === 1, 'the new write');
    stop();
    assert.deepEqual(seen, [written]);
    await closeAll();
  });

  void it('reports a conflicting write’s loser only to the loser, and announces only what applied', async () => {
    const broker = new FakeRabbitMq();
    const a = adapterFor(broker);
    const b = adapterFor(broker);
    const base = expectOk(await a.set('k', 'base', { signal }));
    const seen: (StoredValue | null)[] = [];
    const stop =
      b.subscribe?.('k', (stored) => seen.push(stored)) ?? (() => undefined);
    expectOk(await b.get('k', { signal }));
    const win = expectOk(
      await a.set('k', 'win', { signal, ifRevision: base.revision as string })
    );
    const lose = await b.set('k', 'lose', {
      signal,
      ifRevision: base.revision as string,
    });
    assert.ok(!lose.ok && lose.code === 'conflict');
    await eventually(() => seen.length === 1, 'the winning write');
    stop();
    assert.deepEqual(seen, [win]);
    await closeAll();
  });

  void it('reads the stream again after its channel closes, and announces what changed meanwhile', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker, { retryMs: 20 });
    const other = adapterFor(broker);
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
      (() => undefined);
    expectOk(await adapter.set('a', '1', { signal }));
    broker.channels[0]?.close(new Error('connection reset'));
    const written = expectOk(await other.set('k', 'while away', { signal }));
    await eventually(() => seen.length === 1, 'the missed write');
    assert.deepEqual(seen, [written]);
    assert.ok(broker.channels.length >= 3);
    assert.equal(expectOk(await adapter.get('a', { signal }))?.value, '1');
    // Offsets are not contiguous in a real stream, so it always starts from the front.
    assert.ok(broker.consumerStarts.every((start) => start === 'first'));
    stop();
    await closeAll();
  });

  void describe('compaction', () => {
    /** A message as another adapter would have written it. */
    const message = (operation: Record<string, unknown>): Uint8Array =>
      new TextEncoder().encode(JSON.stringify(operation));
    const snapshotOf = (
      at: number,
      entries: [string, string, string][]
    ): Uint8Array =>
      message({
        id: `snap-${String(at)}`,
        op: 'snapshot',
        at,
        entries: entries.map(([key, value, revision]) => ({
          key,
          value,
          revision,
        })),
      });
    const lookup = async (
      adapter: RabbitMqAdapter,
      key: string
    ): Promise<StoredValue | null> =>
      expectOk(await adapter.get(key, { signal }));

    void it('publishes every entry with its revision, in key order, and not the removed ones', async () => {
      const broker = new FakeRabbitMq();
      const adapter = adapterFor(broker);
      const b = expectOk(await adapter.set('b', '2', { signal }));
      const a = expectOk(await adapter.set('a', '1', { signal }));
      expectOk(await adapter.set('gone', 'x', { signal }));
      expectOk(await removeKey(adapter, 'gone'));
      const snapshot = expectOk(await adapter.compact());
      assert.equal(snapshot.entries, 2);
      const last = JSON.parse(
        new TextDecoder().decode(broker.streams.get(STREAM)?.at(-1))
      ) as {
        op: string;
        at: number;
        entries: { key: string; revision: string }[];
      };
      assert.equal(last.op, 'snapshot');
      assert.equal(String(last.at), snapshot.through);
      assert.deepEqual(
        last.entries.map((entry) => [entry.key, entry.revision]),
        [
          ['a', a.revision],
          ['b', b.revision],
        ]
      );
      // A snapshot changes nothing for readers that are up to date.
      assert.deepEqual(await lookup(adapter, 'a'), a);
      await closeAll();
    });

    void it('lets a new process start from the snapshot once RabbitMQ has deleted the beginning', async () => {
      const broker = new FakeRabbitMq();
      const first = adapterFor(broker);
      const a = expectOk(await first.set('a', '1', { signal }));
      expectOk(await first.set('gone', 'x', { signal }));
      expectOk(await removeKey(first, 'gone'));
      const snapshot = expectOk(await first.compact());
      const later = expectOk(await first.set('b', '2', { signal }));
      // Retention deletes everything before the message the snapshot reflects.
      broker.truncate(STREAM, Number(snapshot.through));
      const fresh = adapterFor(broker);
      assert.deepEqual(await lookup(fresh, 'a'), a);
      assert.deepEqual(await lookup(fresh, 'b'), later);
      assert.equal(await lookup(fresh, 'gone'), null);
      assert.deepEqual(
        expectOk(
          (await fresh.list?.('', { signal })) ?? { ok: true, value: [] }
        ),
        ['a', 'b']
      );
      // Revisions survived, so a caller holding one can still update safely.
      expectOk(
        await fresh.set('a', '1b', { signal, ifRevision: a.revision as string })
      );
      const stale = await fresh.set('a', '1c', {
        signal,
        ifRevision: a.revision as string,
      });
      assert.ok(!stale.ok && stale.code === 'conflict');
      await closeAll();
    });

    void it('applies the writes that landed between what a snapshot reflects and where it sits', async () => {
      const broker = new FakeRabbitMq();
      broker.append(
        STREAM,
        message({ id: 'w0', op: 'set', key: 'a', value: 'v1' })
      ); // 0
      broker.append(
        STREAM,
        message({ id: 'w1', op: 'set', key: 'b', value: 'v1' })
      ); // 1
      broker.append(
        STREAM,
        message({ id: 'w2', op: 'set', key: 'a', value: 'v2' })
      ); // 2
      broker.append(STREAM, message({ id: 'w3', op: 'remove', key: 'b' })); // 3
      broker.append(
        STREAM,
        snapshotOf(1, [
          ['a', 'v1', '0'],
          ['b', 'v1', '1'],
        ])
      ); // 4
      broker.truncate(STREAM, 1);
      const adapter = adapterFor(broker);
      assert.deepEqual(await lookup(adapter, 'a'), {
        value: 'v2',
        revision: '2',
      });
      assert.equal(await lookup(adapter, 'b'), null);
      await closeAll();
    });

    void it('ignores a snapshot whose own message was deleted, and says so when no other can be used', async () => {
      const broker = new FakeRabbitMq();
      broker.append(
        STREAM,
        message({ id: 'w0', op: 'set', key: 'a', value: 'v1' })
      ); // 0
      broker.append(
        STREAM,
        message({ id: 'w1', op: 'set', key: 'a', value: 'v2' })
      ); // 1
      broker.append(STREAM, snapshotOf(0, [['a', 'v1', '0']])); // 2
      // Offset 0 is gone, and so may be writes after it that the snapshot lacks.
      broker.truncate(STREAM, 1);
      const adapter = adapterFor(broker, { timeoutMs: 100 });
      const error = expectFailure(
        await adapter.get('a', { signal }),
        'unavailable',
        'a'
      );
      assert.match(error, /starts at offset 1, not 0, and holds no snapshot/);
      // A later snapshot rescues it.
      broker.append(STREAM, snapshotOf(2, [['a', 'v2', '1']])); // 3
      assert.deepEqual(await lookup(adapter, 'a'), {
        value: 'v2',
        revision: '1',
      });
      await closeAll();
    });

    void it('fails with unavailable, naming the key, when the beginning is gone and nothing was snapshotted', async () => {
      const broker = new FakeRabbitMq();
      for (let index = 0; index < 4; index += 1) {
        broker.append(
          STREAM,
          message({
            id: `w${String(index)}`,
            op: 'set',
            key: 'a',
            value: String(index),
          })
        );
      }
      broker.truncate(STREAM, 2);
      const adapter = adapterFor(broker, { timeoutMs: 100 });
      const error = expectFailure(
        await adapter.get('a', { signal }),
        'unavailable',
        'a'
      );
      assert.match(error, /deleted the beginning/);
      expectFailure(
        await adapter.set('a', 'x', { signal }),
        'unavailable',
        'a'
      );
    });

    void it('rebuilds a running adapter from a snapshot after RabbitMQ deleted messages it had not read, and tells subscribers what changed', async () => {
      const broker = new FakeRabbitMq();
      const adapter = adapterFor(broker, { retryMs: 20 });
      const writer = adapterFor(broker);
      expectOk(await adapter.set('same', 's', { signal }));
      expectOk(await adapter.set('changed', 'old', { signal }));
      expectOk(await adapter.set('removed', 'r', { signal }));
      const seen: [string, string | null][] = [];
      const stops = ['same', 'changed', 'removed', 'added'].map(
        (key) =>
          adapter.subscribe?.(key, (stored) =>
            seen.push([key, stored?.value ?? null])
          ) ?? (() => undefined)
      );
      broker.channels[0]?.close(new Error('connection reset'));
      expectOk(await writer.set('changed', 'new', { signal }));
      expectOk(await removeKey(writer, 'removed'));
      expectOk(await writer.set('added', 'a', { signal }));
      const snapshot = expectOk(await writer.compact());
      broker.truncate(STREAM, Number(snapshot.through));
      await eventually(() => seen.length >= 3, 'the rebuild');
      await tick(50);
      assert.deepEqual(seen.sort(), [
        ['added', 'a'],
        ['changed', 'new'],
        ['removed', null],
      ]);
      assert.equal((await lookup(adapter, 'same'))?.value, 's');
      for (const stop of stops) {
        stop();
      }
      await closeAll();
    });

    void it(
      'publishes snapshots by itself when asked to, and only after there have been writes',
      { timeout: 20_000 },
      async () => {
        const broker = new FakeRabbitMq();
        const adapter = adapterFor(broker, { snapshotIntervalMs: 1000 });
        const countSnapshots = (): number =>
          (broker.streams.get(STREAM) ?? []).filter((content) =>
            new TextDecoder().decode(content).includes('"op":"snapshot"')
          ).length;
        expectOk(await adapter.set('a', '1', { signal }));
        await eventually(() => countSnapshots() === 1, 'the first snapshot');
        await tick(2300);
        assert.equal(countSnapshots(), 1);
        expectOk(await adapter.set('a', '2', { signal }));
        await eventually(() => countSnapshots() === 2, 'the second snapshot');
        await adapter.close();
        const before = countSnapshots();
        await tick(1300);
        assert.equal(countSnapshots(), before);
      }
    );

    void it(
      'does not publish a snapshot another process already published',
      { timeout: 20_000 },
      async () => {
        const broker = new FakeRabbitMq();
        const left = adapterFor(broker, { snapshotIntervalMs: 1000 });
        const right = adapterFor(broker, { snapshotIntervalMs: 1000 });
        expectOk(await left.set('a', '1', { signal }));
        expectOk(await right.get('a', { signal }));
        await tick(2600);
        const snapshots = (broker.streams.get(STREAM) ?? []).filter((content) =>
          new TextDecoder().decode(content).includes('"op":"snapshot"')
        ).length;
        assert.ok(snapshots >= 1 && snapshots <= 2, String(snapshots));
        await closeAll();
      }
    );

    void it('refuses a table too big for one message, naming the stream', async () => {
      const broker = new FakeRabbitMq();
      const adapter = adapterFor(broker);
      for (const key of ['a', 'b', 'c']) {
        expectOk(await adapter.set(key, 'x'.repeat(3_000_000), { signal }));
      }
      const result = await adapter.compact();
      assert.ok(!result.ok);
      assert.equal(result.code, 'invalid');
      assert.match(
        result.error,
        /^RabbitMQ snapshot of stream "storage_entry"/
      );
      assert.match(result.error, /must fit in one message/);
      await closeAll();
    });

    void it('fails with unavailable once closed, and invalid for an unusable stream name', async () => {
      const broker = new FakeRabbitMq();
      const adapter = adapterFor(broker);
      expectOk(await adapter.set('a', '1', { signal }));
      await adapter.close();
      const closed = await adapter.compact();
      assert.ok(!closed.ok && closed.code === 'unavailable');
      const bad = await adapterFor(broker, { stream: '' }).compact();
      assert.ok(!bad.ok && bad.code === 'invalid');
    });

    void it('passes streamArguments to the declaration, without letting them change the stream type', async () => {
      const broker = new FakeRabbitMq();
      const declared: Record<string, unknown>[] = [];
      const adapter = rabbitMqAdapter({
        channel: async () => {
          const channel = await broker.openChannel();
          const original = channel.assertQueue.bind(channel);
          channel.assertQueue = (queue, options) => {
            declared.push(options.arguments);
            return original(queue, options);
          };
          return channel;
        },
        streamArguments: { 'x-max-age': '7D', 'x-queue-type': 'classic' },
      });
      expectOk(await adapter.get('a', { signal }));
      assert.deepEqual(declared, [
        { 'x-max-age': '7D', 'x-queue-type': 'stream' },
      ]);
      await adapter.close();
    });
  });

  void it('ignores a message the broker delivers a second time', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker);
    const seen: (StoredValue | null)[] = [];
    const stop =
      adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
      (() => undefined);
    const old = expectOk(await adapter.set('k', 'old', { signal }));
    const current = expectOk(await adapter.set('k', 'new', { signal }));
    broker.redeliver(STREAM, Number(old.revision));
    broker.redeliver(STREAM, Number(current.revision));
    assert.deepEqual(expectOk(await adapter.get('k', { signal })), current);
    assert.deepEqual(
      seen.map((stored) => stored?.value),
      ['old', 'new']
    );
    stop();
    await closeAll();
  });

  void it('reconnects on the next call even without subscribers', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker);
    expectOk(await adapter.set('a', '1', { signal }));
    broker.channels[0]?.close();
    assert.equal(expectOk(await adapter.get('a', { signal }))?.value, '1');
    await closeAll();
  });

  void it('fails with unavailable, naming the key, when a fixed channel has closed', async () => {
    const broker = new FakeRabbitMq();
    const channel = await broker.openChannel();
    const adapter = rabbitMqAdapter({ channel });
    expectOk(await adapter.get('a', { signal }));
    (channel as unknown as { close(): void }).close();
    const error = expectFailure(
      await adapter.get('a', { signal }),
      'unavailable',
      'a'
    );
    assert.match(error, /stream "storage_entry"/);
    await adapter.close();
  });

  void it('says so when the queue exists but is not a stream', async () => {
    const broker = new FakeRabbitMq();
    broker.plainQueues.add(STREAM);
    const adapter = adapterFor(broker);
    const error = expectFailure(
      await adapter.get('k', { signal }),
      'unavailable',
      'k'
    );
    assert.match(error, /must be a stream/);
  });

  void it('says so when the stream is missing and createStream is off', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker, { createStream: false });
    expectFailure(await adapter.set('k', 'v', { signal }), 'unavailable', 'k');
  });

  void it('reports a failed publish with the broker’s reason, and a later write works', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker);
    expectOk(await adapter.get('warm', { signal }));
    broker.publishFailures.push(
      Object.assign(new Error('nacked'), { code: 403 })
    );
    const error = expectFailure(
      await adapter.set('k', 'v', { signal }),
      'forbidden',
      'k'
    );
    assert.match(
      error,
      /could not be published to stream "storage_entry" \(nacked\)/
    );
    expectOk(await adapter.set('k', 'v', { signal }));
    await closeAll();
  });

  void it('times out, saying the write may still be applied, when no confirmation comes back', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker, { timeoutMs: 50 });
    expectOk(await adapter.get('warm', { signal }));
    broker.holdConfirms = true;
    const error = expectFailure(
      await adapter.set('k', 'v', { signal }),
      'unavailable',
      'k'
    );
    assert.match(error, /within 50 ms \(it may still be applied\)/);
    await closeAll();
  });

  void it('skips a message that is not an entry and reports it', async () => {
    const broker = new FakeRabbitMq();
    const messages: string[] = [];
    const adapter = adapterFor(broker, {
      onError: (message) => messages.push(message),
    });
    expectOk(await adapter.set('a', '1', { signal }));
    broker.append(STREAM, new TextEncoder().encode('not json'));
    broker.append(STREAM, new TextEncoder().encode('{"id":1}'));
    expectOk(await adapter.set('b', '2', { signal }));
    assert.equal(expectOk(await adapter.get('b', { signal }))?.value, '2');
    assert.equal(messages.filter((m) => /not an entry/.test(m)).length, 2);
    await closeAll();
  });

  void it('refuses keys and values that cannot be stored, and an unusable stream name', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker);
    expectFailure(
      await adapter.set('k'.repeat(1025), 'v', { signal }),
      'invalid',
      'k'.repeat(1025)
    );
    expectFailure(
      await adapter.set('\ud800', 'v', { signal }),
      'invalid',
      '\ud800'
    );
    expectFailure(await adapter.set('k', '\udc00', { signal }), 'invalid', 'k');
    expectFailure(
      await adapter.set('k', 'x'.repeat(4_000_001), { signal }),
      'invalid',
      'k'
    );
    expectFailure(
      await adapterFor(broker, { stream: '' }).get('k', { signal }),
      'invalid',
      'k'
    );
    expectFailure(
      await adapterFor(broker, { stream: 'a\nb' }).set('k', 'v', { signal }),
      'invalid',
      'k'
    );
    assert.equal(broker.streams.size, 0);
  });

  void it('stops consuming on close and then fails calls with unavailable', async () => {
    const broker = new FakeRabbitMq();
    const adapter = adapterFor(broker);
    expectOk(await adapter.set('a', '1', { signal }));
    await adapter.close();
    await adapter.close();
    expectFailure(await adapter.get('a', { signal }), 'unavailable', 'a');
    expectFailure(await adapter.set('a', '2', { signal }), 'unavailable', 'a');
  });

  void it('hands the channel a converted buffer when toBuffer is given', async () => {
    const broker = new FakeRabbitMq();
    let calls = 0;
    const adapter = adapterFor(broker, {
      toBuffer: (bytes) => {
        calls += 1;
        return bytes;
      },
    });
    expectOk(await adapter.set('a', '1', { signal }));
    assert.ok(calls >= 2);
    await closeAll();
  });
});
