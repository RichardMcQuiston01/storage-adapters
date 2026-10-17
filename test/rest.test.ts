/**
 * The REST adapter, against a fake server that speaks its protocol (always run) and
 * against a real HTTP server on the loopback interface (no outside network).
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, describe, it } from 'node:test';

import {
  restAdapter,
  type FetchLike,
  type FetchResponseLike,
} from '../src/rest/index.js';
import type { StoredValue, StoreResult } from '../src/storage.js';
import { runConformance } from './support/conformance.js';

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
  assert.ok(result.error.startsWith('REST API '), result.error);
  return result.error;
}

const BASE = 'https://api.test/storage';

interface Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

interface FakeServer {
  readonly fetch: FetchLike;
  readonly requests: Request[];
  readonly data: Map<string, { value: string; revision: number }>;
}

interface FakeServerOptions {
  /** What the server says to `If-Match` on a key with nothing stored. */
  readonly ifMatchOnMissing: 'creates' | '412' | '404';
  /** Where the revision travels. */
  readonly revisionIn: 'body' | 'etag';
}

/** A server for the protocol the adapter documents. */
function fakeServer(
  options: FakeServerOptions = {
    ifMatchOnMissing: 'creates',
    revisionIn: 'body',
  }
): FakeServer {
  const data = new Map<string, { value: string; revision: number }>();
  const requests: Request[] = [];
  const reply = (
    status: number,
    body: object | null,
    revision?: number
  ): Promise<FetchResponseLike> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (revision !== undefined && options.revisionIn === 'etag') {
      headers.ETag = `"${revision}"`;
    }
    const payload =
      body === null
        ? null
        : JSON.stringify(
            revision !== undefined && options.revisionIn === 'body'
              ? { ...body, revision: String(revision) }
              : body
          );
    return Promise.resolve(new Response(payload, { status, headers }));
  };
  const fetchLike: FetchLike = (url, init) => {
    requests.push({
      method: init.method,
      url,
      headers: init.headers,
      body: init.body,
    });
    if (init.signal.aborted) {
      return Promise.reject(new Error('aborted'));
    }
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith('/storage')) {
      return reply(404, { error: 'no such route' });
    }
    const rest = parsed.pathname.slice('/storage'.length);
    if (rest === '' || rest === '/') {
      if (init.method !== 'GET') {
        return reply(405, { error: 'method not allowed' });
      }
      const prefix = parsed.searchParams.get('prefix') ?? '';
      return reply(200, {
        keys: [...data.keys()].filter((key) => key.startsWith(prefix)),
      });
    }
    const key = decodeURIComponent(rest.slice(1));
    const current = data.get(key);
    if (init.method === 'GET') {
      return current === undefined
        ? reply(404, { error: 'not found' })
        : reply(200, { value: current.value }, current.revision);
    }
    if (init.method === 'DELETE') {
      data.delete(key);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (init.method === 'PUT') {
      const { value } = JSON.parse(init.body ?? '{}') as { value: string };
      const ifMatch = init.headers['If-Match'];
      const ifNoneMatch = init.headers['If-None-Match'];
      const stored = (): string => String(current?.revision);
      const matches = ifMatch === stored() || ifMatch === `"${stored()}"`;
      if (ifMatch !== undefined && current === undefined) {
        if (options.ifMatchOnMissing === '412') {
          return reply(412, { error: 'precondition failed' });
        }
        if (options.ifMatchOnMissing === '404') {
          return reply(404, { error: 'not found' });
        }
      } else if (ifMatch !== undefined && !matches) {
        return reply(412, { error: 'precondition failed' });
      }
      if (ifNoneMatch === '*' && current !== undefined) {
        return reply(412, { error: 'precondition failed' });
      }
      const revision = (current?.revision ?? 0) + 1;
      data.set(key, { value, revision });
      return reply(current === undefined ? 201 : 200, {}, revision);
    }
    return reply(405, { error: 'method not allowed' });
  };
  return { fetch: fetchLike, requests, data };
}

