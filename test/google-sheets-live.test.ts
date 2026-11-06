/**
 * The Google Sheets adapter against a real spreadsheet, through `@googleapis/sheets`.
 * Skipped unless a spreadsheet is named:
 *
 *   TEST_GOOGLE_SHEETS_ID=<spreadsheet ID>
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
 *
 * The spreadsheet must be shared with the service account as an Editor, and the Google
 * Sheets API must be enabled for its project. Each test adds a tab of its own and deletes
 * it afterwards. Sheets allows about 60 requests a minute per user, so the client is
 * slowed to one request every 1.1 seconds (`TEST_GOOGLE_SHEETS_GAP_MS` changes that) and
 * the run takes several minutes; give bun a long timeout:
 *
 *   bun test --timeout 600000 test/google-sheets-live.test.ts
 *
 * Nothing here has been run against a real spreadsheet by the author of the adapter yet;
 * the default test run uses the stand-in in test/support/fake-google-sheets.ts.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { auth, sheets as createSheets } from '@googleapis/sheets';

import {
  googleSheetsAdapter,
  type SheetsClientLike,
} from '../src/google-sheets/index.js';
import type { StorageAdapter, StoreResult } from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

const spreadsheetId: string | undefined = process.env.TEST_GOOGLE_SHEETS_ID;
if (spreadsheetId === undefined || spreadsheetId === '') {
  void describe('googleSheetsAdapter on a Google spreadsheet', () => {
    void it(
      'is skipped: set TEST_GOOGLE_SHEETS_ID to run it',
      { skip: true },
      () => {
        // Nothing to run without a spreadsheet.
      }
    );
  });
} else {
  const gapMs = Number(process.env.TEST_GOOGLE_SHEETS_GAP_MS ?? '1100');
  const real = createSheets({
    version: 'v4',
    auth: new auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    }),
  });

  /** Spaces requests out so a run stays under the per-minute quota. */
  let nextFree = 0;
  const paced = async <T>(send: () => Promise<T>): Promise<T> => {
    const wait: number = Math.max(0, nextFree - Date.now());
    nextFree = Math.max(nextFree, Date.now()) + gapMs;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    return send();
  };

  // The real client is passed as it is: this also checks that it fits `SheetsClientLike`.
  const values: SheetsClientLike['spreadsheets']['values'] =
    real.spreadsheets.values;
  const client: SheetsClientLike = {
    spreadsheets: {
      values: {
        get: (params, options) => paced(() => values.get(params, options)),
        update: (params, options) =>
          paced(() => values.update(params, options)),
        append: (params, options) =>
          paced(() => values.append(params, options)),
        clear: (params, options) => paced(() => values.clear(params, options)),
      },
    },
  };

  const addTab = async (): Promise<{ title: string; sheetId: number }> => {
    const title = `t_${randomBytes(6).toString('hex')}`;
    const added = await paced(() =>
      real.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      })
    );
    const sheetId: number | null | undefined =
      added.data.replies?.[0]?.addSheet?.properties?.sheetId;
    assert.equal(typeof sheetId, 'number', 'the new tab should have an ID');
    return { title, sheetId: sheetId as number };
  };

  const dropTab = async (sheetId: number): Promise<void> => {
    await paced(() =>
      real.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ deleteSheet: { sheetId } }] },
      })
    );
  };

  const adapterFor = (title: string): StorageAdapter =>
    googleSheetsAdapter({ client, spreadsheetId, sheetName: title });

  runConformance('googleSheetsAdapter on a Google spreadsheet', {
    ownWrites: 'notifies',
    create: async () => {
      const tab = await addTab();
      return {
        adapter: adapterFor(tab.title),
        reopen: () => adapterFor(tab.title),
        cleanup: () => dropTab(tab.sheetId),
      };
    },
  });

  void describe('googleSheetsAdapter on a Google spreadsheet: beyond the contract', () => {
    void it('stores text that starts with = as text, and shows the row to a reader', async () => {
      const tab = await addTab();
      try {
        const adapter = adapterFor(tab.title);
        expectOk(await adapter.set('formula', '=1+1', { signal }));
        expectOk(await adapter.set('number', '007', { signal }));
        assert.equal(
          expectOk(await adapter.get('formula', { signal }))?.value,
          '=1+1'
        );
        assert.equal(
          expectOk(await adapter.get('number', { signal }))?.value,
          '007'
        );
        const read = await paced(() =>
          real.spreadsheets.values.get({
            spreadsheetId,
            range: `'${tab.title}'!A1:E3`,
            valueRenderOption: 'FORMATTED_VALUE',
          })
        );
        assert.deepEqual(read.data.values?.[0], [
          'key',
          'value',
          'revision',
          'updated_at',
          'deleted',
        ]);
        assert.equal(read.data.values?.[1]?.[1], '=1+1');
      } finally {
        await dropTab(tab.sheetId);
      }
    });

    void it('explains a tab that does not exist', async () => {
      const adapter = adapterFor(`missing_${randomBytes(4).toString('hex')}`);
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.match(result.error, /no tab named/);
    });
  });
}
