/**
 * A `StorageAdapter` over a tab of a Google Sheets spreadsheet. Like `/clickhouse` and
 * `/influxdb`, this is an optional entry point that imports nothing: you pass in the
 * Sheets client to use (the one from `@googleapis/sheets` fits), so this file never
 * touches the network itself.
 *
 * A spreadsheet is a shared notebook, not a database: it has no conditional write and a
 * small request quota. This adapter keeps one row per key, readable and editable by hand,
 * and is best-effort about `ifRevision`. See `googleSheetsAdapter` for what that costs.
 */
import { describeUnknownError } from '../errors.js';
import { createChangePoller } from '../change-poller.js';
import { createKeyedQueue, type KeyedQueue } from '../keyed-queue.js';
import { sqlFailure } from '../sql-shared.js';
import {
  compareKeys,
  prefixFailure,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** The column names written into the first row of the tab. */
export const SHEET_COLUMNS: readonly string[] = [
  'key',
  'value',
  'revision',
  'updated_at',
  'deleted',
];

/** Google Sheets refuses a cell of more than 50,000 characters. */
export const MAX_CELL_LENGTH = 50_000;

/** The options a request can carry; the Sheets client accepts an abort signal here. */
export interface SheetsRequestOptionsLike {
  signal?: AbortSignal;
}

export interface SheetsGetParamsLike {
  spreadsheetId: string;
  range: string;
  valueRenderOption: 'UNFORMATTED_VALUE';
}

export interface SheetsUpdateParamsLike {
  spreadsheetId: string;
  range: string;
  valueInputOption: 'RAW';
  requestBody: { values: string[][] };
}

export interface SheetsAppendParamsLike {
  spreadsheetId: string;
  range: string;
  valueInputOption: 'RAW';
  insertDataOption: 'INSERT_ROWS';
  requestBody: { values: string[][] };
}

export interface SheetsClearParamsLike {
  spreadsheetId: string;
  range: string;
}

/** The part of a Sheets `ValueRange` response this adapter reads. */
export interface SheetsValueRangeLike {
  values?: unknown[][] | null;
}

/** The part of an append response this adapter reads: where the new row landed. */
export interface SheetsAppendResponseLike {
  updates?: { updatedRange?: string | null } | null;
}

/** `spreadsheets.values` of the Sheets API, reduced to the four calls used here. */
export interface SheetsValuesLike {
  get(
    params: SheetsGetParamsLike,
    options?: SheetsRequestOptionsLike
  ): Promise<{ data: SheetsValueRangeLike }>;
  update(
    params: SheetsUpdateParamsLike,
    options?: SheetsRequestOptionsLike
  ): Promise<unknown>;
  append(
    params: SheetsAppendParamsLike,
    options?: SheetsRequestOptionsLike
  ): Promise<{ data: SheetsAppendResponseLike }>;
  clear(
    params: SheetsClearParamsLike,
    options?: SheetsRequestOptionsLike
  ): Promise<unknown>;
}

/**
 * What this adapter needs from a Google Sheets client: `spreadsheets.values` with
 * `get`, `update`, `append` and `clear`. The client from `@googleapis/sheets` or
 * `googleapis` (`sheets({ version: 'v4', auth })`) fits as it is.
 */
export interface SheetsClientLike {
  spreadsheets: { values: SheetsValuesLike };
}

export interface GoogleSheetsAdapterOptions {
  /** The Sheets client. */
  readonly client: SheetsClientLike;
  /** The spreadsheet's ID: the long part of its URL between `/d/` and `/edit`. */
  readonly spreadsheetId: string;
  /** The tab that holds the entries. It must already exist. Defaults to `storage_entry`. */
  readonly sheetName?: string;
  /** The time written into the `updated_at` column. Defaults to `new Date()`. */
  readonly now?: () => Date;
  /**
   * Milliseconds between looks at the subscribed keys for changes other people or
   * processes made (at least 50). Sheets cannot announce changes to a plain API client,
   * so `subscribe` hears only this adapter's own writes unless you give this. Every
   * look is one read of the tab, and Sheets allows only about 60 reads a minute per
   * user, so use a few seconds at least. Off by default.
   */
  readonly pollIntervalMs?: number;
  /** Called once per run of failed polls, with a message naming the tab. */
  readonly onPollError?: (message: string) => void;
}

const LABEL = 'Google Sheets';
const DEFAULT_SHEET_NAME = 'storage_entry';
const LAST_COLUMN = 'E';
const MAX_KEY_LENGTH = 1000;
const MAX_DETAIL_LENGTH = 300;

function hasLoneSurrogate(text: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    text
  );
}

