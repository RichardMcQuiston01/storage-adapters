/**
 * An in-memory stand-in for the Google Sheets `spreadsheets.values` API, with the
 * behaviour the adapter relies on: ranges are A1 notation with a quoted tab name, a read
 * of a range returns rows from the first row of the range with trailing empty cells and
 * trailing empty rows left out, an unknown tab is a 400 "Unable to parse range", `RAW`
 * input is stored exactly as sent, a cell over 50,000 characters is refused, and an
 * append answers with the range of the row it wrote. Hand edits are made with `setRow`
 * (which can store numbers and booleans, as typing into a cell does).
 * test/google-sheets-live.test.ts runs the adapter against a real spreadsheet.
 */
import type {
  SheetsAppendParamsLike,
  SheetsClearParamsLike,
  SheetsClientLike,
  SheetsGetParamsLike,
  SheetsRequestOptionsLike,
  SheetsUpdateParamsLike,
} from '../../src/google-sheets/index.js';

type Cell = string | number | boolean;

/** The error the Google client throws: a message and an HTTP status in `code`. */
export class FakeSheetsError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
  }
}

export interface FakeSheetsRequest {
  readonly operation: 'get' | 'update' | 'append' | 'clear';
  readonly range: string;
  readonly params: unknown;
  readonly options: SheetsRequestOptionsLike | undefined;
}

