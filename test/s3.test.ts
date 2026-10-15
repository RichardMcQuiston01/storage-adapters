import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  awsSdkObjectStore,
  s3Adapter,
  type AwsSdkCommands,
} from '../src/s3/index.js';
import type { StoredValue, StoreResult } from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import {
  etagOf,
  fakeObjectStore,
  s3Error,
  type FakeObjectStore,
} from './support/fake-object-store.js';

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
  key: string,
  label = 'S3'
): string {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  assert.ok(
    result.error.includes(`"${key}"`),
    `error should name the key: ${result.error}`
  );
  assert.ok(result.error.startsWith(`${label} `), result.error);
  return result.error;
}

const probeKeys = (store: FakeObjectStore): string[] =>
  store.calls.filter((call) => call.includes('.storage-adapters-probe-'));

runConformance('s3Adapter on an in-memory store', {
  ownWrites: 'notifies',
  create: () => {
    const store = fakeObjectStore();
    return {
      adapter: s3Adapter({ store }),
      reopen: () => s3Adapter({ store }),
    };
  },
});

runConformance('s3Adapter with a prefix', {
  ownWrites: 'notifies',
  create: () => {
    const store = fakeObjectStore();
    return {
      adapter: s3Adapter({ store, prefix: 'settings/' }),
      reopen: () => s3Adapter({ store, prefix: 'settings/' }),
    };
  },
});