for (const options of [
  { ifMatchOnMissing: 'creates', revisionIn: 'body' },
  { ifMatchOnMissing: '412', revisionIn: 'etag' },
  { ifMatchOnMissing: '404', revisionIn: 'body' },
] as const) {
  runConformance(
    `restAdapter on a fake server (If-Match on a missing key: ${options.ifMatchOnMissing}, revision in the ${options.revisionIn})`,
    {
      ownWrites: 'notifies',
      create: () => {
        const server = fakeServer(options);
        return {
          adapter: restAdapter({ baseUrl: BASE, fetch: server.fetch }),
          reopen: () => restAdapter({ baseUrl: BASE, fetch: server.fetch }),
        };
      },
    }
  );
}

/** A fetch that answers with a fixed response, or fails. */
function answering(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): FetchLike {
  return () => Promise.resolve(new Response(body, { status, headers }));
}

void describe('restAdapter requests', () => {
  void it('puts the key in the path, encoded, under the base URL without a trailing slash', async () => {
    const server = fakeServer();
    const adapter = restAdapter({ baseUrl: `${BASE}//`, fetch: server.fetch });
    expectOk(await adapter.set('a b/c?d', 'v', { signal }));
    assert.equal(server.requests[0]?.url, `${BASE}/a%20b%2Fc%3Fd`);
    assert.equal(server.requests[0]?.method, 'PUT');
    assert.equal(server.requests[0]?.body, '{"value":"v"}');
    assert.equal(
      server.requests[0]?.headers['Content-Type'],
      'application/json'
    );
    assert.equal(server.data.get('a b/c?d')?.value, 'v');
  });

  void it('sends the revision as If-Match, exactly as the server gave it', async () => {
    const server = fakeServer({
      ifMatchOnMissing: 'creates',
      revisionIn: 'etag',
    });
    const adapter = restAdapter({ baseUrl: BASE, fetch: server.fetch });
    const first = expectOk(await adapter.set('k', 'one', { signal }));
    assert.equal(first.revision, '"1"');
    expectOk(
      await adapter.set('k', 'two', {
        signal,
        ifRevision: first.revision ?? '',
      })
    );
    const put = server.requests.filter((r) => r.method === 'PUT')[1];
    assert.equal(put?.headers['If-Match'], '"1"');
  });

  void it('sends configured headers, calling a function for each request', async () => {
    const server = fakeServer();
    let calls = 0;
    const adapter = restAdapter({
      baseUrl: BASE,
      fetch: server.fetch,
      headers: () => {
        calls += 1;
        return { Authorization: `Bearer token-${calls}` };
      },
    });
    await adapter.get('a', { signal });
    await adapter.get('a', { signal });
    assert.deepEqual(
      server.requests.map((r) => r.headers.Authorization),
      ['Bearer token-1', 'Bearer token-2']
    );
  });

  void it('lists by prefix and sends the prefix encoded', async () => {
    const server = fakeServer();
    const adapter = restAdapter({ baseUrl: BASE, fetch: server.fetch });
    await adapter.set('a&b', '1', { signal });
    assert.deepEqual(
      expectOk(
        (await adapter.list?.('a&', { signal })) ?? { ok: true, value: [] }
      ),
      ['a&b']
    );
    assert.equal(server.requests.at(-1)?.url, `${BASE}?prefix=a%26`);
  });

  void it('creates a key the server refuses to check, then reports a later conflict', async () => {
    const server = fakeServer({ ifMatchOnMissing: '412', revisionIn: 'body' });
    const adapter = restAdapter({ baseUrl: BASE, fetch: server.fetch });
    expectOk(await adapter.set('k', 'v', { signal, ifRevision: '9' }));
    const sequence = server.requests.map(
      (r) =>
        `${r.method} ${r.headers['If-Match'] ?? r.headers['If-None-Match'] ?? ''}`
    );
    assert.deepEqual(sequence, ['PUT 9', 'GET ', 'PUT *']);
    const message = expectFailure(
      await adapter.set('k', 'w', { signal, ifRevision: '9' }),
      'conflict',
      'k'
    );
    assert.match(message, /holds revision 1, but revision 9 was expected/);
  });

  void it('notifies subscribers of its own writes and removals', async () => {
    const adapter = restAdapter({ baseUrl: BASE, fetch: fakeServer().fetch });
    const heard: (StoredValue | null)[] = [];
    adapter.subscribe?.('k', (stored) => heard.push(stored));
    await adapter.set('k', 'v', { signal });
    await adapter.remove?.('k', { signal });
    assert.equal(heard.length, 2);
    assert.equal(heard[1], null);
  });
});