/** Parses `'my tab'!A12:E12` into the tab name and the cells part. */
function parseRange(range: string): { tab: string; cells: string } | null {
  const quoted: RegExpMatchArray | null = range.match(
    /^'((?:[^']|'')*)'!(.+)$/
  );
  if (quoted !== null) {
    return {
      tab: (quoted[1] ?? '').replace(/''/g, "'"),
      cells: quoted[2] ?? '',
    };
  }
  const bare: RegExpMatchArray | null = range.match(/^([^!']+)!(.+)$/);
  return bare === null ? null : { tab: bare[1] ?? '', cells: bare[2] ?? '' };
}

function columnNumber(letters: string): number {
  let result = 0;
  for (const letter of letters) {
    result = result * 26 + (letter.charCodeAt(0) - 64);
  }
  return result;
}

/** The first and last column and row of `A:E`, `A1:E1` or `A12:E12`; rows are optional. */
function parseCells(cells: string): {
  firstColumn: number;
  lastColumn: number;
  firstRow: number | null;
  lastRow: number | null;
} | null {
  const match: RegExpMatchArray | null = cells.match(
    /^([A-Z]+)(\d*):([A-Z]+)(\d*)$/
  );
  if (match === null) {
    return null;
  }
  return {
    firstColumn: columnNumber(match[1] ?? ''),
    lastColumn: columnNumber(match[3] ?? ''),
    firstRow: match[2] === '' ? null : Number(match[2]),
    lastRow: match[4] === '' ? null : Number(match[4]),
  };
}

export class FakeSheets {
  /** Every tab's rows; each row is a list of cells, `''` standing for an empty cell. */
  readonly tabs = new Map<string, Cell[][]>();
  readonly requests: FakeSheetsRequest[] = [];
  /** Runs before each request is applied; a test uses it to play another writer. */
  before: ((request: FakeSheetsRequest) => void | Promise<void>) | null = null;
  /** The errors to throw for the next requests, oldest first. */
  readonly failures: Error[] = [];

  constructor(tabNames: readonly string[] = ['storage_entry']) {
    for (const name of tabNames) {
      this.tabs.set(name, []);
    }
  }

  /** The rows of a tab as text, empty rows and trailing empty cells included. */
  rows(tab = 'storage_entry'): string[][] {
    return (this.tabs.get(tab) ?? []).map((row) => row.map(String));
  }

  /** Replaces a row as typing into the sheet would: numbers and booleans stay as such. */
  setRow(tab: string, rowNumber: number, cells: readonly Cell[]): void {
    const rows: Cell[][] = this.tabs.get(tab) ?? [];
    while (rows.length < rowNumber) {
      rows.push([]);
    }
    rows[rowNumber - 1] = [...cells];
    this.tabs.set(tab, rows);
  }

  private async enter(
    operation: FakeSheetsRequest['operation'],
    params: { range: string },
    options: SheetsRequestOptionsLike | undefined
  ): Promise<{
    rows: Cell[][];
    cells: NonNullable<ReturnType<typeof parseCells>>;
  }> {
    const request: FakeSheetsRequest = {
      operation,
      range: params.range,
      params,
      options,
    };
    this.requests.push(request);
    await this.before?.(request);
    const failure: Error | undefined = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    const parsed = parseRange(params.range);
    const rows: Cell[][] | undefined =
      parsed === null ? undefined : this.tabs.get(parsed.tab);
    const cells = parsed === null ? null : parseCells(parsed.cells);
    if (parsed === null || rows === undefined || cells === null) {
      throw new FakeSheetsError(`Unable to parse range: ${params.range}`, 400);
    }
    return { rows, cells };
  }

  private static check(values: readonly (readonly string[])[]): void {
    for (const row of values) {
      for (const cell of row) {
        if (cell.length > 50_000) {
          throw new FakeSheetsError(
            `Your input contains more than the maximum of 50000 characters in a single cell.`,
            400
          );
        }
      }
    }
  }

  readonly client: SheetsClientLike = {
    spreadsheets: {
      values: {
        get: async (
          params: SheetsGetParamsLike,
          options?: SheetsRequestOptionsLike
        ) => {
          const { rows, cells } = await this.enter('get', params, options);
          const first: number = cells.firstRow ?? 1;
          const last: number = cells.lastRow ?? rows.length;
          const out: Cell[][] = [];
          for (let number = first; number <= last; number += 1) {
            const row: Cell[] = (rows[number - 1] ?? []).slice(
              cells.firstColumn - 1,
              cells.lastColumn
            );
            while (row.length > 0 && row[row.length - 1] === '') {
              row.pop();
            }
            out.push(row);
          }
          while (out.length > 0 && out[out.length - 1]?.length === 0) {
            out.pop();
          }
          return { data: { values: out.length === 0 ? null : out } };
        },

        update: async (
          params: SheetsUpdateParamsLike,
          options?: SheetsRequestOptionsLike
        ) => {
          const { rows, cells } = await this.enter('update', params, options);
          FakeSheets.check(params.requestBody.values);
          const start: number = cells.firstRow ?? 1;
          for (const [offset, values] of params.requestBody.values.entries()) {
            const index: number = start + offset - 1;
            while (rows.length <= index) {
              rows.push([]);
            }
            const row: Cell[] = rows[index] ?? [];
            while (row.length < cells.firstColumn - 1) {
              row.push('');
            }
            row.splice(cells.firstColumn - 1, values.length, ...values);
            rows[index] = row;
          }
          return {};
        },

        append: async (
          params: SheetsAppendParamsLike,
          options?: SheetsRequestOptionsLike
        ) => {
          const { rows, cells } = await this.enter('append', params, options);
          FakeSheets.check(params.requestBody.values);
          let end: number = rows.length;
          while (
            end > 0 &&
            (rows[end - 1] ?? []).every((cell) => cell === '')
          ) {
            end -= 1;
          }
          const parsed = parseRange(params.range);
          const tab: string = (parsed?.tab ?? '').split("'").join("''");
          const added = params.requestBody.values.length;
          rows.splice(
            end,
            0,
            ...params.requestBody.values.map((row) => [...row])
          );
          const last: string = String.fromCharCode(64 + cells.lastColumn);
          return {
            data: {
              updates: {
                updatedRange: `'${tab}'!A${String(end + 1)}:${last}${String(end + added)}`,
              },
            },
          };
        },

        clear: async (
          params: SheetsClearParamsLike,
          options?: SheetsRequestOptionsLike
        ) => {
          const { rows, cells } = await this.enter('clear', params, options);
          const first: number = cells.firstRow ?? 1;
          const last: number = cells.lastRow ?? rows.length;
          for (let number = first; number <= last; number += 1) {
            if (rows[number - 1] !== undefined) {
              rows[number - 1] = [];
            }
          }
          return {};
        },
      },
    },
  };
}
