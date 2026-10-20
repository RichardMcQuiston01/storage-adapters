/**
 * The InfluxDB adapter against a real InfluxDB server, through `fetch`.
 * Skipped unless a URL is named:
 *
 *   TEST_INFLUXDB_URL=http://127.0.0.1:8086
 *   TEST_INFLUXDB_ORG=my-org
 *   TEST_INFLUXDB_BUCKET=my-bucket     (must exist and keep data forever)
 *   TEST_INFLUXDB_TOKEN=...            (if the server needs one)
 *   TEST_INFLUXDB_EMULATE_DELETE=1     (only for an InfluxDB 1.8 server, which answers
 *                                       Flux queries and writes through the 2.x API but
 *                                       not `/api/v2/delete`: deletes are then sent as
 *                                       InfluxQL `DROP SERIES` instead)
 *
 * Each test uses a measurement of its own, which it drops afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  influxDbAdapter,
  type InfluxDbAdapterOptions,
  type InfluxDbFetch,
} from '../src/influxdb/index.js';
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

const url: string | undefined = process.env.TEST_INFLUXDB_URL;
if (url === undefined || url === '') {
  void describe('influxDbAdapter on an InfluxDB server', () => {
    void it(
      'is skipped: set TEST_INFLUXDB_URL to run it',
      { skip: true },
      () => {
        // Nothing to run without a server.
      }
    );
  });
} else {
  const org: string = process.env.TEST_INFLUXDB_ORG ?? 'org';
  const bucket: string = process.env.TEST_INFLUXDB_BUCKET ?? 'app';
  const token: string | undefined = process.env.TEST_INFLUXDB_TOKEN;
  const emulateDelete: boolean =
    process.env.TEST_INFLUXDB_EMULATE_DELETE === '1';
  const baseUrl: string = url.replace(/\/+$/, '');
  const headers: Record<string, string> =
    token === undefined ? {} : { Authorization: `Token ${token}` };

  /** InfluxQL, for the one thing an InfluxDB 1.8 server cannot do through the 2.x API. */
  const influxQl = async (statement: string): Promise<void> => {
    const response = await fetch(
      `${baseUrl}/query?db=${encodeURIComponent(bucket)}`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `q=${encodeURIComponent(statement)}`,
      }
    );
    assert.equal(response.status, 200, await response.text());
  };

  /** The global `fetch`, with deletes turned into `DROP SERIES` on an InfluxDB 1.8. */
  const serverFetch: InfluxDbFetch = async (target, init) => {
    if (emulateDelete && target.includes('/api/v2/delete')) {
      const body = JSON.parse(init.body ?? '{}') as { predicate: string };
      const match =
        /^_measurement="(\w+)" AND entry_key="((?:[^"\\]|\\.)*)"$/.exec(
          body.predicate
        );
      assert.ok(match !== null, body.predicate);
      const tag = (match[2] ?? '').replace(/\\(.)/g, '$1').replace(/'/g, "\\'");
      await influxQl(
        `DROP SERIES FROM "${match[1] ?? ''}" WHERE "entry_key" = '${tag}'`
      );
      return new Response(null, { status: 204 });
    }
    return fetch(target, init);
  };

  const freshMeasurement = (): string => `t_${randomBytes(6).toString('hex')}`;
  const dropMeasurement = async (measurement: string): Promise<void> => {
    if (emulateDelete) {
      await influxQl(`DROP MEASUREMENT "${measurement}"`);
      return;
    }
    const response = await fetch(
      `${baseUrl}/api/v2/delete?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: '1970-01-01T00:00:00Z',
          stop: '1970-01-01T00:00:01Z',
          predicate: `_measurement="${measurement}"`,
        }),
      }
    );
    assert.ok(response.status < 300, await response.text());
  };

  const adapterFor = (
    measurement: string,
    more: Partial<InfluxDbAdapterOptions> = {}
  ): StorageAdapter =>
    influxDbAdapter({
      url: baseUrl,
      fetch: serverFetch,
      org,
      bucket,
      measurement,
      headers,
      ...more,
    });

  /** Writes line protocol of our own, outside the adapter. */
  const writeLine = async (line: string): Promise<void> => {
    const response = await fetch(
      `${baseUrl}/api/v2/write?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}&precision=ns`,
      { method: 'POST', headers, body: line }
    );
    assert.ok(response.status < 300, await response.text());
  };

  /** Runs Flux of our own and returns the answer text. */
  const flux = async (script: string): Promise<string> => {
    const response = await fetch(
      `${baseUrl}/api/v2/query?org=${encodeURIComponent(org)}`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/vnd.flux',
          Accept: 'application/csv',
        },
        body: script,
      }
    );
    assert.equal(response.status, 200);
    return response.text();
  };

  runConformance('influxDbAdapter on an InfluxDB server', {
    ownWrites: 'notifies',
    create: () => {
      const measurement: string = freshMeasurement();
      return {
        adapter: adapterFor(measurement),
        reopen: () => adapterFor(measurement),
        cleanup: () => dropMeasurement(measurement),
      };
    },
  });

  void describe('influxDbAdapter on an InfluxDB server: beyond the contract', () => {
    const withMeasurement = async (
      body: (measurement: string) => Promise<void>
    ): Promise<void> => {
      const measurement: string = freshMeasurement();
      try {
        await body(measurement);
      } finally {
        await dropMeasurement(measurement);
      }
    };

    void it('gives every write a new revision, and get returns what set did', async () => {
      await withMeasurement(async (measurement) => {
        const adapter = adapterFor(measurement);
        const seen = new Set<string>();
        for (let index = 0; index < 40; index += 1) {
          const written = expectOk(
            await adapter.set('k', `v${String(index)}`, { signal })
          );
          assert.ok(!seen.has(written.revision as string));
          seen.add(written.revision as string);
          assert.deepEqual(
            expectOk(await adapter.get('k', { signal })),
            written
          );
        }
      });
    });

    void it('keeps one point per key, at the fixed timestamp, with tag and fields', async () => {
      await withMeasurement(async (measurement) => {
        const adapter = adapterFor(measurement);
        for (const value of ['one', 'two', 'three']) {
          expectOk(await adapter.set('theme', value, { signal }));
        }
        const answer = await flux(
          `from(bucket: "${bucket}") |> range(start: 0) |> filter(fn: (r) => r._measurement == "${measurement}")`
        );
        // InfluxDB 2.x names the result `_result`; 1.8 leaves it empty.
        const rows = answer
          .split('\n')
          .filter((line) => /^,(_result)?,\d+,/.test(line));
        // Three fields (value, revision, updated_at) of one point.
        assert.equal(rows.length, 3, answer);
        assert.ok(rows.every((row) => row.includes('1970-01-01T00:00:00Z')));
        assert.ok(rows.every((row) => row.includes(',theme')));
        assert.ok(rows.some((row) => row.includes(',three,value')));
      });
    });

    void it('keeps the value exactly, including newlines, NUL, quotes, backslashes, emoji and a 900 kB value', async () => {
      await withMeasurement(async (measurement) => {
        const adapter = adapterFor(measurement);
        for (const value of [
          'line one\nline two 😀 é\t"quoted" \\ back, comma',
          'carriage\r\nreturns\rand\nnewlines\n\n',
          'nul \0 byte',
          '\\n is not a newline, \\\\ is two backslashes\\',
          '{"r":1}',
          '',
          '123',
          '  padded  ',
          'x'.repeat(900_000),
        ]) {
          expectOk(await adapter.set('k', value, { signal }));
          assert.equal(
            expectOk(await adapter.get('k', { signal }))?.value,
            value
          );
        }
      });
    });

    void it('refuses a value over the 1 MiB field limit, naming the key, and keeps the old value', async () => {
      await withMeasurement(async (measurement) => {
        const adapter = adapterFor(measurement);
        expectOk(await adapter.set('big', 'small', { signal }));
        // Escaping makes each newline two bytes, so this is over the limit once stored.
        const result = await adapter.set('big', '\n'.repeat(600_000), {
          signal,
        });
        assert.ok(!result.ok);
        assert.equal(result.code, 'invalid');
        assert.ok(result.error.includes('"big"'), result.error);
        assert.match(result.error, /limits a string field to 1 MiB/);
        assert.equal(
          expectOk(await adapter.get('big', { signal }))?.value,
          'small'
        );
      });
    });

    void it('stores awkward keys, including an empty one, and lists them under a prefix', async () => {
      await withMeasurement(async (measurement) => {
        const adapter = adapterFor(measurement);
        const keys = [
          'user/1',
          'user/2 é',
          'users',
          'a b,c=d',
          'a b?#&=%',
          '😀',
          "it's",
          'say "hi"',
          '${nope}',
          'back\\slash',
          'new\nline',
          '~',
          '%7E',
          'k'.repeat(1000),
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
        assert.deepEqual(await list('a b'), ['a b,c=d', 'a b?#&=%']);
        assert.deepEqual(await list('say "'), ['say "hi"']);
        assert.deepEqual(await list(''), ['', ...keys].sort());
        expectOk(
          (await adapter.remove?.('new\nline', { signal })) ?? {
            ok: true,
            value: null,
          }
        );
        assert.equal(
          expectOk(await adapter.get('new\nline', { signal })),
          null
        );
        assert.equal((await list('')).length, keys.length);
      });
    });

    void it('refuses a key that is too long once escaped, naming the key', async () => {
      await withMeasurement(async (measurement) => {
        const adapter = adapterFor(measurement);
        const long: string = 'k'.repeat(1025);
        const result = await adapter.set(long, 'v', { signal });
        assert.ok(!result.ok);
        assert.equal(result.code, 'invalid');
        assert.ok(result.error.includes('key'), result.error);
      });
    });

    void it('lists many keys', async () => {
      await withMeasurement(async (measurement) => {
        const adapter = adapterFor(measurement);
        const lines: string[] = [];
        const keys: string[] = [];
        for (let index = 0; index < 1500; index += 1) {
          const key = `n${String(index).padStart(5, '0')}`;
          keys.push(key);
          lines.push(
            `${measurement},entry_key=${key} value="v",revision="r1" 0`
          );
        }
        await writeLine(lines.join('\n'));
        const listed = expectOk(
          (await adapter.list?.('n', { signal })) ?? { ok: true, value: [] }
        );
        assert.deepEqual(listed, keys);
      });
    });

    void it('hears writes and removals made through another adapter when polling', async () => {
      await withMeasurement(async (measurement) => {
        const listener = adapterFor(measurement, { pollIntervalMs: 100 });
        const writer = adapterFor(measurement);
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
      await withMeasurement(async (measurement) => {
        const adapter = adapterFor(measurement, { pollIntervalMs: 50 });
        const seen: (StoredValue | null)[] = [];
        const stop =
          adapter.subscribe?.('k', (stored) => seen.push(stored)) ??
          (() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 200));
        for (let index = 0; index < 8; index += 1) {
          expectOk(await adapter.set('k', `v${String(index)}`, { signal }));
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        stop();
        assert.deepEqual(
          seen.map((stored) => stored?.value),
          Array.from({ length: 8 }, (_, index) => `v${String(index)}`)
        );
      });
    });

    void it('reports a point that is not an entry as corrupt, and lets a remove clear it', async () => {
      await withMeasurement(async (measurement) => {
        const adapter = adapterFor(measurement);
        for (const line of [
          `${measurement},entry_key=k value="no revision" 0`,
          `${measurement},entry_key=k,extra=tag value="another tag",revision="r1" 0`,
          `${measurement},entry_key=k other=1i 0`,
        ]) {
          await writeLine(line);
          for (const result of [
            await adapter.get('k', { signal }),
            // A write replaces the point only if it is the same series.
          ]) {
            assert.ok(!result.ok, line);
            assert.equal(result.code, 'corrupt', line);
            assert.ok(result.error.includes('"k"'), result.error);
          }
          await dropMeasurement(measurement);
        }
      });
    });

    void it('refuses a measurement that is not an identifier, naming the key', async () => {
      const adapter = adapterFor('bad measurement" or 1=1');
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.equal(result.code, 'invalid');
      assert.ok(result.error.includes('"k"'), result.error);
    });

    void it('says so when the bucket does not exist', async () => {
      const adapter = adapterFor(freshMeasurement(), {
        bucket: 'no-such-bucket-here',
      });
      for (const result of [
        await adapter.get('k', { signal }),
        await adapter.set('k', 'v', { signal }),
      ]) {
        assert.ok(!result.ok);
        assert.equal(result.code, 'unavailable');
        assert.ok(result.error.includes('"k"'), result.error);
        assert.match(result.error, /no-such-bucket-here/);
      }
    });
  });
}