void describe('restAdapter failures', () => {
  void it('never calls the server for an aborted signal or an empty key', async () => {
    const server = fakeServer();
    const adapter = restAdapter({ baseUrl: BASE, fetch: server.fetch });
    const controller = new AbortController();
    controller.abort();
    expectFailure(
      await adapter.get('k', { signal: controller.signal }),
      'unavailable',
      'k'
    );
    expectFailure(await adapter.get('', { signal }), 'invalid', '');
    expectFailure(await adapter.set('', 'v', { signal }), 'invalid', '');
    assert.equal(server.requests.length, 0);
  });

  const cases: readonly (readonly [number, string])[] = [
    [401, 'forbidden'],
    [403, 'forbidden'],
    [413, 'quota'],
    [507, 'quota'],
    [400, 'invalid'],
    [422, 'invalid'],
    [429, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ];
  for (const [status, code] of cases) {
    void it(`maps HTTP ${status} to ${code} and includes what the server said`, async () => {
      const adapter = restAdapter({
        baseUrl: BASE,
        fetch: answering(status, JSON.stringify({ error: 'because reasons' })),
      });
      for (const result of [
        await adapter.get('k', { signal }),
        await adapter.set('k', 'v', { signal }),
        (await adapter.remove?.('k', { signal })) as StoreResult<null>,
      ]) {
        const message = expectFailure(result, code, 'k');
        assert.match(message, new RegExp(`HTTP ${status}`));
        assert.match(message, /because reasons/);
      }
    });
  }

  void it('says unavailable, with the cause, when the network fails', async () => {
    const adapter = restAdapter({
      baseUrl: BASE,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      name: 'Settings API',
    });
    const result = await adapter.get('k', { signal });
    if (result.ok) assert.fail('expected a failure');
    assert.equal(result.code, 'unavailable');
    assert.match(
      result.error,
      /^Settings API could not be reached \(fetch failed\) for key "k"$/
    );
  });

  void it('says corrupt when a read is not the documented shape', async () => {
    for (const body of ['not json', '[]', '{"value": 5}', '{}']) {
      const adapter = restAdapter({
        baseUrl: BASE,
        fetch: answering(200, body),
      });
      expectFailure(await adapter.get('k', { signal }), 'corrupt', 'k');
    }
  });

  void it('truncates a long error body', async () => {
    const adapter = restAdapter({
      baseUrl: BASE,
      fetch: answering(500, 'x'.repeat(5000)),
    });
    const result = await adapter.get('k', { signal });
    if (result.ok) assert.fail('expected a failure');
    assert.ok(result.error.length < 400, `${result.error.length} characters`);
    assert.match(result.error, /\.\.\./);
  });

  void it('treats a delete of a missing key as done', async () => {
    const adapter = restAdapter({ baseUrl: BASE, fetch: answering(404, '') });
    assert.deepEqual(await adapter.remove?.('k', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('stops after a few tries when a key keeps appearing and vanishing', async () => {
    let gets = 0;
    const flapping: FetchLike = (_url, init) => {
      if (init.method === 'PUT') {
        return Promise.resolve(new Response('{}', { status: 412 }));
      }
      gets += 1;
      return gets % 2 === 1
        ? Promise.resolve(new Response('{}', { status: 404 }))
        : Promise.resolve(new Response('{}', { status: 404 }));
    };
    const adapter = restAdapter({ baseUrl: BASE, fetch: flapping });
    expectFailure(
      await adapter.set('k', 'v', { signal, ifRevision: '1' }),
      'unavailable',
      'k'
    );
  });

  void describe('list', () => {
    void it('says invalid when the server has no listing', async () => {
      for (const status of [404, 405, 501]) {
        const adapter = restAdapter({
          baseUrl: BASE,
          fetch: answering(status, ''),
        });
        const result = await adapter.list?.('p', { signal });
        if (result === undefined || result.ok)
          assert.fail('expected a failure');
        assert.equal(result.code, 'invalid');
        assert.match(result.error, /for prefix "p"$/);
      }
    });

    void it('says corrupt for an answer that is not {"keys": [...]}, and ignores keys outside the prefix', async () => {
      const bad = restAdapter({
        baseUrl: BASE,
        fetch: answering(200, '{"keys": [1]}'),
      });
      const result = await bad.list?.('p', { signal });
      if (result === undefined || result.ok) assert.fail('expected a failure');
      assert.equal(result.code, 'corrupt');
      const sloppy = restAdapter({
        baseUrl: BASE,
        fetch: answering(200, '{"keys": ["p2", "q", "p1"]}'),
      });
      assert.deepEqual(
        expectOk(
          (await sloppy.list?.('p', { signal })) ?? { ok: true, value: [] }
        ),
        ['p1', 'p2']
      );
    });
  });
});

/** The same protocol on a real HTTP server, reached with the runtime's own `fetch`. */
void describe('restAdapter against a real HTTP server', () => {
  const data = new Map<string, { value: string; revision: number }>();
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const send = (status: number, payload?: object, headers = {}): void => {
        response.writeHead(status, {
          'Content-Type': 'application/json',
          ...headers,
        });
        response.end(
          payload === undefined ? undefined : JSON.stringify(payload)
        );
      };
      if (url.pathname === '/api' || url.pathname === '/api/') {
        const prefix = url.searchParams.get('prefix') ?? '';
        send(200, {
          keys: [...data.keys()].filter((k) => k.startsWith(prefix)),
        });
        return;
      }
      const key = decodeURIComponent(url.pathname.slice('/api/'.length));
      const current = data.get(key);
      if (request.method === 'GET') {
        if (current === undefined) return send(404, { error: 'not found' });
        return send(
          200,
          { value: current.value },
          { ETag: `"${current.revision}"` }
        );
      }
      if (request.method === 'DELETE') {
        data.delete(key);
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'PUT') {
        const ifMatch = request.headers['if-match'];
        if (
          ifMatch !== undefined &&
          current !== undefined &&
          ifMatch !== `"${current.revision}"`
        ) {
          return send(412, { error: 'stale' });
        }
        if (ifMatch !== undefined && current === undefined) {
          return send(412, { error: 'missing' });
        }
        if (request.headers['if-none-match'] === '*' && current !== undefined) {
          return send(412, { error: 'exists' });
        }
        const revision = (current?.revision ?? 0) + 1;
        data.set(key, {
          value: (JSON.parse(body) as { value: string }).value,
          revision,
        });
        return send(200, {}, { ETag: `"${revision}"` });
      }
      send(405, { error: 'no' });
    });
  });
  let port = 0;
  const started = new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
  after(() => {
    server.close();
    server.closeAllConnections();
  });

  runConformance('restAdapter through fetch to a loopback server', {
    ownWrites: 'notifies',
    create: async () => {
      await started;
      data.clear();
      const make = () =>
        restAdapter({
          baseUrl: `http://127.0.0.1:${port}/api`,
          fetch: fetch as unknown as FetchLike,
        });
      return { adapter: make(), reopen: make };
    },
  });
});