/** `'my tab'!A:E`: the tab name quoted, with any `'` in it doubled. */
function rangeFor(sheetName: string, cells: string): string {
  return `'${sheetName.split("'").join("''")}'!${cells}`;
}

/** The text a cell holds, as Sheets returned it with `UNFORMATTED_VALUE`. */
function cellText(cell: unknown): string {
  if (typeof cell === 'string') {
    return cell;
  }
  if (typeof cell === 'number' || typeof cell === 'bigint') {
    return String(cell);
  }
  if (typeof cell === 'boolean') {
    return cell ? 'TRUE' : 'FALSE';
  }
  return '';
}

/** The HTTP status carried by an error from the Google client, whichever field it used. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [
    candidate.code,
    candidate.status,
    candidate.response?.status,
  ]) {
    const status: number =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : NaN;
    if (Number.isInteger(status) && status >= 400 && status < 600) {
      return status;
    }
  }
  return undefined;
}

function shorten(text: string): string {
  const said: string = text.trim().replace(/\s+/g, ' ');
  return said.length > MAX_DETAIL_LENGTH
    ? `${said.slice(0, MAX_DETAIL_LENGTH)}...`
    : said;
}

type Failed = { readonly code: StoreErrorCode; readonly detail: string };

/** Turns what the Sheets client threw into a code and a message that says what to do. */
function describeFailure(
  error: unknown,
  sheetName: string,
  signal: AbortSignal
): Failed {
  if (signal.aborted) {
    return { code: 'unavailable', detail: 'request was aborted' };
  }
  const message: string = shorten(describeUnknownError(error));
  switch (statusOf(error)) {
    case 429:
      return {
        code: 'unavailable',
        detail: `${message} (Google Sheets allows only about 60 reads and 60 writes per minute per user: this adapter is being used too often, or pollIntervalMs is too short)`,
      };
    case 401:
      return {
        code: 'forbidden',
        detail: `${message} (the client's credentials were not accepted: check the service account key or token)`,
      };
    case 403:
      if (
        /has not been used in project|is disabled|SERVICE_DISABLED/i.test(
          message
        )
      ) {
        const project: string =
          /\bproject (\S+) before\b/i.exec(message)?.[1] ??
          'that owns the credentials';
        return {
          code: 'forbidden',
          detail: `the Google Sheets API is not enabled for Google Cloud project ${project}: open https://console.cloud.google.com/apis/library/sheets.googleapis.com in that project, click Enable, wait a few minutes, then try again (the project is the one that owns the service account or credentials the client uses; Google said: ${message})`,
        };
      }
      return /quota|rate limit/i.test(message)
        ? {
            code: 'unavailable',
            detail: `${message} (Google Sheets allows only about 60 requests per minute per user: slow down)`,
          }
        : {
            code: 'forbidden',
            detail: `${message} (the account the client signs in as cannot edit this spreadsheet: share it with that account, a service account's email address, as an Editor)`,
          };
    case 404:
      return {
        code: 'unavailable',
        detail: `${message} (spreadsheet not found: check the spreadsheet ID, which is the long part of its URL between /d/ and /edit)`,
      };
    case 400:
      return {
        code: 'unavailable',
        detail: /unable to parse range|not found/i.test(message)
          ? `${message} (the spreadsheet has no tab named "${sheetName}": create it, or set sheetName)`
          : message,
      };
    default:
      return {
        code: 'unavailable',
        detail: `could not be reached (${message})`,
      };
  }
}

