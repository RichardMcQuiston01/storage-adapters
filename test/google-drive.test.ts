/**
 * The Google Drive adapter, over an in-memory stand-in for the Drive files API
 * (test/support/fake-google-drive.ts), so the default test run stays offline.
 * test/google-drive-live.test.ts runs the same adapter against a real Drive folder.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  googleDriveAdapter,
  MAX_VALUE_BYTES,
  type DriveListParamsLike,
  type GoogleDriveAdapterOptions,
} from '../src/google-drive/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeDrive, FakeDriveError } from './support/fake-google-drive.js';

const signal: AbortSignal = new AbortController().signal;
const FOLDER = 'folder-1';

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
  assert.ok(result.error.startsWith('Google Drive '), result.error);
  return result.error;
}

function adapterFor(
  drive: FakeDrive,
  more: Partial<GoogleDriveAdapterOptions> = {}
): StorageAdapter {
  return googleDriveAdapter({
    client: drive.client,
    folderId: FOLDER,
    ...more,
  });
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

runConformance('googleDriveAdapter on a stand-in Drive', {
  ownWrites: 'notifies',
  create: () => {
    const drive = new FakeDrive();
    return {
      adapter: adapterFor(drive),
      reopen: () => adapterFor(drive),
    };
  },
});

runConformance('googleDriveAdapter on a stand-in Drive with loose names', {
  ownWrites: 'notifies',
  create: () => {
    const drive = new FakeDrive({ caseInsensitiveNames: true });
    return {
      adapter: adapterFor(drive),
      reopen: () => adapterFor(drive),
    };
  },
});

void describe('googleDriveAdapter', () => {
  void it('keeps one text file per key, with the revision in its properties', async () => {
    const drive = new FakeDrive();
    const adapter = adapterFor(drive);
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), null);
    assert.equal(drive.files.size, 0, 'a read makes nothing');
    assert.deepEqual(expectOk(await adapter.set('a', 'one', { signal })), {
      value: 'one',
      revision: '1',
    });
    const file = drive.named('a')[0];
    assert.ok(file !== undefined);
    assert.equal(file.content, 'one');
    assert.deepEqual(file.parents, [FOLDER]);
    assert.deepEqual(file.appProperties, { revision: '1' });
    assert.deepEqual(expectOk(await adapter.set('a', 'uno', { signal })), {
      value: 'uno',
      revision: '2',
    });
    assert.equal(drive.named('a').length, 1, 'an update reuses the file');
    assert.equal(drive.named('a')[0]?.content, 'uno');
    assert.equal(drive.named('a')[0]?.appProperties.revision, '2');
  });

  void it('sends the content as text with the entry MIME type', async () => {
    const drive = new FakeDrive();
    const adapter = adapterFor(drive);
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await adapter.set('k', 'w', { signal }));
    const create = drive.requests.find(
      (request) => request.operation === 'create'
    );
    const update = drive.requests.find(
      (request) => request.operation === 'update'
    );
    assert.equal(
      (create?.params as { media: { mimeType: string } }).media.mimeType,
      'text/plain'
    );
    assert.equal(
      (update?.params as { media: { mimeType: string } }).media.mimeType,
      'text/plain'
    );
    expectOk(await adapter.get('k', { signal }));
    const read = drive.requests.filter(
      (request) =>
        request.operation === 'get' &&
        (request.params as { alt?: string }).alt === 'media'
    );
    assert.ok(read.length > 0);
    assert.equal(read[0]?.options?.responseType, 'text');
  });

  void it('stores empty, multi-line and unusual values and keys exactly', async () => {
    const adapter = adapterFor(new FakeDrive());
    const keys: string[] = [
      "it's",
      'two words',
      'tab\there',
      'back\\slash',
      '日本語',
      '😀',
      'a/b',
    ];
    for (const key of keys) {
      expectOk(await adapter.set(key, `value of ${key}`, { signal }));
    }
    expectOk(await adapter.set('empty', '', { signal }));
    expectOk(await adapter.set('lines', 'a\nb\r\nc', { signal }));
    expectOk(await adapter.set('quotes', `"'\\`, { signal }));
    for (const key of keys) {
      assert.equal(
        expectOk(await adapter.get(key, { signal }))?.value,
        `value of ${key}`
      );
    }
    assert.equal(expectOk(await adapter.get('empty', { signal }))?.value, '');
    assert.equal(
      expectOk(await adapter.get('lines', { signal }))?.value,
      'a\nb\r\nc'
    );
    assert.equal(
      expectOk(await adapter.get('quotes', { signal }))?.value,
      `"'\\`
    );
  });

  void it('escapes quotes and backslashes in the search for a key', async () => {
    const drive = new FakeDrive();
    const adapter = adapterFor(drive);
    expectOk(await adapter.set("o'brien\\x", 'v', { signal }));
    const searches = drive.requests
      .filter((request) => request.operation === 'list')
      .map((request) => (request.params as DriveListParamsLike).q);
    assert.ok(searches.length > 0);
    assert.ok(
      searches.every((query) =>
        query.startsWith(
          String.raw`name = 'o\'brien\\x' and 'folder-1' in parents`
        )
      ),
      searches.join(' | ')
    );
  });

  void it('refuses what a file cannot be named or hold, naming the key', async () => {
    const drive = new FakeDrive();
    const adapter = adapterFor(drive);
    expectFailure(await adapter.set('', 'v', { signal }), 'invalid', '');
    expectFailure(
      await adapter.set('k'.repeat(256), 'v', { signal }),
      'invalid',
      'k'.repeat(256)
    );
    expectFailure(
      await adapter.set(' padded', 'v', { signal }),
      'invalid',
      ' padded'
    );
    expectFailure(
      await adapter.set('padded ', 'v', { signal }),
      'invalid',
      'padded '
    );
    expectFailure(
      await adapter.set('bad\ud800', 'v', { signal }),
      'invalid',
      'bad\ud800'
    );
    expectFailure(
      await adapter.set('ok', 'bad\udc00', { signal }),
      'invalid',
      'ok'
    );
    assert.match(
      expectFailure(
        await adapter.set('big', 'x'.repeat(MAX_VALUE_BYTES + 1), { signal }),
        'invalid',
        'big'
      ),
      /limit is 5000000/
    );
    assert.equal(drive.files.size, 0);
    expectOk(await adapter.set('k'.repeat(255), 'v', { signal }));
  });

  void describe('revisions', () => {
    void it('counts up and checks ifRevision', async () => {
      const adapter = adapterFor(new FakeDrive());
      assert.equal(
        expectOk(await adapter.set('k', 'a', { signal })).revision,
        '1'
      );
      assert.equal(
        expectOk(await adapter.set('k', 'b', { signal, ifRevision: '1' }))
          .revision,
        '2'
      );
      assert.match(
        expectFailure(
          await adapter.set('k', 'c', { signal, ifRevision: '1' }),
          'conflict',
          'k'
        ),
        /holds revision 2, but revision 1 was expected/
      );
      assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'b');
    });

    void it('creates a key that has nothing stored when ifRevision is given', async () => {
      const adapter = adapterFor(new FakeDrive());
      assert.equal(
        expectOk(await adapter.set('new', 'v', { signal, ifRevision: '7' }))
          .revision,
        '1'
      );
    });

    void it('deletes the file on remove and starts again at 1', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      expectOk(await adapter.set('k', 'v', { signal }));
      expectOk(await adapter.set('k', 'w', { signal }));
      expectOk(await removeKey(adapter, 'k'));
      assert.equal(drive.files.size, 0);
      assert.equal(expectOk(await adapter.get('k', { signal })), null);
      assert.equal(
        expectOk(await adapter.set('k', 'again', { signal })).revision,
        '1'
      );
    });

    void it('removing a key that is not there deletes nothing', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      assert.deepEqual(expectOk(await removeKey(adapter, 'nope')), null);
      assert.ok(
        drive.requests.every((request) => request.operation === 'list')
      );
    });

    void it('lets a read wait for a write to the same key made through the same adapter', async () => {
      const adapter = adapterFor(new FakeDrive());
      const [written, read] = await Promise.all([
        adapter.set('k', 'v', { signal }),
        adapter.get('k', { signal }),
      ]);
      assert.deepEqual(expectOk(written), { value: 'v', revision: '1' });
      assert.deepEqual(
        expectOk(read),
        { value: 'v', revision: '1' },
        'the read ran after the write'
      );
    });

    void it('queues work on one key made through the same adapter', async () => {
      const adapter = adapterFor(new FakeDrive());
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => adapter.set('k', String(n), { signal }))
      );
      assert.deepEqual(
        results.map((result) => expectOk(result).revision),
        ['1', '2', '3', '4', '5']
      );
    });
  });

  void describe('finding a key again', () => {
    void it('searches by name once, then goes straight to the file', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      expectOk(await adapter.set('k', 'v', { signal }));
      const searches = (): number =>
        drive.requests.filter((request) => request.operation === 'list').length;
      const before: number = searches();
      expectOk(await adapter.get('k', { signal }));
      expectOk(await adapter.set('k', 'w', { signal }));
      expectOk(await adapter.get('k', { signal }));
      assert.equal(searches(), before, 'no further searches');
    });

    void it('searches again when the file was deleted by hand', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      expectOk(await adapter.set('k', 'v', { signal }));
      drive.files.clear();
      assert.equal(expectOk(await adapter.get('k', { signal })), null);
      assert.equal(
        expectOk(await adapter.set('k', 'back', { signal })).revision,
        '1'
      );
      assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'back');
    });

    void it('finds a file another process made, by name', async () => {
      const drive = new FakeDrive();
      drive.add('shared', 'from elsewhere', { revision: '4' });
      const adapter = adapterFor(drive);
      assert.deepEqual(expectOk(await adapter.get('shared', { signal })), {
        value: 'from elsewhere',
        revision: '4',
      });
      assert.equal(
        expectOk(
          await adapter.set('shared', 'mine', { signal, ifRevision: '4' })
        ).revision,
        '5'
      );
    });

    void it('keeps only exact name matches when the search is loose', async () => {
      const drive = new FakeDrive({ caseInsensitiveNames: true });
      const adapter = adapterFor(drive);
      expectOk(await adapter.set('Key', 'upper', { signal }));
      expectOk(await adapter.set('key', 'lower', { signal }));
      assert.equal(drive.files.size, 2, 'two keys that differ only by case');
      const fresh = adapterFor(drive);
      assert.equal(
        expectOk(await fresh.get('Key', { signal }))?.value,
        'upper'
      );
      assert.equal(
        expectOk(await fresh.get('key', { signal }))?.value,
        'lower'
      );
    });

    void it('uses the oldest file when two have the same name', async () => {
      const drive = new FakeDrive();
      drive.add('dup', 'first', { revision: '1' });
      drive.add('dup', 'second', { revision: '9' });
      const adapter = adapterFor(drive);
      assert.deepEqual(expectOk(await adapter.get('dup', { signal })), {
        value: 'first',
        revision: '1',
      });
      expectOk(await adapter.set('dup', 'changed', { signal }));
      assert.equal(drive.named('dup')[0]?.content, 'changed');
      assert.equal(drive.named('dup')[1]?.content, 'second');
    });

    void it('reports a file with no whole-number revision as corrupt and leaves it', async () => {
      const drive = new FakeDrive();
      drive.add('bad', 'v', {});
      drive.add('bad2', 'v', { revision: 'abc' });
      const adapter = adapterFor(drive);
      assert.match(
        expectFailure(await adapter.get('bad', { signal }), 'corrupt', 'bad'),
        /revision property is missing or not a whole number/
      );
      expectFailure(
        await adapter.set('bad2', 'x', { signal }),
        'corrupt',
        'bad2'
      );
      assert.equal(drive.named('bad2')[0]?.content, 'v');
    });

    void it('does not notice a value edited by hand, but reads the new text', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      expectOk(await adapter.set('k', 'v', { signal }));
      drive.setContent(drive.named('k')[0]?.id ?? '', 'edited');
      assert.deepEqual(expectOk(await adapter.get('k', { signal })), {
        value: 'edited',
        revision: '1',
      });
    });
  });

  void describe('creating a key at the same moment as another writer', () => {
    void it('lets the older file win and deletes the other', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      let played = false;
      drive.before = (request) => {
        // Another process creates the same key just before this adapter's create.
        if (request.operation === 'create' && !played) {
          played = true;
          drive.add('k', 'theirs', { revision: '1' });
        }
      };
      assert.match(
        expectFailure(
          await adapter.set('k', 'mine', { signal }),
          'conflict',
          'k'
        ),
        /another writer at the same moment/
      );
      drive.before = null;
      assert.equal(drive.named('k').length, 1);
      assert.equal(
        expectOk(await adapter.get('k', { signal }))?.value,
        'theirs'
      );
    });

    void it('keeps its own file when it is the oldest', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      drive.before = (request) => {
        // Another process creates the same key after this adapter's create.
        if (request.operation === 'list' && drive.named('k').length === 1) {
          drive.add('k', 'theirs', { revision: '1' });
        }
      };
      expectOk(await adapter.set('k', 'mine', { signal }));
      drive.before = null;
      assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'mine');
    });

    void it('still succeeds when a listing does not show the new file yet', async () => {
      const drive = new FakeDrive({ listLag: 2 });
      const adapter = adapterFor(drive);
      assert.equal(
        expectOk(await adapter.set('k', 'v', { signal })).revision,
        '1'
      );
      assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'v');
    });
  });

  void describe('failures', () => {
    void it('explains a folder that does not exist', async () => {
      const adapter = googleDriveAdapter({
        client: new FakeDrive().client,
        folderId: 'no-such-folder',
      });
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k'),
        /check folderId.*shared with the account/
      );
      const listed = await adapter.list?.('p', { signal });
      assert.ok(listed !== undefined && !listed.ok);
      assert.match(listed.error, /for prefix "p"$/);
    });

    void it('explains 403, 401, 429 and a missing scope', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      drive.failures.push(
        new FakeDriveError('The caller does not have permission', 403)
      );
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'forbidden', 'k'),
        /share the folder with it as an Editor/
      );
      drive.failures.push(new FakeDriveError('Invalid Credentials', 401));
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'forbidden', 'k'),
        /credentials were not accepted/
      );
      drive.failures.push(new FakeDriveError('User rate limit exceeded', 429));
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k'),
        /rate limiting/
      );
      drive.failures.push(new FakeDriveError('Rate Limit Exceeded', 403));
      expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k');
      drive.failures.push(
        new FakeDriveError(
          'Request had insufficient authentication scopes.',
          403
        )
      );
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'forbidden', 'k'),
        /auth\/drive/
      );
    });

    void it('says plainly when the Drive API is not enabled', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      drive.failures.push(
        new FakeDriveError(
          'Google Drive API has not been used in project 424242 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=424242 then retry.',
          403
        )
      );
      const error: string = expectFailure(
        await adapter.get('k', { signal }),
        'forbidden',
        'k'
      );
      assert.match(
        error,
        /Drive API is not enabled for Google Cloud project 424242.*click Enable/
      );
      assert.ok(
        !/Editor/.test(error),
        'the sharing hint is for permission errors'
      );
    });

    void it('reports a full or missing storage quota as quota and says what to do', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      drive.failures.push(
        new FakeDriveError('Service Accounts do not have storage quota.', 403)
      );
      assert.match(
        expectFailure(await adapter.set('k', 'v', { signal }), 'quota', 'k'),
        /service account has no Drive storage of its own.*sharedDrive: true/
      );
    });

    void it('turns a network error into a result', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      drive.failures.push(
        new Error('getaddrinfo ENOTFOUND www.googleapis.com')
      );
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k'),
        /could not be reached \(getaddrinfo ENOTFOUND/
      );
    });

    void it('says which step of a write failed', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      drive.failures.push(new Error('boom'));
      assert.match(
        expectFailure(
          await adapter.set('k', 'v', { signal }),
          'unavailable',
          'k'
        ),
        /could not be read before writing/
      );
      drive.before = (request) => {
        if (request.operation === 'create') {
          drive.failures.push(new Error('boom'));
        }
      };
      assert.match(
        expectFailure(
          await adapter.set('k', 'v', { signal }),
          'unavailable',
          'k'
        ),
        /could not be written/
      );
    });

    void it('does not send a request when the signal is already aborted, and stops waiting when it aborts', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
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
      assert.equal(drive.requests.length, 0);
      const midway = new AbortController();
      drive.before = async () => {
        midway.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
      };
      expectFailure(
        await adapter.get('k', { signal: midway.signal }),
        'unavailable',
        'k'
      );
    });

    void it('passes the abort signal to the client', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      const controller = new AbortController();
      expectOk(await adapter.get('k', { signal: controller.signal }));
      assert.equal(drive.requests[0]?.options?.signal, controller.signal);
    });

    void it('refuses to run with an empty folder ID', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive, { folderId: '  ' });
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'invalid', 'k'),
        /folderId is empty/
      );
      const listed = await adapter.list?.('', { signal });
      assert.ok(
        listed !== undefined && !listed.ok && listed.code === 'invalid'
      );
      assert.equal(drive.requests.length, 0);
    });
  });

  void describe('list', () => {
    void it('lists keys with the prefix, sorted, once each, and reads only names', async () => {
      const drive = new FakeDrive();
      const adapter = adapterFor(drive);
      for (const key of ['b/2', 'a/1', 'b/1', 'c']) {
        expectOk(await adapter.set(key, 'v', { signal }));
      }
      drive.add('other-folder-file', 'x', { revision: '1' }, 'folder-1');
      assert.deepEqual(await listKeys(adapter, 'b/'), ['b/1', 'b/2']);
      assert.deepEqual(await listKeys(adapter), [
        'a/1',
        'b/1',
        'b/2',
        'c',
        'other-folder-file',
      ]);
      const lists = drive.requests.filter(
        (request) => request.operation === 'list'
      );
      assert.ok(
        lists.some(
          (request) =>
            (request.params as DriveListParamsLike).fields ===
            'nextPageToken,files(name)'
        )
      );
    });

    void it('follows every page of a long listing', async () => {
      const drive = new FakeDrive({ pageSize: 2 });
      const adapter = adapterFor(drive);
      for (let index = 0; index < 7; index += 1) {
        drive.add(`key-${String(index)}`, 'v');
      }
      assert.equal((await listKeys(adapter)).length, 7);
      assert.equal(
        drive.requests.filter((request) => request.operation === 'list').length,
        4
      );
    });
  });

  void describe('subscribe', () => {
    void it('reports its own writes and removals once', async () => {
      const adapter = adapterFor(new FakeDrive());
      const seen: (StoredValue | null)[] = [];
      const stop = adapter.subscribe?.('k', (stored) => seen.push(stored));
      expectOk(await adapter.set('k', 'v', { signal }));
      expectOk(await adapter.set('k', 'w', { signal }));
      expectOk(await removeKey(adapter, 'k'));
      stop?.();
      assert.deepEqual(seen, [
        { value: 'v', revision: '1' },
        { value: 'w', revision: '2' },
        null,
      ]);
    });

    void it('hears changes made by someone else only when it polls', async () => {
      const drive = new FakeDrive();
      const quiet = adapterFor(drive);
      const polling = adapterFor(drive, { pollIntervalMs: 50 });
      const heardQuiet: (StoredValue | null)[] = [];
      const heardPolling: (StoredValue | null)[] = [];
      const stopQuiet = quiet.subscribe?.('k', (stored) =>
        heardQuiet.push(stored)
      );
      const stopPolling = polling.subscribe?.('k', (stored) =>
        heardPolling.push(stored)
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      expectOk(await adapterFor(drive).set('k', 'from elsewhere', { signal }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      stopQuiet?.();
      stopPolling?.();
      assert.deepEqual(heardQuiet, []);
      assert.deepEqual(heardPolling, [
        { value: 'from elsewhere', revision: '1' },
      ]);
    });

    void it('lists the folder once per poll and reads content only for a key that changed', async () => {
      const drive = new FakeDrive();
      drive.add('a', 'one', { revision: '1' });
      drive.add('b', 'two', { revision: '1' });
      const polling = adapterFor(drive, { pollIntervalMs: 50 });
      const stops = ['a', 'b'].map((key) =>
        polling.subscribe?.(key, () => undefined)
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      drive.requests.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const idle = drive.requests.map((request) => request.operation);
      assert.ok(idle.length >= 2);
      assert.ok(
        idle.every((operation) => operation === 'list'),
        idle.join()
      );
      drive.requests.length = 0;
      drive.files.get(drive.named('a')[0]?.id ?? '')!.appProperties.revision =
        '2';
      drive.setContent(drive.named('a')[0]?.id ?? '', 'changed');
      await new Promise((resolve) => setTimeout(resolve, 250));
      for (const stop of stops) {
        stop?.();
      }
      const reads = drive.requests.filter(
        (request) =>
          request.operation === 'get' &&
          (request.params as { alt?: string }).alt === 'media'
      );
      assert.equal(reads.length, 1, 'only the changed key is read');
    });

    void it('calls onPollError once for a run of failed polls', async () => {
      const drive = new FakeDrive();
      const messages: string[] = [];
      const polling = adapterFor(drive, {
        pollIntervalMs: 50,
        onPollError: (message) => messages.push(message),
      });
      const stop = polling.subscribe?.('k', () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 70));
      for (let count = 0; count < 4; count += 1) {
        drive.failures.push(
          new FakeDriveError('User rate limit exceeded', 429)
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      stop?.();
      assert.equal(messages.length, 1);
      assert.match(
        messages[0] ?? '',
        /Google Drive could not poll folder "folder-1" for changes/
      );
    });
  });

  void it('passes the shared-drive flags on every request when sharedDrive is set', async () => {
    const drive = new FakeDrive();
    const adapter = adapterFor(drive, { sharedDrive: true });
    expectOk(await adapter.set('k', 'v', { signal }));
    expectOk(await adapter.set('k', 'w', { signal }));
    expectOk(await adapter.get('k', { signal }));
    expectOk(await removeKey(adapter, 'k'));
    await listKeys(adapter);
    assert.ok(drive.requests.length > 5);
    for (const request of drive.requests) {
      const params = request.params as {
        supportsAllDrives?: boolean;
        includeItemsFromAllDrives?: boolean;
        corpora?: string;
      };
      assert.equal(params.supportsAllDrives, true, request.operation);
      if (request.operation === 'list') {
        assert.equal(params.includeItemsFromAllDrives, true);
        assert.equal(params.corpora, 'allDrives');
      }
    }
    const plain = new FakeDrive();
    expectOk(await adapterFor(plain).set('k', 'v', { signal }));
    assert.ok(
      plain.requests.every(
        (request) =>
          (request.params as { supportsAllDrives?: boolean })
            .supportsAllDrives === undefined
      )
    );
  });
});
