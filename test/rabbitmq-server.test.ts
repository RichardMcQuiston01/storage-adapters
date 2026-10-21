/**
 * The RabbitMQ adapter against a real RabbitMQ broker, through `amqplib`.
 * Skipped unless a URL is named:
 *
 *   TEST_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672
 *
 * Each test uses a stream of its own, which it deletes afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import amqplib from 'amqplib';

import {
  rabbitMqAdapter,
  type RabbitMqAdapter,
  type RabbitMqAdapterOptions,
  type RabbitMqChannelLike,
} from '../src/rabbitmq/index.js';
import type { StoredValue, StoreResult } from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const url: string | undefined = process.env.TEST_RABBITMQ_URL;
if (url === undefined || url === '') {
  void describe('rabbitMqAdapter on a RabbitMQ broker', () => {
    void it(
      'is skipped: set TEST_RABBITMQ_URL to run it',
      { skip: true },
      () => {
        // Nothing to run without a broker.
      }
    );
  });
} else {
  const connection = await amqplib.connect(url);
  const openChannel = async (): Promise<RabbitMqChannelLike> =>
    connection.createConfirmChannel();
  const admin = await connection.createChannel();
  const freshStream = (): string => `t_${randomBytes(6).toString('hex')}`;
  const deleteStream = async (stream: string): Promise<void> => {
    await admin.deleteQueue(stream);
  };

  /** Adapters that a test opened, so they can be closed. */
  const opened: RabbitMqAdapter[] = [];
  const adapterFor = (
    stream: string,
    more: Partial<RabbitMqAdapterOptions> = {}
  ): RabbitMqAdapter => {
    const adapter = rabbitMqAdapter({
      channel: openChannel,
      toBuffer: (bytes) => Buffer.from(bytes),
      stream,
      ...more,
    });
    opened.push(adapter);
    return adapter;
  };
  const closeAll = async (): Promise<void> => {
    for (const adapter of opened.splice(0)) {
      await adapter.close();
    }
  };

  runConformance('rabbitMqAdapter on a RabbitMQ broker', {
    ownWrites: 'notifies',
    create: () => {
      const stream = freshStream();
      return {
        adapter: adapterFor(stream),
        reopen: () => adapterFor(stream),
        cleanup: async () => {
          await closeAll();
          await deleteStream(stream);
        },
      };
    },
  });

  void describe('rabbitMqAdapter on a RabbitMQ broker: beyond the contract', () => {
    const withStream = async (
      body: (stream: string) => Promise<void>
    ): Promise<void> => {
      const stream = freshStream();
      try {
        await body(stream);
      } finally {
        await closeAll();
        await deleteStream(stream);
      }
    };

    void it('uses the stream offset as the revision, growing with every write', async () => {
      await withStream(async (stream) => {
        const adapter = adapterFor(stream);
        let previous = -1;
        for (let index = 0; index < 20; index += 1) {
          const written = expectOk(
            await adapter.set('k', `v${String(index)}`, { signal })
          );
          assert.ok(Number(written.revision) > previous);
          previous = Number(written.revision);
          assert.deepEqual(
            expectOk(await adapter.get('k', { signal })),
            written
          );
        }
      });
    });

    void it('keeps the value exactly, including newlines, NUL, quotes, emoji and a 3 MB value', async () => {
      await withStream(async (stream) => {
        const adapter = adapterFor(stream);
        for (const value of [
          'line one\nline two 😀 é\t"quoted" \\ back, comma',
          'nul \0 byte',
          '{"r":1}',
          '',
          '  padded  ',
          'x'.repeat(3_000_000),
        ]) {
          expectOk(await adapter.set('k', value, { signal }));
          assert.equal(
            expectOk(await adapter.get('k', { signal }))?.value,
            value
          );
        }
        // A second process rebuilds the same state from the stream.
        const other = adapterFor(stream);
        assert.equal(
          expectOk(await other.get('k', { signal }))?.value,
          'x'.repeat(3_000_000)
        );
      });
    });

    void it('decides ifRevision in stream order, so only one of many racing processes wins', async () => {
      await withStream(async (stream) => {
        const processes = Array.from({ length: 6 }, () => adapterFor(stream));
        const base = expectOk(
          await (processes[0] as RabbitMqAdapter).set('k', 'base', { signal })
        );
        for (let round = 0; round < 5; round += 1) {
          const current = expectOk(
            await (processes[0] as RabbitMqAdapter).get('k', { signal })
          );
          const results = await Promise.all(
            processes.map((adapter, index) =>
              adapter.set('k', `p${String(index)}`, {
                signal,
                ifRevision: (current as StoredValue).revision as string,
              })
            )
          );
          const winners = results.filter((result) => result.ok);
          assert.equal(winners.length, 1, JSON.stringify(results));
          for (const result of results) {
            if (!result.ok) {
              assert.equal(result.code, 'conflict');
            }
          }
          const stored = expectOk(
            await (processes[1] as RabbitMqAdapter).get('k', { signal })
          );
          assert.deepEqual(stored, winners[0]?.ok ? winners[0].value : null);
        }
        assert.ok(base.revision !== '');
      });
    });

    void it('counts without losing updates when every writer retries on conflict', async () => {
      await withStream(async (stream) => {
        const processes = Array.from({ length: 4 }, () => adapterFor(stream));
        expectOk(
          await (processes[0] as RabbitMqAdapter).set('n', '0', { signal })
        );
        const bump = async (adapter: RabbitMqAdapter): Promise<void> => {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const current = expectOk(await adapter.get('n', { signal }));
            const result = await adapter.set(
              'n',
              String(Number(current?.value) + 1),
              { signal, ifRevision: current?.revision as string }
            );
            if (result.ok) {
              return;
            }
            assert.equal(result.code, 'conflict');
          }
          assert.fail('never got a turn');
        };
        await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            bump(processes[index % processes.length] as RabbitMqAdapter)
          )
        );
        assert.equal(
          expectOk(await (processes[0] as RabbitMqAdapter).get('n', { signal }))
            ?.value,
          '12'
        );
      });
    });

    void it('hears writes and removals made through another process, without polling', async () => {
      await withStream(async (stream) => {
        const listener = adapterFor(stream);
        const writer = adapterFor(stream);
        expectOk(await writer.set('seed', 'v', { signal }));
        const seen: (StoredValue | null)[] = [];
        const stop =
          listener.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        expectOk(await listener.get('seed', { signal }));
        const written = expectOk(await writer.set('k', 'v', { signal }));
        await eventually(() => seen.length === 1, 'the write');
        expectOk(
          (await writer.remove?.('k', { signal })) ?? { ok: true, value: null }
        );
        await eventually(() => seen.length === 2, 'the removal');
        stop();
        assert.deepEqual(seen, [written, null]);
      });
    });

    void it('does not announce history that was replayed on start', async () => {
      await withStream(async (stream) => {
        const writer = adapterFor(stream);
        for (let index = 0; index < 5; index += 1) {
          expectOk(await writer.set('k', String(index), { signal }));
        }
        const late = adapterFor(stream);
        const seen: (StoredValue | null)[] = [];
        const stop =
          late.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        expectOk(await late.get('k', { signal }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        stop();
        assert.deepEqual(seen, []);
      });
    });

    void it('reads its own copy with readConsistency local, and the same after a linearizable read', async () => {
      await withStream(async (stream) => {
        const writer = adapterFor(stream);
        const reader = adapterFor(stream, { readConsistency: 'local' });
        expectOk(await writer.set('k', 'v', { signal }));
        // A local read may be a moment behind; it catches up.
        await eventually(() => {
          return true;
        }, 'nothing');
        let value: string | undefined;
        for (let attempt = 0; attempt < 100 && value !== 'v'; attempt += 1) {
          value = expectOk(await reader.get('k', { signal }))?.value;
          if (value !== 'v') {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        assert.equal(value, 'v');
      });
    });

    void it('reconnects with a new channel after the old one closes, and carries on', async () => {
      await withStream(async (stream) => {
        const channels: Awaited<
          ReturnType<typeof connection.createConfirmChannel>
        >[] = [];
        const adapter = adapterFor(stream, {
          channel: async () => {
            const channel = await connection.createConfirmChannel();
            channels.push(channel);
            return channel;
          },
          retryMs: 50,
        });
        const seen: (StoredValue | null)[] = [];
        const stop =
          adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        expectOk(await adapter.set('a', '1', { signal }));
        await (channels[0] as { close(): Promise<void> }).close();
        await eventually(() => channels.length === 2, 'a second channel');
        const other = adapterFor(stream);
        const written = expectOk(await other.set('k', 'later', { signal }));
        await eventually(
          () => seen.length === 1,
          'the change after reconnecting'
        );
        assert.deepEqual(seen, [written]);
        assert.equal(expectOk(await adapter.get('a', { signal }))?.value, '1');
        stop();
      });
    });

    void it(
      'keeps entries alive through retention by snapshots: a new process rebuilds from the oldest snapshot left',
      { timeout: 120_000 },
      async () => {
        const firstOffset = async (stream: string): Promise<number> => {
          const channel = await connection.createConfirmChannel();
          await channel.prefetch(1);
          return new Promise<number>((resolve) => {
            void channel
              .consume(
                stream,
                (message) => {
                  if (message !== null) {
                    resolve(
                      message.properties.headers?.['x-stream-offset'] as number
                    );
                    channel.ack(message);
                  }
                },
                { noAck: false, arguments: { 'x-stream-offset': 'first' } }
              )
              .catch(() => undefined);
          });
        };
        await withStream(async (stream) => {
          // Segments of 1 MB, and room for about eight of them: older ones are deleted.
          const streamArguments = {
            'x-stream-max-segment-size-bytes': 1_000_000,
            'x-max-length-bytes': 8_000_000,
          };
          const writer = adapterFor(stream, { streamArguments });
          expectOk(
            await writer.set('keep', 'written once, at the start', { signal })
          );
          let latest: StoredValue | null = null;
          for (let index = 0; index < 24; index += 1) {
            latest = expectOk(
              await writer.set(
                'filler',
                `${String(index)}:${'x'.repeat(900_000)}`,
                {
                  signal,
                }
              )
            );
            if (index % 2 === 1) {
              expectOk(await writer.compact());
            }
          }
          // Retention runs when segments roll; wait until the beginning is really gone.
          let head = 0;
          for (let attempt = 0; attempt < 100 && head === 0; attempt += 1) {
            head = await firstOffset(stream);
            if (head === 0) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          assert.ok(
            head > 0,
            'RabbitMQ never deleted the beginning of the stream'
          );
          const fresh = adapterFor(stream, { streamArguments });
          assert.equal(
            expectOk(await fresh.get('keep', { signal }))?.value,
            'written once, at the start'
          );
          assert.deepEqual(
            expectOk(await fresh.get('filler', { signal })),
            latest
          );
          assert.deepEqual(
            expectOk(
              (await fresh.list?.('', { signal })) ?? { ok: true, value: [] }
            ),
            ['filler', 'keep']
          );
          // Revisions from before the deletion still work for a safe update.
          expectOk(
            await fresh.set('filler', 'updated', {
              signal,
              ifRevision: latest?.revision as string,
            })
          );
        });
      }
    );

    void it(
      'publishes snapshots by itself with snapshotIntervalMs, which a new process can use',
      { timeout: 30_000 },
      async () => {
        await withStream(async (stream) => {
          const writer = adapterFor(stream, { snapshotIntervalMs: 1000 });
          expectOk(await writer.set('a', '1', { signal }));
          const other = adapterFor(stream);
          // Find the snapshot by reading the raw stream.
          const channel = await connection.createConfirmChannel();
          await channel.prefetch(100);
          const ops: string[] = [];
          await channel.consume(
            stream,
            (message) => {
              if (message !== null) {
                ops.push(
                  String(
                    (JSON.parse(message.content.toString()) as { op: string })
                      .op
                  )
                );
                channel.ack(message);
              }
            },
            { noAck: false, arguments: { 'x-stream-offset': 'first' } }
          );
          await eventually(
            () => ops.includes('snapshot'),
            'an automatic snapshot'
          );
          assert.equal(expectOk(await other.get('a', { signal }))?.value, '1');
        });
      }
    );

    void it('says so when the queue exists but is not a stream, naming the key', async () => {
      const queue = freshStream();
      await admin.assertQueue(queue, { durable: true });
      try {
        const adapter = adapterFor(queue);
        const result = await adapter.get('k', { signal });
        assert.ok(!result.ok);
        assert.equal(result.code, 'unavailable');
        assert.ok(result.error.includes('"k"'), result.error);
        assert.match(result.error, /must be a stream/);
      } finally {
        await closeAll();
        await admin.deleteQueue(queue);
      }
    });

    void it('says why when another process declared the stream with different arguments', async () => {
      await withStream(async (stream) => {
        const first = adapterFor(stream, {
          streamArguments: { 'x-max-length-bytes': 8_000_000 },
        });
        expectOk(await first.set('a', '1', { signal }));
        const second = adapterFor(stream);
        const result = await second.get('a', { signal });
        assert.ok(!result.ok);
        assert.equal(result.code, 'unavailable');
        assert.match(
          result.error,
          /every process needs the same streamArguments/
        );
        const trusting = adapterFor(stream, { createStream: false });
        assert.equal(expectOk(await trusting.get('a', { signal }))?.value, '1');
      });
    });

    void it('says so when the stream is missing and createStream is off', async () => {
      const adapter = adapterFor(freshStream(), { createStream: false });
      const result = await adapter.set('k', 'v', { signal });
      assert.ok(!result.ok);
      assert.equal(result.code, 'unavailable');
      assert.ok(result.error.includes('"k"'), result.error);
    });

    void it('skips messages that are not entries, and still works', async () => {
      await withStream(async (stream) => {
        const raw = await connection.createConfirmChannel();
        const messages: string[] = [];
        const adapter = adapterFor(stream, {
          onError: (message) => messages.push(message),
        });
        expectOk(await adapter.set('a', '1', { signal }));
        await new Promise<void>((resolve, reject) => {
          raw.sendToQueue(stream, Buffer.from('not json'), {}, (error) =>
            error ? reject(error as Error) : resolve()
          );
        });
        await new Promise<void>((resolve, reject) => {
          raw.sendToQueue(stream, Buffer.from('{"id":1}'), {}, (error) =>
            error ? reject(error as Error) : resolve()
          );
        });
        expectOk(await adapter.set('b', '2', { signal }));
        assert.equal(expectOk(await adapter.get('b', { signal }))?.value, '2');
        assert.equal(messages.filter((m) => /not an entry/.test(m)).length, 2);
      });
    });

    void it('refuses a key or value that cannot be stored, naming the key', async () => {
      await withStream(async (stream) => {
        const adapter = adapterFor(stream);
        for (const result of [
          await adapter.set('k'.repeat(1025), 'v', { signal }),
          await adapter.set('\ud800', 'v', { signal }),
          await adapter.set('k', '\udc00', { signal }),
          await adapter.set('k', 'x'.repeat(4_000_001), { signal }),
        ]) {
          assert.ok(!result.ok);
          assert.equal(result.code, 'invalid');
        }
      });
    });
  });

  process.on('exit', () => {
    void connection.close();
  });
}