/** One key's row, as read. */
interface Entry {
  /** The row's number in the tab, counting from 1 (row 1 holds the column names). */
  readonly row: number;
  readonly value: string;
  /** `null` when the revision cell is not a whole number. */
  readonly revision: string | null;
  readonly deleted: boolean;
}

interface Table {
  /** Each key's first row; later rows for the same key are ignored. */
  readonly entries: ReadonlyMap<string, Entry>;
  /** Whether the first row has anything in it. */
  readonly hasHeader: boolean;
}

function tableOf(rows: readonly (readonly unknown[])[]): Table {
  const entries = new Map<string, Entry>();
  const first: readonly unknown[] = rows[0] ?? [];
  for (const [index, cells] of rows.entries()) {
    if (index === 0) {
      continue;
    }
    const key: string = cellText(cells[0]);
    if (key === '' || entries.has(key)) {
      continue;
    }
    const revisionText: string = cellText(cells[2]).trim();
    entries.set(key, {
      row: index + 1,
      value: cellText(cells[1]),
      // A row added by hand has no revision yet; it starts at 0.
      revision:
        revisionText === ''
          ? '0'
          : /^\d+$/.test(revisionText)
            ? revisionText
            : null,
      deleted: /^true$/i.test(cellText(cells[4]).trim()),
    });
  }
  return { entries, hasHeader: first.some((cell) => cellText(cell) !== '') };
}

/** The row number a `A12:E12`-style range starts at, or `undefined`. */
function rowOfRange(range: string | null | undefined): number | undefined {
  const match: RegExpMatchArray | null =
    typeof range === 'string' ? range.match(/!\$?[A-Za-z]+\$?(\d+)/) : null;
  return match === null ? undefined : Number(match[1]);
}

/**
 * A `StorageAdapter` over one tab of a Google Sheets spreadsheet. Each key is a row with
 * the columns `key`, `value`, `revision`, `updated_at` and `deleted`; row 1 holds the
 * column names, which the adapter writes the first time it stores something. Values are
 * sent as `RAW`, so text starting with `=` is stored as text and never runs as a formula.
 * Because the rows are plain cells, people can read them, and edit values, by hand.
 *
 * Sheets has no conditional write, so a revision cannot be checked atomically. `set`
 * reads the tab, compares the key's revision with `ifRevision`, then writes the row: two
 * writers that update the same key within the moment between those two requests can both
 * be told they succeeded, and the later write wins. Creating a key is safer: the row is
 * appended, then read back, and if another writer appended the same key at the same
 * moment the first row wins and the other writer gets `conflict`. (Writes made through
 * one adapter object wait for each other, so among them the check holds.) Use this
 * adapter where one writer changes a key at a time, or accept that.
 *
 * Every operation reads the whole tab (one request), so it suits small stores of
 * settings, and Sheets allows only about 60 requests a minute per user: `get` and `list`
 * cost one request, `set` two or three, `remove` two. A value or key longer than a cell
 * holds is refused, not cut. `remove` marks the row deleted (the `deleted` column) rather
 * than deleting it, so a row never moves under another writer; setting the key again
 * reuses its row, and you can delete the marked rows by hand when nothing is writing.
 * Do not insert or delete rows, or move them, while an application is writing. A value
 * you edit by hand without changing `revision` is not noticed by `ifRevision`.
 * `subscribe` reports this adapter's own writes and, with `pollIntervalMs`, changes made
 * by others. Nothing throws: every failure, a network error included, is a `StoreResult`.
 */
