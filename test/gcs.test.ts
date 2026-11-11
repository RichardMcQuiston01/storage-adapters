/**
 * The Google Cloud Storage adapter, over in-memory stand-ins for a store and for a bucket of
 * `@google-cloud/storage` (test/support/fake-gcs.ts), so the default test run stays offline.
 * test/gcs-live.test.ts runs the same adapter against a real bucket.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  gcsAdapter,
  gcsObjectStore,
  MAX_VALUE_BYTES,
  type GcsAdapterOptions,
  type GcsStoreLike,
} from '../src/gcs/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import {
  FakeGcsBucket,
  FakeGcsError,
  FakeGcsStore,
} from './support/fake-gcs.js';

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
  assert.ok(result.error.startsWith('Google Cloud Storage '), result.error);
  return result.error;
}

function adapterFor(
  store: GcsStoreLike,
  more: Partial<GcsAdapterOptions> = {}
): StorageAdapter {
  return gcsAdapter({ store, ...more });
}

const removeKey = async (
  adapter: StorageAdapter,
  key: string
): Promise<StoreResult<null>> =>
  (await adapter.remove?.(key, { signal })) ?? { ok: true, value: null };

const listKeys = async (
  adapter: StorageAdapter,
  prefix = ''
): Promise<string[]> =>
  expectOk(
    (await adapter.list?.(prefix, { signal })) ?? { ok: true, value: [] }
  );

runConformance('gcsAdapter on a stand-in store', {
  ownWrites: 'notifies',
  create: () => {
    const store = new FakeGcsStore();
    return { adapter: adapterFor(store), reopen: () => adapterFor(store) };
  },
});

runConformance(
  'gcsAdapter on a stand-in store that answers 404 for a missing object',
  {
    ownWrites: 'notifies',
    create: () => {
      const store = new FakeGcsStore({ missingIsNotFound: true });
      return { adapter: adapterFor(store), reopen: () => adapterFor(store) };
    },
  }
);

runConformance('gcsAdapter through gcsObjectStore on a stand-in bucket', {
  ownWrites: 'notifies',
  create: () => {
    const bucket = new FakeGcsBucket();
    const make = (): StorageAdapter =>
      adapterFor(gcsObjectStore({ bucket }), { prefix: 'settings/' });
    return { adapter: make(), reopen: make };
  },
});

void describe('gcsAdapter', () => {
  void it('uses the object generation as the revision', async () => {
    const store = new FakeGcsStore();
    const adapter = adapterFor(store);
    const first = expectOk(await adapter.set('k', 'one', { signal }));
    assert.equal(first.revision, store.objects.get('k')?.generation);
    assert.match(first.revision ?? '', /^[0-9]+$/);
    const second = expectOk(await adapter.set('k', 'two', { signal }));
    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(expectOk(await adapter.get('k', { signal })), second);
  });

  void it('checks ifRevision with ifGenerationMatch and refuses a stale revision', async () => {
    const store = new FakeGcsStore();
    const adapter = adapterFor(store);
    const first = expectOk(await adapter.set('k', 'a', { signal }));
    const second = expectOk(
      await adapter.set('k', 'b', {
        signal,
        ifRevision: first.revision as string,
      })
    );
    const put = store.requests.filter((request) => request.operation === 'put');
    assert.equal(put[1]?.ifGenerationMatch, first.revision);
    assert.match(
      expectFailure(
        await adapter.set('k', 'c', {
          signal,
          ifRevision: first.revision as string,
        }),
        'conflict',
        'k'
      ),
      new RegExp(
        `holds revision ${second.revision as string}, but revision ${first.revision as string} was expected`
      )
    );
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'b');
  });

  void it('lets only one of many writers holding the same revision win, across adapters', async () => {
    const store = new FakeGcsStore();
    const first = expectOk(
      await adapterFor(store).set('k', 'start', { signal })
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        adapterFor(store).set('k', `writer ${String(index)}`, {
          signal,
          ifRevision: first.revision as string,
        })
      )
    );
    assert.equal(results.filter((result) => result.ok).length, 1);
    for (const result of results.filter((entry) => !entry.ok)) {
      assert.equal(result.ok ? '' : result.code, 'conflict');
    }
  });

  void it('creates a key that has nothing stored, with ifGenerationMatch 0', async () => {
    for (const missingIsNotFound of [false, true]) {
      const store = new FakeGcsStore({ missingIsNotFound });
      const adapter = adapterFor(store);
      expectOk(
        await adapter.set('new', 'v', {
          signal,
          ifRevision: '1731200000000999',
        })
      );
      const matches = store.requests
        .filter((request) => request.operation === 'put')
        .map((request) => request.ifGenerationMatch);
      assert.deepEqual(matches, ['1731200000000999', '0']);
    }
  });

  void it('treats a revision that is not a generation as a conflict, or creates the key', async () => {
    const store = new FakeGcsStore();
    const adapter = adapterFor(store);
    expectOk(await adapter.set('there', 'v', { signal }));
    for (const bad of ['', 'abc', '0', '-5', '1.5', '9'.repeat(25)]) {
      expectFailure(
        await adapter.set('there', 'w', { signal, ifRevision: bad }),
        'conflict',
        'there'
      );
    }
    assert.equal(expectOk(await adapter.get('there', { signal }))?.value, 'v');
    const sent: (string | undefined)[] = store.requests
      .filter((request) => request.operation === 'put')
      .map((request) => request.ifGenerationMatch);
    assert.deepEqual(
      sent,
      [undefined],
      'only the first write was sent: a revision that is not a generation never reaches the store'
    );
    expectOk(
      await adapter.set('absent', 'made', { signal, ifRevision: 'abc' })
    );
    assert.equal(
      expectOk(await adapter.get('absent', { signal }))?.value,
      'made'
    );
  });

  void it('gives conflict to the loser when two writers create the same key at once', async () => {
    const store = new FakeGcsStore();
    const adapter = adapterFor(store);
    let played = false;
    store.before = (request) => {
      // Another process creates the key just before this adapter's create-only write.
      if (
        request.operation === 'put' &&
        request.ifGenerationMatch === '0' &&
        !played
      ) {
        played = true;
        store.write('k', 'theirs');
      }
    };
    assert.match(
      expectFailure(
        await adapter.set('k', 'mine', {
          signal,
          ifRevision: '1731200000000001',
        }),
        'conflict',
        'k'
      ),
      /changed while it was being written, so revision 1731200000000001 no longer applies/
    );
    store.before = null;
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'theirs');
  });

  void it('removes a key, and removing one that is not there is fine', async () => {
    const store = new FakeGcsStore();
    const adapter = adapterFor(store);
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    assert.equal(store.objects.size, 0);
    assert.deepEqual(expectOk(await removeKey(adapter, 'k')), null);
    store.failures.push(new FakeGcsError('No such object', 404));
    assert.deepEqual(expectOk(await removeKey(adapter, 'k')), null);
  });

  void it('puts the prefix in front of every key and takes it off again in list', async () => {
    const store = new FakeGcsStore();
    const adapter = adapterFor(store, { prefix: 'app/' });
    expectOk(await adapter.set('b', '1', { signal }));
    expectOk(await adapter.set('a', '2', { signal }));
    store.write('other/c', '3');
    store.write('app', 'not under the prefix');
    assert.deepEqual([...store.objects.keys()].sort(), [
      'app',
      'app/a',
      'app/b',
      'other/c',
    ]);
    assert.deepEqual(await listKeys(adapter), ['a', 'b']);
    assert.deepEqual(await listKeys(adapter, 'b'), ['b']);
    assert.equal(expectOk(await adapter.get('a', { signal }))?.value, '2');
  });

  void it('refuses a key the store would refuse, naming the key', async () => {
    const store = new FakeGcsStore();
    const adapter = adapterFor(store);
    for (const key of [
      '',
      'a\nb',
      'a\rb',
      '.',
      '..',
      '.well-known/acme-challenge/x',
      'k'.repeat(1025),
      '日'.repeat(342),
      'bad\ud800',
    ]) {
      const error: string = expectFailure(
        await adapter.set(key, 'v', { signal }),
        'invalid',
        key
      );
      assert.match(error, /cannot use this key/);
    }
    assert.equal(store.requests.length, 0);
    expectOk(await adapter.set('k'.repeat(1024), 'v', { signal }));
    expectOk(await adapter.set('a/./b', 'v', { signal }));
    expectOk(await adapter.set('.hidden', 'v', { signal }));
  });

  void it('applies the key rules to the prefix and key together', async () => {
    const adapter = adapterFor(new FakeGcsStore(), {
      prefix: '.well-known/acme-challenge/',
    });
    expectFailure(await adapter.set('x', 'v', { signal }), 'invalid', 'x');
  });

  void it('refuses a value that is not text or is too large', async () => {
    const store = new FakeGcsStore();
    const adapter = adapterFor(store);
    expectFailure(
      await adapter.set('k', 'bad\udc00', { signal }),
      'invalid',
      'k'
    );
    assert.match(
      expectFailure(
        await adapter.set('big', 'x'.repeat(MAX_VALUE_BYTES + 1), { signal }),
        'invalid',
        'big'
      ),
      /limit is 32000000/
    );
    assert.equal(store.requests.length, 0);
  });

  void it('stores empty, multi-line and unusual values exactly', async () => {
    const adapter = adapterFor(new FakeGcsStore());
    for (const value of [
      '',
      'a\nb\r\nc',
      '日本語 😀',
      `"'\\`,
      '{"json":true}',
    ]) {
      expectOk(await adapter.set('k', value, { signal }));
      assert.equal(expectOk(await adapter.get('k', { signal }))?.value, value);
    }
  });

  void describe('list', () => {
    void it('says so when the store cannot list', async () => {
      const store: GcsStoreLike = {
        getObject: async () => null,
        putObject: async () => ({ generation: '1' }),
        deleteObject: async () => undefined,
      };
      const result = await adapterFor(store).list?.('p', { signal });
      assert.ok(result !== undefined && !result.ok);
      assert.equal(result.code, 'invalid');
      assert.match(result.error, /has no listKeys.*for prefix "p"$/);
    });

    void it('turns a failure into a result naming the prefix', async () => {
      const store = new FakeGcsStore();
      const adapter = adapterFor(store);
      store.failures.push(new Error('boom'));
      const result = await adapter.list?.('p', { signal });
      assert.ok(result !== undefined && !result.ok);
      assert.match(
        result.error,
        /could not list keys \(boom\).*for prefix "p"$/
      );
    });
  });

  void describe('failures', () => {
    void it('explains 401, 403, 404, 429 and a bad request', async () => {
      const store = new FakeGcsStore();
      const adapter = adapterFor(store);
      store.failures.push(new FakeGcsError('Invalid Credentials', 401));
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'forbidden', 'k'),
        /credentials were not accepted/
      );
      store.failures.push(
        new FakeGcsError(
          'user@example.com does not have storage.objects.get access to the Google Cloud Storage object.',
          403
        )
      );
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'forbidden', 'k'),
        /needs the Storage Object Admin role/
      );
      store.failures.push(
        new FakeGcsError('The specified bucket does not exist.', 404)
      );
      // A 404 on a read means "no such object", but a write that cannot find the bucket says so.
      assert.match(
        expectFailure(
          await adapter.set('k', 'v', { signal }),
          'unavailable',
          'k'
        ),
        /bucket was not found/
      );
      store.failures.push(
        new FakeGcsError(
          'The rate of change requests per second for this object name has been exceeded.',
          429
        )
      );
      assert.match(
        expectFailure(
          await adapter.set('k', 'v', { signal }),
          'unavailable',
          'k'
        ),
        /about one write a second to a single object name/
      );
      store.failures.push(new FakeGcsError('Invalid object name', 400));
      expectFailure(await adapter.set('k', 'v', { signal }), 'invalid', 'k');
    });

    void it('turns a network error into a result', async () => {
      const store = new FakeGcsStore();
      const adapter = adapterFor(store);
      store.failures.push(
        new Error('getaddrinfo ENOTFOUND storage.googleapis.com')
      );
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k'),
        /could not be read \(could not be reached: getaddrinfo ENOTFOUND/
      );
    });

    void it('names the store with the name option', async () => {
      const store = new FakeGcsStore();
      const adapter = adapterFor(store, { name: 'Fake GCS' });
      store.failures.push(new Error('boom'));
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.ok(
        result.error.startsWith('Fake GCS could not be read'),
        result.error
      );
    });

    void it('does not send a request when the signal is already aborted, and stops waiting when it aborts', async () => {
      const store = new FakeGcsStore();
      const adapter = adapterFor(store);
      const aborted = new AbortController();
      aborted.abort();
      assert.match(
        expectFailure(
          await adapter.get('k', { signal: aborted.signal }),
          'unavailable',
          'k'
        ),
        /request was aborted/
      );
      assert.equal(store.requests.length, 0);
      const midway = new AbortController();
      store.before = async () => {
        midway.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
      };
      assert.match(
        expectFailure(
          await adapter.set('k', 'v', { signal: midway.signal }),
          'unavailable',
          'k'
        ),
        /request was aborted/
      );
    });

    void it('reports an object that is not text with a generation as corrupt', async () => {
      const store: GcsStoreLike = {
        getObject: async () => ({ body: 'v', generation: '' }),
        putObject: async () => ({ generation: '1' }),
        deleteObject: async () => undefined,
      };
      expectFailure(
        await adapterFor(store).get('k', { signal }),
        'corrupt',
        'k'
      );
    });

    void it('says so when a write answers with no generation', async () => {
      const store: GcsStoreLike = {
        getObject: async () => null,
        putObject: async () => ({ generation: '' }),
        deleteObject: async () => undefined,
      };
      assert.match(
        expectFailure(
          await adapterFor(store).set('k', 'v', { signal }),
          'unavailable',
          'k'
        ),
        /did not say which generation/
      );
    });
  });

  void describe('subscribe', () => {
    void it('reports its own writes and removals once', async () => {
      const adapter = adapterFor(new FakeGcsStore());
      const seen: (StoredValue | null)[] = [];
      const stop = adapter.subscribe?.('k', (stored) => seen.push(stored));
      const one = expectOk(await adapter.set('k', 'v', { signal }));
      const two = expectOk(await adapter.set('k', 'w', { signal }));
      expectOk(await removeKey(adapter, 'k'));
      stop?.();
      assert.deepEqual(seen, [one, two, null]);
    });
  });
});

void describe('gcsObjectStore', () => {
  void it('reads the generation first, then downloads exactly that generation', async () => {
    const bucket = new FakeGcsBucket();
    const generation: string = bucket.put('k', 'hello');
    const read = await gcsObjectStore({ bucket }).getObject('k', { signal });
    assert.deepEqual(read, { body: 'hello', generation });
    assert.deepEqual(
      bucket.requests.map((request) => request.operation),
      ['getMetadata', 'download']
    );
    assert.deepEqual(
      (bucket.requests[1]?.options as { generation?: number }).generation,
      Number(generation)
    );
  });

  void it('starts again when the object is replaced between the two requests', async () => {
    const bucket = new FakeGcsBucket();
    bucket.put('k', 'old');
    let replaced = false;
    bucket.before = (request) => {
      if (request.operation === 'download' && !replaced) {
        replaced = true;
        bucket.put('k', 'new');
      }
    };
    const read = await gcsObjectStore({ bucket }).getObject('k', { signal });
    assert.equal(read?.body, 'new');
    assert.equal(read?.generation, bucket.objects.get('k')?.generation);
  });

  void it('gives up when the object keeps changing', async () => {
    const bucket = new FakeGcsBucket();
    bucket.put('k', 'v');
    bucket.before = (request) => {
      if (request.operation === 'download') {
        bucket.put('k', 'again');
      }
    };
    await assert.rejects(
      gcsObjectStore({ bucket }).getObject('k', { signal }),
      /kept changing while it was being read/
    );
  });

  void it('resolves null for an object that does not exist', async () => {
    const bucket = new FakeGcsBucket();
    assert.equal(
      await gcsObjectStore({ bucket }).getObject('nope', { signal }),
      null
    );
  });

  void it('rejects bytes that are not UTF-8, which the adapter reports as corrupt', async () => {
    const bucket = new FakeGcsBucket();
    bucket.put('k', new Uint8Array([0xff, 0xfe, 0x41]));
    const adapter = adapterFor(gcsObjectStore({ bucket }));
    assert.match(
      expectFailure(await adapter.get('k', { signal }), 'corrupt', 'k'),
      /not valid UTF-8/
    );
  });

  void it('rejects when the object has no generation to use as a revision', async () => {
    const bucket = new FakeGcsBucket();
    bucket.put('k', 'v');
    bucket.hideGenerationInMetadata = true;
    await assert.rejects(
      gcsObjectStore({ bucket }).getObject('k', { signal }),
      /did not say the object's generation/
    );
  });

  void it('sends a simple text upload and returns the generation from the answer', async () => {
    const bucket = new FakeGcsBucket();
    const store = gcsObjectStore({ bucket });
    const first = await store.putObject('k', 'one', { signal });
    assert.equal(first.generation, bucket.objects.get('k')?.generation);
    const save = bucket.requests.find(
      (request) => request.operation === 'save'
    );
    assert.deepEqual(save?.options, {
      resumable: false,
      contentType: 'text/plain; charset=utf-8',
    });
    await store.putObject('k', 'two', {
      signal,
      ifGenerationMatch: first.generation,
    });
    const conditional = bucket.requests.filter(
      (request) => request.operation === 'save'
    )[1];
    assert.deepEqual(
      (conditional?.options as { preconditionOpts?: unknown }).preconditionOpts,
      { ifGenerationMatch: first.generation },
      'the generation travels as text, so it keeps every digit'
    );
  });

  void it('returns an empty generation when the client did not fill in the metadata', async () => {
    const bucket = new FakeGcsBucket();
    bucket.hideMetadataAfterSave = true;
    const result = await gcsObjectStore({ bucket }).putObject('k', 'v', {
      signal,
    });
    assert.equal(result.generation, '');
  });

  void it('lets a failed precondition from the client through unchanged', async () => {
    const bucket = new FakeGcsBucket();
    bucket.put('k', 'v');
    await assert.rejects(
      gcsObjectStore({ bucket }).putObject('k', 'w', {
        signal,
        ifGenerationMatch: '0',
      }),
      (error: unknown) => (error as { code?: number }).code === 412
    );
  });

  void it('deletes without failing for a missing object, and lists by prefix', async () => {
    const bucket = new FakeGcsBucket();
    bucket.put('a/1', 'x');
    bucket.put('a/2', 'x');
    bucket.put('b/1', 'x');
    const store = gcsObjectStore({ bucket });
    await store.deleteObject('nope', { signal });
    assert.deepEqual(
      bucket.requests.find((request) => request.operation === 'delete')
        ?.options,
      { ignoreNotFound: true }
    );
    assert.deepEqual(await store.listKeys?.('a/', { signal }), ['a/1', 'a/2']);
    await store.deleteObject('a/1', { signal });
    assert.deepEqual(await store.listKeys?.('a/', { signal }), ['a/2']);
  });
});