void describe('s3Adapter', () => {
  void it('stores each key as an object under the prefix, with the ETag as its revision', async () => {
    const store = fakeObjectStore();
    const adapter = s3Adapter({ store, prefix: 'app/' });
    const written = expectOk(await adapter.set('theme', 'dark', { signal }));
    assert.deepEqual([...store.objects.keys()], ['app/theme']);
    assert.equal(store.objects.get('app/theme'), 'dark');
    assert.deepEqual(written, { value: 'dark', revision: etagOf('dark') });
    assert.deepEqual(await adapter.get('theme', { signal }), {
      ok: true,
      value: written,
    });
  });

  void it('keeps the revision when a value is written again unchanged', async () => {
    const adapter = s3Adapter({ store: fakeObjectStore() });
    const first = expectOk(await adapter.set('k', 'same', { signal }));
    const second = expectOk(await adapter.set('k', 'same', { signal }));
    assert.equal(first.revision, second.revision);
  });

  void it('makes a plain write without any condition or check', async () => {
    const store = fakeObjectStore();
    expectOk(await s3Adapter({ store }).set('k', 'v', { signal }));
    assert.deepEqual(store.calls, ['put k']);
  });

  void describe('checking that the store enforces conditional writes', () => {
    void it('checks once per adapter, on the first write with a revision, and cleans up', async () => {
      const store = fakeObjectStore();
      const adapter = s3Adapter({ store });
      const first = expectOk(await adapter.set('k', 'one', { signal }));
      await adapter.set('k', 'two', {
        signal,
        ifRevision: first.revision ?? '',
      });
      const probes = probeKeys(store).length;
      assert.ok(probes >= 3, `expected the check to run, saw ${probes} calls`);
      await adapter.set('k', 'three', {
        signal,
        ifRevision: etagOf('two'),
      });
      assert.equal(probeKeys(store).length, probes, 'it must not check again');
      assert.deepEqual(
        [...store.objects.keys()],
        ['k'],
        'no probe object left'
      );
    });

    void it('does not check on a plain write or a read', async () => {
      const store = fakeObjectStore();
      const adapter = s3Adapter({ store });
      await adapter.set('k', 'v', { signal });
      await adapter.get('k', { signal });
      assert.equal(probeKeys(store).length, 0);
    });

    void it('can be switched off for a store known to enforce conditions', async () => {
      const store = fakeObjectStore();
      const adapter = s3Adapter({ store, verifyConditionalWrites: false });
      expectOk(await adapter.set('k', 'v', { signal, ifRevision: 'anything' }));
      assert.equal(probeKeys(store).length, 0);
    });

    void it('puts the probe under the prefix', async () => {
      const store = fakeObjectStore();
      await s3Adapter({ store, prefix: 'p/' }).set('k', 'v', {
        signal,
        ifRevision: 'x',
      });
      assert.ok(
        probeKeys(store).every((call) =>
          call.includes(' p/.storage-adapters-probe-')
        ),
        probeKeys(store).join('\n')
      );
    });

    void it('refuses a revision check on a store that ignores conditions, naming the store', async () => {
      const store = fakeObjectStore('ignored');
      const adapter = s3Adapter({ store, name: 'DigitalOcean Spaces' });
      const message = expectFailure(
        await adapter.set('k', 'v', { signal, ifRevision: '"abc"' }),
        'invalid',
        'k',
        'DigitalOcean Spaces'
      );
      assert.match(message, /does not enforce conditional writes/);
      assert.match(message, /Write without ifRevision/);
      assert.equal(store.objects.has('k'), false, 'nothing may be written');
      assert.deepEqual([...store.objects.keys()], [], 'no probe object left');
    });

    void it('still lets a plain write through on such a store, and remembers the answer', async () => {
      const store = fakeObjectStore('ignored');
      const adapter = s3Adapter({ store });
      expectOk(await adapter.set('k', 'v', { signal }));
      await adapter.set('k', 'w', { signal, ifRevision: 'x' });
      const probes = probeKeys(store).length;
      await adapter.set('k', 'w', { signal, ifRevision: 'x' });
      assert.equal(probeKeys(store).length, probes);
    });

    void it('refuses a revision check on a store that answers 501 Not Implemented', async () => {
      const store = fakeObjectStore('not-implemented');
      const message = expectFailure(
        await s3Adapter({ store }).set('k', 'v', { signal, ifRevision: 'x' }),
        'invalid',
        'k'
      );
      assert.match(message, /does not enforce conditional writes/);
    });

    void it('does not remember a check that could not be made, so the next write checks again', async () => {
      const store = fakeObjectStore();
      const adapter = s3Adapter({ store });
      store.failNext.put = s3Error('AccessDenied', 403, 'Access Denied');
      expectFailure(
        await adapter.set('k', 'v', { signal, ifRevision: 'x' }),
        'forbidden',
        'k'
      );
      expectOk(await adapter.set('k', 'v', { signal, ifRevision: 'x' }));
    });
  });

  void describe('ifRevision', () => {
    void it('writes when the ETag matches and refuses when it does not, naming both', async () => {
      const store = fakeObjectStore();
      const adapter = s3Adapter({ store });
      const first = expectOk(await adapter.set('k', 'one', { signal }));
      expectOk(
        await adapter.set('k', 'two', {
          signal,
          ifRevision: first.revision ?? '',
        })
      );
      const message = expectFailure(
        await adapter.set('k', 'three', {
          signal,
          ifRevision: first.revision ?? '',
        }),
        'conflict',
        'k'
      );
      assert.match(
        message,
        new RegExp(
          `holds revision ${etagOf('two')}, but revision ${first.revision} was expected`
        )
      );
      assert.equal(store.objects.get('k'), 'two');
    });

    void it('sends the revision as If-Match, and creates a missing key with If-None-Match', async () => {
      const store = fakeObjectStore();
      const adapter = s3Adapter({ store, verifyConditionalWrites: false });
      expectOk(await adapter.set('k', 'v', { signal, ifRevision: '"old"' }));
      assert.deepEqual(store.calls, [
        'put k if-match "old"',
        'put k if-none-match *',
      ]);
    });

    void it('reports a conflict when someone else creates the key first', async () => {
      const store = fakeObjectStore();
      const adapter = s3Adapter({ store, verifyConditionalWrites: false });
      const realPut = store.putObject.bind(store);
      store.putObject = async (key, body, options) => {
        if (options.ifNoneMatch !== undefined) {
          store.objects.set(key, 'theirs');
        }
        return realPut(key, body, options);
      };
      const message = expectFailure(
        await adapter.set('k', 'mine', { signal, ifRevision: '"old"' }),
        'conflict',
        'k'
      );
      assert.match(message, new RegExp(`holds revision ${etagOf('theirs')}`));
      assert.equal(store.objects.get('k'), 'theirs');
    });

    void it('writes again as new when the object vanished while the conflict was reported', async () => {
      const store = fakeObjectStore();
      const adapter = s3Adapter({ store, verifyConditionalWrites: false });
      store.objects.set('k', 'was here');
      store.failNext.put = s3Error('PreconditionFailed', 412);
      store.objects.delete('k');
      const stored = expectOk(
        await adapter.set('k', 'again', {
          signal,
          ifRevision: etagOf('was here'),
        })
      );
      assert.equal(stored.value, 'again');
      assert.equal(store.objects.get('k'), 'again');
    });

    void it('treats a 409 conditional-request conflict as a conflict', async () => {
      const store = fakeObjectStore();
      const adapter = s3Adapter({ store, verifyConditionalWrites: false });
      store.objects.set('k', 'held');
      store.failNext.put = s3Error('ConditionalRequestConflict', 409);
      expectFailure(
        await adapter.set('k', 'v', { signal, ifRevision: etagOf('held') }),
        'conflict',
        'k'
      );
    });
  });

  void describe('keys', () => {
    void it('refuses a key the store would refuse or misread, naming the key', async () => {
      const store = fakeObjectStore();
      const adapter = s3Adapter({ store });
      const bad: [string, RegExp][] = [
        ['', /key is empty/],
        ['.', /"\." or "\.\."/],
        ['..', /"\." or "\.\."/],
        ['a/../b', /"\." or "\.\."/],
        ['a/./b', /"\." or "\.\."/],
        ['k'.repeat(1025), /longer than 1024 bytes/],
        ['\u{1F600}'.repeat(257), /longer than 1024 bytes/],
      ];
      for (const [key, pattern] of bad) {
        const message = expectFailure(
          await adapter.set(key, 'v', { signal }),
          'invalid',
          key
        );
        assert.match(message, pattern, key);
        expectFailure(await adapter.get(key, { signal }), 'invalid', key);
      }
      assert.deepEqual(store.calls, []);
    });

    void it('counts the prefix towards the length', async () => {
      const adapter = s3Adapter({
        store: fakeObjectStore(),
        prefix: 'p'.repeat(1000),
      });
      expectOk(await adapter.set('k'.repeat(24), 'v', { signal }));
      expectFailure(
        await adapter.set('k'.repeat(25), 'v', { signal }),
        'invalid',
        'k'.repeat(25)
      );
    });

    void it('accepts keys with slashes, spaces, dots inside names and non-ASCII text', async () => {
      const adapter = s3Adapter({ store: fakeObjectStore() });
      for (const key of [
        'a/b',
        'a b',
        '..a',
        'a..b',
        '.hidden',
        'café/日本',
        'x/',
      ]) {
        expectOk(await adapter.set(key, `v ${key}`, { signal }));
        assert.equal(
          expectOk(await adapter.get(key, { signal }))?.value,
          `v ${key}`,
          key
        );
      }
    });
  });

  void it('does not touch the store for an aborted request', async () => {
    const store = fakeObjectStore();
    const adapter = s3Adapter({ store });
    const aborted = { signal: AbortSignal.abort() };
    expectFailure(await adapter.get('k', aborted), 'unavailable', 'k');
    expectFailure(await adapter.set('k', 'v', aborted), 'unavailable', 'k');
    assert.ok(adapter.remove !== undefined, 'adapter should implement remove');
    expectFailure(await adapter.remove('k', aborted), 'unavailable', 'k');
    assert.deepEqual(store.calls, []);
  });

  void it('maps store errors to error codes, naming the key and the cause', async () => {
    const cases: readonly [Error, string][] = [
      [s3Error('AccessDenied', 403, 'Access Denied'), 'forbidden'],
      [s3Error('InvalidAccessKeyId', 403), 'forbidden'],
      [s3Error('SignatureDoesNotMatch', 403), 'forbidden'],
      [s3Error('ExpiredToken', 400), 'forbidden'],
      [s3Error('Unauthorized', 401), 'forbidden'],
      [s3Error('QuotaExceeded', 507, 'bucket quota exceeded'), 'quota'],
      [s3Error('StorageLimitExceeded', 400), 'quota'],
      [
        s3Error(
          'EntityTooLarge',
          400,
          'Your proposed upload exceeds the maximum'
        ),
        'invalid',
      ],
      [s3Error('KeyTooLongError', 400), 'invalid'],
      [s3Error('InvalidArgument', 400), 'invalid'],
      [
        s3Error('SlowDown', 503, 'Please reduce your request rate'),
        'unavailable',
      ],
      [s3Error('InternalError', 500), 'unavailable'],
      [
        s3Error('NoSuchBucket', 404, 'The specified bucket does not exist'),
        'unavailable',
      ],
      [
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
        'unavailable',
      ],
      [new Error('socket hang up'), 'unavailable'],
    ];
    for (const [error, code] of cases) {
      const store = fakeObjectStore();
      const adapter = s3Adapter({ store });
      store.failNext.put = error;
      const written = expectFailure(
        await adapter.set('k', 'v', { signal }),
        code,
        'k'
      );
      assert.ok(written.includes(error.message), written);
      store.failNext.get = error;
      expectFailure(await adapter.get('k', { signal }), code, 'k');
      store.failNext.delete = error;
      assert.ok(
        adapter.remove !== undefined,
        'adapter should implement remove'
      );
      expectFailure(await adapter.remove('k', { signal }), code, 'k');
    }
  });

  void it('reads a 404 NoSuchKey from the store as a missing key, and removing one as done', async () => {
    const store = fakeObjectStore();
    const adapter = s3Adapter({ store });
    store.failNext.get = s3Error('NoSuchKey', 404);
    assert.deepEqual(await adapter.get('k', { signal }), {
      ok: true,
      value: null,
    });
    store.failNext.delete = s3Error('NoSuchKey', 404);
    assert.ok(adapter.remove !== undefined, 'adapter should implement remove');
    assert.deepEqual(await adapter.remove('k', { signal }), {
      ok: true,
      value: null,
    });
  });

  void it('calls an object that is not text with an ETag corrupt', async () => {
    const store = fakeObjectStore();
    for (const found of [
      { body: 5, etag: '"a"' },
      { body: 'x', etag: 7 },
    ]) {
      store.getObject = () => Promise.resolve(found as never);
      expectFailure(
        await s3Adapter({ store }).get('k', { signal }),
        'corrupt',
        'k'
      );
    }
  });

  void it('reports a write that came back without an ETag instead of inventing a revision', async () => {
    const store = fakeObjectStore();
    store.putObject = () => Promise.resolve({ etag: '' });
    const message = expectFailure(
      await s3Adapter({ store }).set('k', 'v', { signal }),
      'unavailable',
      'k'
    );
    assert.match(message, /no ETag/);
  });

  void it('tells subscribers about writes and removals, but not about a conflict', async () => {
    const store = fakeObjectStore();
    const adapter = s3Adapter({ store });
    const seen: (StoredValue | null)[] = [];
    adapter.subscribe?.('k', (stored) => seen.push(stored));
    adapter.subscribe?.('k', () => {
      throw new Error('listener bug');
    });
    const written = expectOk(await adapter.set('k', 'v', { signal }));
    await adapter.set('k', 'w', { signal, ifRevision: '"stale"' });
    assert.ok(adapter.remove !== undefined, 'adapter should implement remove');
    await adapter.remove('k', { signal });
    assert.deepEqual(seen, [written, null]);
  });
});