export function googleSheetsAdapter(
  options: GoogleSheetsAdapterOptions
): StorageAdapter {
  const spreadsheetId: string = options.spreadsheetId.trim();
  const sheetName: string = options.sheetName ?? DEFAULT_SHEET_NAME;
  const now: () => Date = options.now ?? ((): Date => new Date());
  const values: SheetsValuesLike = options.client.spreadsheets.values;
  const where = `tab "${sheetName}"`;
  const optionsProblem: string | null =
    spreadsheetId === ''
      ? 'cannot be used: spreadsheetId is empty (it is the long part of the spreadsheet URL between /d/ and /edit)'
      : sheetName.trim() === ''
        ? 'cannot be used: sheetName is empty; leave it out to use "storage_entry"'
        : null;

  /** Runs one request; what it throws, or an abort, becomes a result. */
  const call = async <T>(
    signal: AbortSignal,
    send: () => Promise<T>
  ): Promise<
    { readonly ok: true; readonly value: T } | ({ readonly ok: false } & Failed)
  > => {
    if (signal.aborted) {
      return { ok: false, code: 'unavailable', detail: 'request was aborted' };
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => reject(new Error('request was aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const value: T = await Promise.race([send(), aborted]);
      return { ok: true, value };
    } catch (error: unknown) {
      return { ok: false, ...describeFailure(error, sheetName, signal) };
    } finally {
      if (onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
      // A request that finishes after an abort must not leave an unhandled rejection.
      aborted.catch(() => undefined);
    }
  };

  const readTable = async (
    signal: AbortSignal
  ): Promise<
    | { readonly ok: true; readonly table: Table }
    | ({ readonly ok: false } & Failed)
  > => {
    const answer = await call(signal, () =>
      values.get(
        {
          spreadsheetId,
          range: rangeFor(sheetName, `A:${LAST_COLUMN}`),
          valueRenderOption: 'UNFORMATTED_VALUE',
        },
        { signal }
      )
    );
    if (!answer.ok) {
      return answer;
    }
    const rows: unknown = answer.value.data.values;
    return {
      ok: true,
      table: tableOf(
        Array.isArray(rows)
          ? (rows as unknown[]).map((row) => (Array.isArray(row) ? row : []))
          : []
      ),
    };
  };

  const rowRange = (row: number): string =>
    rangeFor(sheetName, `A${String(row)}:${LAST_COLUMN}${String(row)}`);

  const rowValues = (
    key: string,
    value: string,
    revision: string,
    deleted: boolean
  ): string[][] => [
    [key, value, revision, now().toISOString(), deleted ? 'true' : ''],
  ];

  /** Writes the column names when the first row is empty. */
  const ensureHeader = async (
    table: Table,
    signal: AbortSignal
  ): Promise<Failed | null> => {
    if (table.hasHeader) {
      return null;
    }
    const written = await call(signal, () =>
      values.update(
        {
          spreadsheetId,
          range: rangeFor(sheetName, `A1:${LAST_COLUMN}1`),
          valueInputOption: 'RAW',
          requestBody: { values: [[...SHEET_COLUMNS]] },
        },
        { signal }
      )
    );
    return written.ok ? null : written;
  };

  const checkKey = (key: string, signal: AbortSignal): string | null => {
    if (signal.aborted) {
      return 'request was aborted';
    }
    if (optionsProblem !== null) {
      return optionsProblem;
    }
    if (key === '') {
      return 'cannot use an empty key (an empty cell marks a blank row)';
    }
    if (hasLoneSurrogate(key)) {
      return 'cannot use this key: it is not valid Unicode text';
    }
    if (key.length > MAX_KEY_LENGTH) {
      return `cannot use this key: it has ${String(key.length)} characters and the limit is ${String(MAX_KEY_LENGTH)}`;
    }
    return null;
  };

  const refused = <T>(key: string, problem: string): StoreResult<T> =>
    sqlFailure(
      LABEL,
      problem === 'request was aborted' ? 'unavailable' : 'invalid',
      key,
      problem
    );

  const corrupt = <T>(key: string, entry: Entry): StoreResult<T> =>
    sqlFailure(
      LABEL,
      'corrupt',
      key,
      `holds a revision that is not a whole number in row ${String(entry.row)} of ${where} (fix the revision cell, or delete the row, to start again)`
    );

  /** Reads these keys together; throws if that fails. */
  const readKeys = async (
    keys: readonly string[]
  ): Promise<ReadonlyMap<string, StoredValue>> => {
    const found = new Map<string, StoredValue>();
    if (optionsProblem !== null) {
      throw new Error(optionsProblem);
    }
    const read = await readTable(new AbortController().signal);
    if (!read.ok) {
      throw new Error(read.detail);
    }
    for (const key of keys) {
      const entry: Entry | undefined = read.table.entries.get(key);
      if (entry !== undefined && !entry.deleted && entry.revision !== null) {
        found.set(key, { value: entry.value, revision: entry.revision });
      }
    }
    return found;
  };

  const poller = createChangePoller({
    intervalMs: options.pollIntervalMs,
    readKeys,
    onError: options.onPollError,
    describeFailure: (cause) =>
      `${LABEL} could not poll ${where} for changes (${cause})`,
  });

  const adapter = {
    async get(key, { signal }) {
      const problem: string | null = checkKey(key, signal);
      if (problem !== null) {
        return refused(key, problem);
      }
      const read = await readTable(signal);
      if (!read.ok) {
        return sqlFailure(
          LABEL,
          read.code,
          key,
          `could not be read (${read.detail})`
        );
      }
      const entry: Entry | undefined = read.table.entries.get(key);
      if (entry === undefined || entry.deleted) {
        return { ok: true, value: null };
      }
      if (entry.revision === null) {
        return corrupt(key, entry);
      }
      return {
        ok: true,
        value: { value: entry.value, revision: entry.revision },
      };
    },

    async set(key, value, { signal, ifRevision }) {
      const problem: string | null = checkKey(key, signal);
      if (problem !== null) {
        return refused(key, problem);
      }
      if (hasLoneSurrogate(value)) {
        return sqlFailure(
          LABEL,
          'invalid',
          key,
          'cannot store this value: it is not valid Unicode text'
        );
      }
      if (value.length > MAX_CELL_LENGTH) {
        return sqlFailure(
          LABEL,
          'invalid',
          key,
          `cannot store this value: it has ${String(value.length)} characters and a cell holds at most ${String(MAX_CELL_LENGTH)}`
        );
      }
      const read = await readTable(signal);
      if (!read.ok) {
        return sqlFailure(
          LABEL,
          read.code,
          key,
          `could not be read before writing (${read.detail})`
        );
      }
      const entry: Entry | undefined = read.table.entries.get(key);
      if (entry?.revision === null) {
        return corrupt(key, entry);
      }
      if (
        entry !== undefined &&
        !entry.deleted &&
        ifRevision !== undefined &&
        entry.revision !== ifRevision
      ) {
        return sqlFailure(
          LABEL,
          'conflict',
          key,
          `holds revision ${entry.revision ?? ''}, but revision ${ifRevision} was expected`
        );
      }
      const headerProblem: Failed | null = await ensureHeader(
        read.table,
        signal
      );
      if (headerProblem !== null) {
        return sqlFailure(
          LABEL,
          headerProblem.code,
          key,
          `could not write the column names to ${where} (${headerProblem.detail})`
        );
      }
      if (entry !== undefined) {
        // The key has a row: replace it, with the next revision.
        const revision: string = String(BigInt(entry.revision ?? '0') + 1n);
        const row: string[][] = rowValues(key, value, revision, false);
        const written = await call(signal, () =>
          values.update(
            {
              spreadsheetId,
              range: rowRange(entry.row),
              valueInputOption: 'RAW',
              requestBody: { values: row },
            },
            { signal }
          )
        );
        if (!written.ok) {
          return sqlFailure(
            LABEL,
            written.code,
            key,
            `could not be written (${written.detail})`
          );
        }
        const stored: StoredValue = { value, revision };
        poller.announce(key, stored);
        return { ok: true, value: stored };
      }
      // A new key: append a row, then check that no one else appended the same key first.
      const row: string[][] = rowValues(key, value, '1', false);
      const appended = await call(signal, () =>
        values.append(
          {
            spreadsheetId,
            range: rangeFor(sheetName, `A:${LAST_COLUMN}`),
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: row },
          },
          { signal }
        )
      );
      if (!appended.ok) {
        return sqlFailure(
          LABEL,
          appended.code,
          key,
          `could not be written (${appended.detail})`
        );
      }
      const landed: number | undefined = rowOfRange(
        appended.value.data.updates?.updatedRange
      );
      const confirm = await readTable(signal);
      if (!confirm.ok) {
        return sqlFailure(
          LABEL,
          confirm.code,
          key,
          `was written but could not be read back to confirm it (${confirm.detail})`
        );
      }
      const winner: Entry | undefined = confirm.table.entries.get(key);
      if (
        landed !== undefined &&
        winner !== undefined &&
        winner.row !== landed
      ) {
        // Another writer's row for this key is above ours: theirs stands, ours is cleared.
        await call(signal, () =>
          values.clear({ spreadsheetId, range: rowRange(landed) }, { signal })
        );
        return sqlFailure(
          LABEL,
          'conflict',
          key,
          'was created by another writer at the same moment, and that write won'
        );
      }
      const stored: StoredValue = { value, revision: '1' };
      poller.announce(key, stored);
      return { ok: true, value: stored };
    },

    async remove(key, { signal }) {
      const problem: string | null = checkKey(key, signal);
      if (problem !== null) {
        return refused(key, problem);
      }
      const read = await readTable(signal);
      if (!read.ok) {
        return sqlFailure(
          LABEL,
          read.code,
          key,
          `could not be read before removing (${read.detail})`
        );
      }
      const entry: Entry | undefined = read.table.entries.get(key);
      if (entry === undefined || entry.deleted) {
        return { ok: true, value: null };
      }
      const revision: string = String(BigInt(entry.revision ?? '0') + 1n);
      const row: string[][] = rowValues(key, '', revision, true);
      const removed = await call(signal, () =>
        values.update(
          {
            spreadsheetId,
            range: rowRange(entry.row),
            valueInputOption: 'RAW',
            requestBody: { values: row },
          },
          { signal }
        )
      );
      if (!removed.ok) {
        return sqlFailure(
          LABEL,
          removed.code,
          key,
          `could not be removed (${removed.detail})`
        );
      }
      poller.announce(key, null);
      return { ok: true, value: null };
    },

    async list(keyPrefix, { signal }) {
      if (signal.aborted) {
        return prefixFailure(
          LABEL,
          'unavailable',
          keyPrefix,
          'request to list keys was aborted'
        );
      }
      if (optionsProblem !== null || hasLoneSurrogate(keyPrefix)) {
        return prefixFailure(
          LABEL,
          'invalid',
          keyPrefix,
          optionsProblem ??
            'cannot use this prefix: it is not valid Unicode text'
        );
      }
      const read = await readTable(signal);
      if (!read.ok) {
        return prefixFailure(
          LABEL,
          read.code,
          keyPrefix,
          `could not list keys (${read.detail})`
        );
      }
      const keys: string[] = [];
      for (const [key, entry] of read.table.entries) {
        if (!entry.deleted && key.startsWith(keyPrefix)) {
          keys.push(key);
        }
      }
      return { ok: true, value: keys.sort(compareKeys) };
    },

    subscribe(key, onChange) {
      return poller.subscribe(key, onChange);
    },
  } satisfies StorageAdapter;

  /**
   * Writes to one key wait for the one before them, so `ifRevision` is reliable among
   * the writers that share this adapter.
   */
  const queue: KeyedQueue = createKeyedQueue();

  return {
    ...adapter,
    set: (key, value, setOptions) =>
      poller.trackWrite(key, () =>
        queue.run(key, () => adapter.set(key, value, setOptions))
      ),
    remove: (key, removeOptions) =>
      poller.trackWrite(key, () =>
        queue.run(key, () => adapter.remove(key, removeOptions))
      ),
  };
}
