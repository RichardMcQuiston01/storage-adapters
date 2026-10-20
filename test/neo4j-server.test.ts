/**
 * The Neo4j adapter against a real Neo4j server, through `neo4j-driver`.
 * Skipped unless a URL is named:
 *
 *   TEST_NEO4J_URL=bolt://127.0.0.1:7687
 *   TEST_NEO4J_USER / TEST_NEO4J_PASSWORD   (if the server needs a login)
 *
 * Each test uses a node label of its own, which it clears afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';

import neo4j from 'neo4j-driver';

import {
  neo4jAdapter,
  type Neo4jAdapterOptions,
  type Neo4jDriverLike,
} from '../src/neo4j/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

/** Waits until a condition holds, or fails after eight seconds. */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const url: string | undefined = process.env.TEST_NEO4J_URL;
if (url === undefined || url === '') {
  void describe('neo4jAdapter on a Neo4j server', () => {
    void it('is skipped: set TEST_NEO4J_URL to run it', { skip: true }, () => {
      // Nothing to run without a server.
    });
  });
} else {
  const user: string | undefined = process.env.TEST_NEO4J_USER;
  const driver = neo4j.driver(
    url,
    user === undefined
      ? undefined
      : neo4j.auth.basic(user, process.env.TEST_NEO4J_PASSWORD ?? '')
  );
  // A Driver fits the adapter as it is.
  const driverLike: Neo4jDriverLike = driver;

  after(async () => {
    await driver.close();
  });

  /** Runs Cypher of our own, outside the adapter. */
  const cypher = async (
    query: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>[]> => {
    const session = driver.session();
    try {
      const result = await session.run(query, params);
      return result.records.map((record) => record.toObject());
    } finally {
      await session.close();
    }
  };

  const freshLabel = (): string => `T_${randomBytes(6).toString('hex')}`;
  const dropLabel = async (label: string): Promise<void> => {
    await cypher(`MATCH (n:${label}) DETACH DELETE n`);
    await cypher(`DROP CONSTRAINT ${label}_key_unique IF EXISTS`);
  };
  const adapterFor = (
    label: string,
    more: Partial<Neo4jAdapterOptions> = {}
  ): StorageAdapter => neo4jAdapter({ driver: driverLike, label, ...more });

  runConformance('neo4jAdapter on a Neo4j server', {
    ownWrites: 'notifies',
    create: () => {
      const label: string = freshLabel();
      return {
        adapter: adapterFor(label),
        reopen: () => adapterFor(label),
        cleanup: () => dropLabel(label),
      };
    },
  });

  void describe('neo4jAdapter on a Neo4j server: beyond the contract', () => {
    const withLabel = async (
      body: (label: string) => Promise<void>
    ): Promise<void> => {
      const label: string = freshLabel();
      try {
        await body(label);
      } finally {
        await dropLabel(label);
      }
    };

    void it('counts revisions per key from 1, and starts again after a removal', async () => {
      await withLabel(async (label) => {
        const adapter = adapterFor(label);
        assert.equal(
          expectOk(await adapter.set('a', 'x', { signal })).revision,
          '1'
        );
        assert.equal(
          expectOk(await adapter.set('a', 'y', { signal })).revision,
          '2'
        );
        assert.equal(
          expectOk(await adapter.set('b', 'z', { signal })).revision,
          '1'
        );
        assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
          value: 'y',
          revision: '2',
        });
        expectOk(
          (await adapter.remove?.('a', { signal })) ?? { ok: true, value: null }
        );
        assert.equal(
          expectOk(await adapter.set('a', 'again', { signal })).revision,
          '1'
        );
      });
    });

    void it('keeps the node readable in Cypher, with whole-number revisions and both timestamps', async () => {
      await withLabel(async (label) => {
        const adapter = adapterFor(label);
        expectOk(await adapter.set('theme', 'dark', { signal }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expectOk(await adapter.set('theme', 'light', { signal }));
        const rows = await cypher(
          `MATCH (n:${label} {key: $key}) RETURN n.value AS value, n.revision AS revision, valueType(n.revision) AS type, n.created_at AS created, n.updated_at AS updated, n.lock_ AS lock`,
          { key: 'theme' }
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.value, 'light');
        assert.equal(String(rows[0]?.revision), '2');
        assert.match(String(rows[0]?.type), /INTEGER/);
        assert.equal(rows[0]?.lock, null);
        assert.ok(rows[0]?.created !== null && rows[0]?.updated !== null);
      });
    });

    void it('lets only one of two adapters holding the same revision win, and names the winner', async () => {
      await withLabel(async (label) => {
        const first = adapterFor(label);
        const second = adapterFor(label);
        const written = expectOk(await first.set('k', 'one', { signal }));
        const results = await Promise.all([
          first.set('k', 'from first', {
            signal,
            ifRevision: written.revision as string,
          }),
          second.set('k', 'from second', {
            signal,
            ifRevision: written.revision as string,
          }),
        ]);
        assert.equal(results.filter((result) => result.ok).length, 1);
        const loser = results.find((result) => !result.ok);
        assert.ok(loser !== undefined && !loser.ok);
        assert.equal(loser.code, 'conflict');
        assert.match(
          loser.error,
          /holds revision 2, but revision 1 was expected/
        );
      });
    });

    void it('lets exactly one of many writers holding the same revision win', async () => {
      await withLabel(async (label) => {
        const adapters: StorageAdapter[] = Array.from({ length: 8 }, () =>
          adapterFor(label)
        );
        const seeded = expectOk(
          (await adapters[0]?.set('k', 'start', { signal })) ?? {
            ok: true,
            value: { value: '', revision: '' },
          }
        );
        const results = await Promise.all(
          adapters.map((adapter, index) =>
            adapter.set('k', `writer ${String(index)}`, {
              signal,
              ifRevision: seeded.revision as string,
            })
          )
        );
        assert.equal(results.filter((result) => result.ok).length, 1);
        for (const result of results) {
          if (!result.ok) {
            assert.equal(result.code, 'conflict');
          }
        }
        assert.equal(
          expectOk(
            (await adapters[0]?.get('k', { signal })) ?? {
              ok: true,
              value: null,
            }
          )?.revision,
          '2'
        );
      });
    });

    void it('loses no update when two adapters count together', async () => {
      await withLabel(async (label) => {
        const adapters: StorageAdapter[] = [
          adapterFor(label),
          adapterFor(label),
        ];
        expectOk(
          (await adapters[0]?.set('n', '0', { signal })) ?? {
            ok: true,
            value: { value: '' },
          }
        );
        const bump = async (adapter: StorageAdapter): Promise<void> => {
          for (let done = 0; done < 10;) {
            const current = expectOk(await adapter.get('n', { signal }));
            const next: string = String(Number(current?.value ?? '0') + 1);
            const result = await adapter.set('n', next, {
              signal,
              ...(current?.revision === undefined
                ? {}
                : { ifRevision: current.revision }),
            });
            if (result.ok) {
              done += 1;
            } else {
              assert.equal(result.code, 'conflict');
            }
          }
        };
        await Promise.all(adapters.map(bump));
        const total = expectOk(
          (await adapters[1]?.get('n', { signal })) ?? { ok: true, value: null }
        );
        assert.equal(total?.value, '20');
        assert.equal(total?.revision, '21');
      });
    });

    void it('counts every unconditional write from several adapters', async () => {
      await withLabel(async (label) => {
        const adapters: StorageAdapter[] = [
          adapterFor(label),
          adapterFor(label),
          adapterFor(label),
        ];
        const write = async (adapter: StorageAdapter): Promise<void> => {
          for (let done = 0; done < 15; done += 1) {
            expectOk(await adapter.set('k', 'v', { signal }));
          }
        };
        await Promise.all(adapters.map(write));
        assert.equal(
          expectOk(
            (await adapters[0]?.get('k', { signal })) ?? {
              ok: true,
              value: null,
            }
          )?.revision,
          '45'
        );
      });
    });

    void it('creates a key once when several adapters write it for the first time', async () => {
      await withLabel(async (label) => {
        const adapters: StorageAdapter[] = Array.from({ length: 6 }, () =>
          adapterFor(label)
        );
        const results = await Promise.all(
          adapters.map((adapter, index) =>
            adapter.set('fresh', `writer ${String(index)}`, { signal })
          )
        );
        for (const result of results) {
          expectOk(result);
        }
        const nodes = await cypher(
          `MATCH (n:${label} {key: 'fresh'}) RETURN n.revision AS revision`
        );
        assert.equal(nodes.length, 1);
        assert.equal(String(nodes[0]?.revision), '6');
      });
    });

    void it('keeps the value exactly, including emoji, newlines, quotes and a 5 MB value', async () => {
      await withLabel(async (label) => {
        const adapter = adapterFor(label);
        for (const value of [
          'line one\nline two 😀 é\t"quoted" \\ back',
          '{"r":1}',
          '',
          '123',
          'x'.repeat(5 * 1024 * 1024),
        ]) {
          expectOk(await adapter.set('k', value, { signal }));
          assert.equal(
            expectOk(await adapter.get('k', { signal }))?.value,
            value
          );
        }
      });
    });

    void it('stores awkward keys, including an empty one and the longest allowed, and lists them under a prefix', async () => {
      await withLabel(async (label) => {
        const adapter = adapterFor(label);
        const keys = [
          'user/1',
          'user/2 é',
          'users',
          'a b?#&=%',
          '😀',
          "it's",
          '`back` {tick}',
          'k'.repeat(8000),
          '😀'.repeat(2000),
        ];
        for (const key of keys) {
          expectOk(await adapter.set(key, key, { signal }));
          assert.equal(
            expectOk(await adapter.get(key, { signal }))?.value,
            key
          );
        }
        expectOk(await adapter.set('', 'empty', { signal }));
        assert.equal(
          expectOk(await adapter.get('', { signal }))?.value,
          'empty'
        );
        const list = async (prefix: string): Promise<readonly string[]> =>
          expectOk(
            (await adapter.list?.(prefix, { signal })) ?? {
              ok: true,
              value: [],
            }
          );
        assert.deepEqual(await list('user/'), ['user/1', 'user/2 é']);
        assert.deepEqual(await list(''), ['', ...keys].sort());
      });
    });

    void it('refuses a key over the index limit, naming the key', async () => {
      await withLabel(async (label) => {
        const adapter = adapterFor(label);
        const long: string = 'k'.repeat(8001);
        const result = await adapter.set(long, 'v', { signal });
        assert.ok(!result.ok);
        assert.equal(result.code, 'invalid');
        assert.ok(result.error.includes('key'), result.error);
      });
    });

    void it('lists many keys', async () => {
      await withLabel(async (label) => {
        const adapter = adapterFor(label);
        expectOk(
          await adapter.set('warm-up', 'creates the constraint', { signal })
        );
        const keys: string[] = [];
        const names: string[] = [];
        for (let index = 0; index < 2150; index += 1) {
          const name = `n${String(index).padStart(5, '0')}`;
          keys.push(name);
          names.push(name);
        }
        await cypher(
          `UNWIND $names AS name CREATE (:${label} {key: name, value: 'v', revision: 1})`,
          { names }
        );
        const listed = expectOk(
          (await adapter.list?.('n', { signal })) ?? { ok: true, value: [] }
        );
        assert.deepEqual(listed, keys);
      });
    });

    void it('hears writes and removals made through another adapter when polling', async () => {
      await withLabel(async (label) => {
        const listener = adapterFor(label, { pollIntervalMs: 100 });
        const writer = adapterFor(label);
        expectOk(await writer.set('other', 'warm-up', { signal }));
        const seen: (StoredValue | null)[] = [];
        const stop =
          listener.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 400));
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

    void it('tells a polling subscriber about its own writes once', async () => {
      await withLabel(async (label) => {
        const adapter = adapterFor(label, { pollIntervalMs: 50 });
        const seen: (StoredValue | null)[] = [];
        const stop =
          adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 200));
        for (let index = 0; index < 10; index += 1) {
          expectOk(await adapter.set('k', `v${String(index)}`, { signal }));
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        stop();
        assert.deepEqual(
          seen.map((stored) => stored?.value),
          Array.from({ length: 10 }, (_, index) => `v${String(index)}`)
        );
      });
    });

    void it('reports a node that is not an entry as corrupt, and lets a remove clear it', async () => {
      await withLabel(async (label) => {
        const adapter = adapterFor(label);
        expectOk(
          await adapter.set('warm-up', 'creates the constraint', { signal })
        );
        for (const props of [
          "{key: 'k', value: 'no revision'}",
          "{key: 'k', value: 'text revision', revision: 'five'}",
        ]) {
          await cypher(`CREATE (:${label} ${props})`);
          for (const result of [
            await adapter.get('k', { signal }),
            await adapter.set('k', 'v', { signal }),
            await adapter.set('k', 'v', { signal, ifRevision: '3' }),
          ]) {
            assert.ok(!result.ok, props);
            assert.equal(result.code, 'corrupt', props);
            assert.ok(result.error.includes('"k"'), result.error);
          }
          expectOk(
            (await adapter.remove?.('k', { signal })) ?? {
              ok: true,
              value: null,
            }
          );
          assert.equal(
            expectOk(await adapter.set('k', 'v', { signal })).revision,
            '1'
          );
          expectOk(
            (await adapter.remove?.('k', { signal })) ?? {
              ok: true,
              value: null,
            }
          );
        }
      });
    });

    void it('reports a node with no value as corrupt when read, and a write repairs it', async () => {
      await withLabel(async (label) => {
        const adapter = adapterFor(label);
        expectOk(
          await adapter.set('warm-up', 'creates the constraint', { signal })
        );
        await cypher(`CREATE (:${label} {key: 'k', revision: 3})`);
        const read = await adapter.get('k', { signal });
        assert.ok(!read.ok);
        assert.equal(read.code, 'corrupt');
        assert.equal(
          expectOk(await adapter.set('k', 'v', { signal })).revision,
          '4'
        );
        assert.deepEqual(expectOk(await adapter.get('k', { signal })), {
          value: 'v',
          revision: '4',
        });
      });
    });

    void it('refuses a label that is not an identifier, naming the key', async () => {
      const adapter = adapterFor('bad label}) DETACH DELETE (n');
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.equal(result.code, 'invalid');
      assert.ok(result.error.includes('"k"'), result.error);
    });

    void it('says so when the database does not exist', async () => {
      const adapter = adapterFor(freshLabel(), {
        sessionConfig: { database: 'no-such-database' },
        createConstraint: false,
      });
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.equal(result.code, 'unavailable');
      assert.ok(result.error.includes('"k"'), result.error);
    });
  });
}
