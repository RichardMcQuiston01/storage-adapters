/**
 * The Google Sheets adapter, over an in-memory stand-in for the Sheets values API
 * (test/support/fake-google-sheets.ts), so the default test run stays offline.
 * test/google-sheets-live.test.ts runs the same adapter against a real spreadsheet.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  googleSheetsAdapter,
  SHEET_COLUMNS,
  type GoogleSheetsAdapterOptions,
} from '../src/google-sheets/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { runConformance } from './support/conformance.js';
import { FakeSheets, FakeSheetsError } from './support/fake-google-sheets.js';

const signal: AbortSignal = new AbortController().signal;
const SPREADSHEET = 'sheet-id-123';

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
  assert.ok(result.error.startsWith('Google Sheets '), result.error);
  return result.error;
}

function adapterFor(
  sheets: FakeSheets,
  more: Partial<GoogleSheetsAdapterOptions> = {}
): StorageAdapter {
  return googleSheetsAdapter({
    client: sheets.client,
    spreadsheetId: SPREADSHEET,
    now: () => new Date('2026-11-06T12:00:00.000Z'),
    ...more,
  });
}

const removeKey = async (
  adapter: StorageAdapter,
  key: string
): Promise<StoreResult<null>> =>
  (await adapter.remove?.(key, { signal })) ?? { ok: true, value: null };

runConformance('googleSheetsAdapter on a stand-in spreadsheet', {
  ownWrites: 'notifies',
  create: () => {
    const sheets = new FakeSheets();
    return {
      adapter: adapterFor(sheets),
      reopen: () => adapterFor(sheets),
    };
  },
});

void describe('googleSheetsAdapter', () => {
  void it('keeps one row per key under column names in row 1', async () => {
    const sheets = new FakeSheets();
    const adapter = adapterFor(sheets);
    assert.deepEqual(expectOk(await adapter.get('a', { signal })), null);
    assert.deepEqual(sheets.rows(), [], 'a read writes nothing');
    assert.deepEqual(expectOk(await adapter.set('a', 'one', { signal })), {
      value: 'one',
      revision: '1',
    });
    expectOk(await adapter.set('b', 'two', { signal }));
    assert.deepEqual(sheets.rows(), [
      [...SHEET_COLUMNS],
      ['a', 'one', '1', '2026-11-06T12:00:00.000Z', ''],
      ['b', 'two', '1', '2026-11-06T12:00:00.000Z', ''],
    ]);
    assert.deepEqual(expectOk(await adapter.set('a', 'uno', { signal })), {
      value: 'uno',
      revision: '2',
    });
    assert.equal(sheets.rows()[1]?.[1], 'uno');
    assert.equal(sheets.rows().length, 3, 'an update reuses the key row');
  });

  void it('sends every value as RAW, so text starting with = stays text', async () => {
    const sheets = new FakeSheets();
    const adapter = adapterFor(sheets);
    for (const value of ['=1+1', '+1', '-1', '@sum', '007', 'TRUE', '1e3']) {
      expectOk(await adapter.set('k', value, { signal }));
      assert.deepEqual(
        expectOk(await adapter.get('k', { signal }))?.value,
        value
      );
    }
    const writes = sheets.requests.filter(
      (request) =>
        request.operation === 'update' || request.operation === 'append'
    );
    assert.ok(writes.length > 0);
    for (const request of writes) {
      assert.equal(
        (request.params as { valueInputOption: string }).valueInputOption,
        'RAW'
      );
    }
    for (const request of sheets.requests.filter(
      (r) => r.operation === 'get'
    )) {
      assert.equal(
        (request.params as { valueRenderOption: string }).valueRenderOption,
        'UNFORMATTED_VALUE'
      );
    }
  });

  void it('stores empty, multi-line and unusual values and keys exactly', async () => {
    const adapter = adapterFor(new FakeSheets());
    const keys: string[] = [
      "it's",
      'two words',
      'tab\there',
      'line\nbreak',
      '日本語',
      '😀',
    ];
    for (const key of keys) {
      expectOk(await adapter.set(key, `value of ${key}`, { signal }));
    }
    expectOk(await adapter.set('empty', '', { signal }));
    expectOk(await adapter.set('lines', 'a\nb\r\nc', { signal }));
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
  });

  void it('refuses what a cell cannot hold, naming the key', async () => {
    const sheets = new FakeSheets();
    const adapter = adapterFor(sheets);
    expectOk(await adapter.set('big', 'x'.repeat(50_000), { signal }));
    assert.match(
      expectFailure(
        await adapter.set('big', 'x'.repeat(50_001), { signal }),
        'invalid',
        'big'
      ),
      /50001 characters.*at most 50000/
    );
    expectFailure(await adapter.set('', 'v', { signal }), 'invalid', '');
    expectFailure(
      await adapter.set('k'.repeat(1001), 'v', { signal }),
      'invalid',
      'k'.repeat(1001)
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
    assert.equal(
      expectOk(await adapter.get('big', { signal }))?.value.length,
      50_000
    );
  });

  void it('quotes a tab name that has a quote in it', async () => {
    const sheets = new FakeSheets(["O'Brien settings"]);
    const adapter = adapterFor(sheets, { sheetName: "O'Brien settings" });
    expectOk(await adapter.set('k', 'v', { signal }));
    assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'v');
    assert.ok(
      sheets.requests.every((request) =>
        request.range.startsWith("'O''Brien settings'!")
      )
    );
  });

  void describe('revisions', () => {
    void it('counts up and checks ifRevision', async () => {
      const adapter = adapterFor(new FakeSheets());
      const first = expectOk(await adapter.set('k', 'a', { signal }));
      assert.equal(first.revision, '1');
      const second = expectOk(
        await adapter.set('k', 'b', { signal, ifRevision: '1' })
      );
      assert.equal(second.revision, '2');
      const error: string = expectFailure(
        await adapter.set('k', 'c', { signal, ifRevision: '1' }),
        'conflict',
        'k'
      );
      assert.match(error, /holds revision 2, but revision 1 was expected/);
      assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'b');
    });

    void it('creates a key that has nothing stored when ifRevision is given', async () => {
      const adapter = adapterFor(new FakeSheets());
      assert.equal(
        expectOk(await adapter.set('new', 'v', { signal, ifRevision: '7' }))
          .revision,
        '1'
      );
    });

    void it('marks a removed key deleted and keeps counting when it is set again', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      expectOk(await adapter.set('k', 'v', { signal }));
      expectOk(await removeKey(adapter, 'k'));
      assert.deepEqual(sheets.rows()[1], [
        'k',
        '',
        '2',
        '2026-11-06T12:00:00.000Z',
        'true',
      ]);
      assert.equal(expectOk(await adapter.get('k', { signal })), null);
      assert.deepEqual(
        expectOk(
          (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
        ),
        []
      );
      assert.deepEqual(
        expectOk(await adapter.set('k', 'again', { signal, ifRevision: '1' })),
        { value: 'again', revision: '3' },
        'a removed key has nothing stored, so any ifRevision creates it'
      );
      assert.equal(sheets.rows().length, 2, 'the key keeps its row');
      assert.equal(sheets.rows()[1]?.[4], '');
    });

    void it('removing a key that is not there writes nothing', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      assert.deepEqual(expectOk(await removeKey(adapter, 'nope')), null);
      assert.ok(
        sheets.requests.every((request) => request.operation === 'get')
      );
    });

    void it('queues writes to one key made through the same adapter', async () => {
      const adapter = adapterFor(new FakeSheets());
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => adapter.set('k', String(n), { signal }))
      );
      assert.deepEqual(
        results.map((result) => expectOk(result).revision),
        ['1', '2', '3', '4', '5']
      );
    });
  });

  void describe('rows edited by hand', () => {
    void it('reads numbers, booleans and a missing revision', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      sheets.setRow('storage_entry', 1, ['key', 'value', 'revision']);
      sheets.setRow('storage_entry', 2, ['count', 42, 9]);
      sheets.setRow('storage_entry', 3, ['flag', true]);
      sheets.setRow('storage_entry', 4, ['note', 'hello']);
      assert.deepEqual(expectOk(await adapter.get('count', { signal })), {
        value: '42',
        revision: '9',
      });
      assert.deepEqual(expectOk(await adapter.get('flag', { signal })), {
        value: 'TRUE',
        revision: '0',
      });
      assert.deepEqual(
        expectOk(await adapter.set('note', 'bye', { signal, ifRevision: '0' })),
        { value: 'bye', revision: '1' }
      );
      assert.equal(sheets.rows()[3]?.[1], 'bye', 'the key keeps its own row');
    });

    void it('skips blank rows and uses the first of two rows for one key', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      sheets.setRow('storage_entry', 1, [...SHEET_COLUMNS]);
      sheets.setRow('storage_entry', 3, ['dup', 'first', '1']);
      sheets.setRow('storage_entry', 5, ['dup', 'second', '5']);
      sheets.setRow('storage_entry', 6, ['other', 'x', '1']);
      assert.deepEqual(expectOk(await adapter.get('dup', { signal })), {
        value: 'first',
        revision: '1',
      });
      assert.deepEqual(
        expectOk(
          (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
        ),
        ['dup', 'other']
      );
      expectOk(await adapter.set('dup', 'changed', { signal }));
      assert.equal(sheets.rows()[2]?.[1], 'changed');
      assert.equal(sheets.rows()[4]?.[1], 'second');
    });

    void it('reports a revision that is not a whole number as corrupt, and does not touch the row', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      sheets.setRow('storage_entry', 1, [...SHEET_COLUMNS]);
      sheets.setRow('storage_entry', 2, ['bad', 'v', 'abc']);
      sheets.setRow('storage_entry', 3, ['good', 'v', '1']);
      assert.match(
        expectFailure(await adapter.get('bad', { signal }), 'corrupt', 'bad'),
        /row 2 of tab "storage_entry"/
      );
      expectFailure(
        await adapter.set('bad', 'x', { signal }),
        'corrupt',
        'bad'
      );
      assert.equal(sheets.rows()[1]?.[1], 'v');
      assert.equal(expectOk(await adapter.get('good', { signal }))?.value, 'v');
    });

    void it('writes the column names when the first row is empty, even if rows follow', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      sheets.setRow('storage_entry', 2, ['a', 'v', '1']);
      expectOk(await adapter.set('b', 'w', { signal }));
      assert.deepEqual(sheets.rows()[0], [...SHEET_COLUMNS]);
      assert.equal(expectOk(await adapter.get('a', { signal }))?.value, 'v');
    });

    void it('never overwrites a first row that already has headings', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      sheets.setRow('storage_entry', 1, ['Setting', 'Value', 'Rev']);
      expectOk(await adapter.set('a', 'v', { signal }));
      assert.deepEqual(sheets.rows()[0], ['Setting', 'Value', 'Rev']);
    });
  });

  void describe('creating a key at the same moment as another writer', () => {
    void it('lets the first row win and clears the other one', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      expectOk(await adapter.set('other', 'x', { signal }));
      let played = false;
      sheets.before = (request) => {
        // Another process appends the same key just before this adapter's append.
        if (request.operation === 'append' && !played) {
          played = true;
          sheets.setRow('storage_entry', 3, ['k', 'theirs', '1']);
        }
      };
      const error: string = expectFailure(
        await adapter.set('k', 'mine', { signal }),
        'conflict',
        'k'
      );
      assert.match(error, /another writer at the same moment/);
      sheets.before = null;
      assert.equal(
        expectOk(await adapter.get('k', { signal }))?.value,
        'theirs'
      );
      assert.deepEqual(sheets.rows()[3], [], 'the losing row is cleared');
    });

    void it('keeps its own row when it is the first', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      sheets.before = (request) => {
        // Another process appends the same key after this adapter's append.
        if (request.operation === 'get' && sheets.rows().length === 2) {
          sheets.setRow('storage_entry', 3, ['k', 'theirs', '1']);
        }
      };
      expectOk(await adapter.set('k', 'mine', { signal }));
      sheets.before = null;
      assert.equal(expectOk(await adapter.get('k', { signal }))?.value, 'mine');
    });
  });

  void describe('failures', () => {
    void it('explains a missing tab', async () => {
      const adapter = adapterFor(new FakeSheets([]), { sheetName: 'Settings' });
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k'),
        /no tab named "Settings".*create it, or set sheetName/
      );
      const listed = await adapter.list?.('p', { signal });
      assert.ok(listed !== undefined && !listed.ok);
      assert.match(listed.error, /for prefix "p"$/);
    });

    void it('explains 403, 404, 429 and 401', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      sheets.failures.push(
        new FakeSheetsError('The caller does not have permission', 403)
      );
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'forbidden', 'k'),
        /share it with that account.*as an Editor/
      );
      sheets.failures.push(
        new FakeSheetsError(
          'Google Sheets API has not been used in project 118565593530 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=118565593530 then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.',
          403
        )
      );
      const disabled: string = expectFailure(
        await adapter.get('k', { signal }),
        'forbidden',
        'k'
      );
      assert.match(
        disabled,
        /Sheets API is not enabled for Google Cloud project 118565593530.*click Enable.*owns the service account/
      );
      assert.ok(
        !/share it with that account/.test(disabled),
        'the sharing hint is for permission errors, not this one'
      );
      sheets.failures.push(
        new FakeSheetsError('Requested entity was not found.', 404)
      );
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k'),
        /spreadsheet not found.*between \/d\/ and \/edit/
      );
      sheets.failures.push(
        new FakeSheetsError('Quota exceeded for quota metric', 429)
      );
      assert.match(
        expectFailure(
          await adapter.set('k', 'v', { signal }),
          'unavailable',
          'k'
        ),
        /about 60 reads and 60 writes per minute/
      );
      sheets.failures.push(
        new FakeSheetsError('Request is missing credentials', 401)
      );
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'forbidden', 'k'),
        /credentials were not accepted/
      );
      sheets.failures.push(new FakeSheetsError('Rate Limit Exceeded', 403));
      expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k');
    });

    void it('turns a network error into a result', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      sheets.failures.push(
        new Error('getaddrinfo ENOTFOUND sheets.googleapis.com')
      );
      assert.match(
        expectFailure(await adapter.get('k', { signal }), 'unavailable', 'k'),
        /could not be reached \(getaddrinfo ENOTFOUND/
      );
    });

    void it('says which step of a write failed', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      sheets.failures.push(new Error('boom'));
      assert.match(
        expectFailure(
          await adapter.set('k', 'v', { signal }),
          'unavailable',
          'k'
        ),
        /could not be read before writing/
      );
      sheets.before = (request) => {
        if (request.operation === 'append') {
          sheets.failures.push(new Error('boom'));
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
      sheets.before = (request) => {
        if (request.operation === 'append') {
          sheets.before = (next) => {
            if (next.operation === 'get') {
              sheets.failures.push(new Error('boom'));
            }
          };
        }
      };
      assert.match(
        expectFailure(
          await adapter.set('k2', 'v', { signal }),
          'unavailable',
          'k2'
        ),
        /was written but could not be read back to confirm it/
      );
    });

    void it('does not send a request when the signal is already aborted, and stops waiting when it aborts', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
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
      assert.equal(sheets.requests.length, 0);
      const midway = new AbortController();
      sheets.before = async () => {
        midway.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
      };
      expectFailure(
        await adapter.get('k', { signal: midway.signal }),
        'unavailable',
        'k'
      );
    });

    void it('sends no write when the signal is aborted after the read', async () => {
      const sheets = new FakeSheets();
      const controller = new AbortController();
      // `now` runs after the tab is read and just before the row is written.
      const adapter = adapterFor(sheets, {
        now: () => {
          controller.abort();
          return new Date('2026-11-06T12:00:00.000Z');
        },
      });
      expectOk(await adapter.get('seed', { signal }));
      assert.match(
        expectFailure(
          await adapter.set('k', 'v', { signal: controller.signal }),
          'unavailable',
          'k'
        ),
        /request was aborted/
      );
      assert.ok(
        sheets.requests.every(
          (request) =>
            request.operation === 'get' || request.range.endsWith('!A1:E1')
        ),
        'only reads and the column names were sent, no row'
      );
    });

    void it('passes the abort signal to the client', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      const controller = new AbortController();
      expectOk(await adapter.get('k', { signal: controller.signal }));
      assert.equal(sheets.requests[0]?.options?.signal, controller.signal);
    });

    void it('refuses to run with an empty spreadsheet ID or tab name', async () => {
      const sheets = new FakeSheets();
      assert.match(
        expectFailure(
          await adapterFor(sheets, { spreadsheetId: '  ' }).get('k', {
            signal,
          }),
          'invalid',
          'k'
        ),
        /spreadsheetId is empty/
      );
      assert.match(
        expectFailure(
          await adapterFor(sheets, { sheetName: ' ' }).set('k', 'v', {
            signal,
          }),
          'invalid',
          'k'
        ),
        /sheetName is empty/
      );
      const listed = await adapterFor(sheets, { spreadsheetId: '' }).list?.(
        '',
        {
          signal,
        }
      );
      assert.ok(
        listed !== undefined && !listed.ok && listed.code === 'invalid'
      );
      assert.equal(sheets.requests.length, 0);
    });
  });

  void describe('list', () => {
    void it('lists live keys with the prefix, sorted, once each', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      for (const key of ['b/2', 'a/1', 'b/1', 'c']) {
        expectOk(await adapter.set(key, 'v', { signal }));
      }
      expectOk(await removeKey(adapter, 'b/2'));
      assert.deepEqual(
        expectOk(
          (await adapter.list?.('b/', { signal })) ?? { ok: true, value: [] }
        ),
        ['b/1']
      );
      assert.deepEqual(
        expectOk(
          (await adapter.list?.('', { signal })) ?? { ok: true, value: [] }
        ),
        ['a/1', 'b/1', 'c']
      );
    });

    void it('reads the tab once', async () => {
      const sheets = new FakeSheets();
      const adapter = adapterFor(sheets);
      expectOk(await adapter.set('a', 'v', { signal }));
      sheets.requests.length = 0;
      await adapter.list?.('', { signal });
      assert.equal(sheets.requests.length, 1);
    });
  });

  void describe('subscribe', () => {
    void it('reports its own writes and removals once', async () => {
      const adapter = adapterFor(new FakeSheets());
      const seen: (StoredValue | null)[] = [];
      const stop = adapter.subscribe?.('k', (stored) => seen.push(stored));
      expectOk(await adapter.set('k', 'v', { signal }));
      expectOk(await removeKey(adapter, 'k'));
      stop?.();
      assert.deepEqual(seen, [{ value: 'v', revision: '1' }, null]);
    });

    void it('reports an update of a key that already has a row', async () => {
      const adapter = adapterFor(new FakeSheets());
      expectOk(await adapter.set('k', 'one', { signal }));
      const seen: (StoredValue | null)[] = [];
      const stop = adapter.subscribe?.('k', (stored) => seen.push(stored));
      expectOk(await adapter.set('k', 'two', { signal }));
      stop?.();
      assert.deepEqual(seen, [{ value: 'two', revision: '2' }]);
    });

    void it('hears changes made by someone else only when it polls', async () => {
      const sheets = new FakeSheets();
      const quiet = adapterFor(sheets);
      const polling = adapterFor(sheets, { pollIntervalMs: 50 });
      const heardQuiet: (StoredValue | null)[] = [];
      const heardPolling: (StoredValue | null)[] = [];
      const stopQuiet = quiet.subscribe?.('k', (stored) =>
        heardQuiet.push(stored)
      );
      const stopPolling = polling.subscribe?.('k', (stored) =>
        heardPolling.push(stored)
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      expectOk(await adapterFor(sheets).set('k', 'from elsewhere', { signal }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      stopQuiet?.();
      stopPolling?.();
      assert.deepEqual(heardQuiet, []);
      assert.deepEqual(heardPolling, [
        { value: 'from elsewhere', revision: '1' },
      ]);
    });

    void it('reads the tab once per poll however many keys are watched', async () => {
      const sheets = new FakeSheets();
      const polling = adapterFor(sheets, { pollIntervalMs: 50 });
      const stops = ['a', 'b', 'c'].map((key) =>
        polling.subscribe?.(key, () => undefined)
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      sheets.requests.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 180));
      for (const stop of stops) {
        stop?.();
      }
      const reads: number = sheets.requests.length;
      assert.ok(
        reads >= 2 && reads <= 5,
        `expected about 3 reads, saw ${String(reads)}`
      );
      assert.ok(
        sheets.requests.every((request) => request.operation === 'get')
      );
    });

    void it('calls onPollError once for a run of failed polls', async () => {
      const sheets = new FakeSheets();
      const messages: string[] = [];
      const polling = adapterFor(sheets, {
        pollIntervalMs: 50,
        onPollError: (message) => messages.push(message),
      });
      const stop = polling.subscribe?.('k', () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 70));
      for (let count = 0; count < 4; count += 1) {
        sheets.failures.push(new FakeSheetsError('Quota exceeded', 429));
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      stop?.();
      assert.equal(messages.length, 1);
      assert.match(
        messages[0] ?? '',
        /Google Sheets could not poll tab "storage_entry" for changes/
      );
    });
  });
});