/** Stand-ins for the AWS SDK's client and command classes. */
function fakeSdk(
  respond: (input: Record<string, unknown>, kind: string) => unknown
): {
  readonly commands: AwsSdkCommands;
  readonly client: {
    send(
      command: never,
      options?: { abortSignal?: AbortSignal }
    ): Promise<unknown>;
  };
  readonly sent: {
    kind: string;
    input: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }[];
} {
  const sent: {
    kind: string;
    input: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }[] = [];
  const command = (kind: string): AwsSdkCommands['GetObjectCommand'] =>
    class {
      readonly kind: string = kind;
      constructor(readonly input: Record<string, unknown>) {}
    } as unknown as AwsSdkCommands['GetObjectCommand'];
  return {
    sent,
    commands: {
      GetObjectCommand: command('get'),
      PutObjectCommand: command('put'),
      DeleteObjectCommand: command('delete'),
    },
    client: {
      send: async (cmd, options) => {
        const { kind, input } = cmd as unknown as {
          kind: string;
          input: Record<string, unknown>;
        };
        sent.push({
          kind,
          input,
          ...(options?.abortSignal === undefined
            ? {}
            : { abortSignal: options.abortSignal }),
        });
        return respond(input, kind);
      },
    },
  };
}

void describe('awsSdkObjectStore', () => {
  void it('builds GetObject, PutObject and DeleteObject requests, with the abort signal', async () => {
    const sdk = fakeSdk((_input, kind) =>
      kind === 'get'
        ? {
            ETag: '"e1"',
            Body: { transformToString: () => Promise.resolve('text') },
          }
        : { ETag: '"e2"' }
    );
    const store = awsSdkObjectStore({
      client: sdk.client,
      bucket: 'b',
      commands: sdk.commands,
    });
    assert.deepEqual(await store.getObject('k', { signal }), {
      body: 'text',
      etag: '"e1"',
    });
    assert.deepEqual(
      await store.putObject('k', 'v', { signal, ifMatch: '"m"' }),
      { etag: '"e2"' }
    );
    await store.putObject('k2', 'v', { signal, ifNoneMatch: '*' });
    await store.deleteObject('k', { signal });
    assert.deepEqual(
      sdk.sent.map(({ kind, input }) => ({ kind, input })),
      [
        { kind: 'get', input: { Bucket: 'b', Key: 'k' } },
        {
          kind: 'put',
          input: {
            Bucket: 'b',
            Key: 'k',
            Body: 'v',
            ContentLength: 1,
            ContentType: 'text/plain; charset=utf-8',
            IfMatch: '"m"',
          },
        },
        {
          kind: 'put',
          input: {
            Bucket: 'b',
            Key: 'k2',
            Body: 'v',
            ContentLength: 1,
            ContentType: 'text/plain; charset=utf-8',
            IfNoneMatch: '*',
          },
        },
        { kind: 'delete', input: { Bucket: 'b', Key: 'k' } },
      ]
    );
    assert.ok(sdk.sent.every((request) => request.abortSignal === signal));
  });

  void it('uses the content type it is given', async () => {
    const sdk = fakeSdk(() => ({ ETag: '"e"' }));
    await awsSdkObjectStore({
      client: sdk.client,
      bucket: 'b',
      commands: sdk.commands,
      contentType: 'application/json',
    }).putObject('k', '{}', { signal });
    assert.equal(sdk.sent[0]?.input.ContentType, 'application/json');
  });

  void it('resolves null for a missing key and passes other errors on unchanged', async () => {
    const missing = s3Error('NoSuchKey', 404);
    const denied = s3Error('AccessDenied', 403);
    let next: Error = missing;
    const sdk = fakeSdk(() => {
      throw next;
    });
    const store = awsSdkObjectStore({
      client: sdk.client,
      bucket: 'b',
      commands: sdk.commands,
    });
    assert.equal(await store.getObject('k', { signal }), null);
    next = denied;
    await assert.rejects(
      store.getObject('k', { signal }),
      (error) => error === denied
    );
  });

  void it('rejects a response with no readable body or ETag', async () => {
    for (const response of [{}, { ETag: '"e"' }, { Body: {}, ETag: '"e"' }]) {
      const sdk = fakeSdk(() => response);
      const store = awsSdkObjectStore({
        client: sdk.client,
        bucket: 'b',
        commands: sdk.commands,
      });
      await assert.rejects(
        store.getObject('k', { signal }),
        /no readable Body or ETag/
      );
    }
  });

  void it('returns an empty ETag when a write response has none, which the adapter reports', async () => {
    const sdk = fakeSdk(() => ({}));
    const store = awsSdkObjectStore({
      client: sdk.client,
      bucket: 'b',
      commands: sdk.commands,
    });
    assert.deepEqual(await store.putObject('k', 'v', { signal }), { etag: '' });
    expectFailure(
      await s3Adapter({ store }).set('k', 'v', { signal }),
      'unavailable',
      'k'
    );
  });
});

void describe('awsSdkObjectStore with text of any length', () => {
  void it('says how long the text is in UTF-8 bytes, including when it is empty', async () => {
    const sdk = fakeSdk(() => ({ ETag: '"e"' }));
    const store = awsSdkObjectStore({
      client: sdk.client,
      bucket: 'b',
      commands: sdk.commands,
    });
    for (const [body, bytes] of [
      ['', 0],
      ['abc', 3],
      ['café', 5],
      ['\u{1F600}', 4],
    ] as const) {
      await store.putObject('k', body, { signal });
      assert.equal(
        sdk.sent.at(-1)?.input.ContentLength,
        bytes,
        JSON.stringify(body)
      );
    }
  });
});
