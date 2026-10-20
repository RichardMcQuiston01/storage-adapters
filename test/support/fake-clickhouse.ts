/**
 * An in-memory stand-in for ClickHouse's HTTP interface, with the behaviour the adapter
 * relies on (checked against a real ClickHouse engine): the statement is the request
 * body, a `SELECT ... FORMAT JSON` answers `{ "data": [...] }` with 64-bit integers
 * quoted as strings, an aggregate query without `GROUP BY` always yields one row, a
 * `HAVING` that fails makes an `INSERT ... SELECT` write nothing, and a missing table
 * is an error. Statements are recognised by their text.
 * test/clickhouse-server.test.ts runs the adapter against a real server.
 */
import type { ClickHouseFetch } from '../../src/clickhouse/index.js';

interface FakeRow {
  entryKey: string;
  entryValue: string;
  revision: bigint;
  writer: string;
  deleted: number;
}

/** A failure to answer with instead of the real answer. */
export type FakeFailure =
  | { readonly status: number; readonly body: string }
  | { readonly throws: Error };

export interface FakeRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

const STRING = String.raw`'([^'\\]*(?:\\.[^'\\]*)*)'`;

/** The text a ClickHouse string literal stands for. */
function unquote(literal: string): string {
  return literal.replace(/\\(.)/g, (_, char: string) => {
    switch (char) {
      case '0':
        return '\0';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      default:
        return char;
    }
  });
}

function stringsIn(list: string): string[] {
  return [...list.matchAll(new RegExp(STRING, 'g'))].map((match) =>
    unquote(match[1] ?? '')
  );
}

function response(status: number, body: string): Response {
  return new Response(body, { status });
}

export class FakeClickHouse {
  readonly tables = new Map<string, FakeRow[]>();
  readonly requests: FakeRequest[] = [];
  /** Failures to answer the next requests with, in order. */
  readonly failures: FakeFailure[] = [];
  /** Runs just before an insert is evaluated, to simulate another writer. */
  beforeInsert: ((table: string, key: string) => void) | null = null;
  /** Runs just after an insert wrote its row, to simulate a write that raced it. */
  afterInsert: ((table: string, key: string) => void) | null = null;
  /** The databases that exist. */
  readonly databases = new Set<string>(['default']);

  /** Writes behind the adapter's back, as another process would. */
  put(
    table: string,
    key: string,
    value: string,
    revision: bigint,
    writer = 'other',
    deleted = 0
  ): void {
    const rows = this.tables.get(table) ?? [];
    this.tables.set(table, rows);
    rows.push({ entryKey: key, entryValue: value, revision, writer, deleted });
  }

  /** The rows stored for a key, oldest first. */
  rowsFor(table: string, key: string): readonly FakeRow[] {
    return (this.tables.get(table) ?? []).filter((row) => row.entryKey === key);
  }

  readonly fetch: ClickHouseFetch = (url, init) => {
    this.requests.push({ url, body: init.body ?? '', headers: init.headers });
    const failure: FakeFailure | undefined = this.failures.shift();
    if (failure !== undefined) {
      if ('throws' in failure) {
        return Promise.reject(failure.throws);
      }
      return Promise.resolve(response(failure.status, failure.body));
    }
    if (init.signal.aborted) {
      return Promise.reject(new Error('aborted'));
    }
    return Promise.resolve(this.handle(init.body ?? ''));
  };

  private missing(name: string): Response {
    const [database] = name.split('.');
    return response(
      404,
      this.databases.has(database ?? '')
        ? `Code: 60. DB::Exception: Table ${name} does not exist. (UNKNOWN_TABLE)\n`
        : `Code: 81. DB::Exception: Database ${database ?? ''} does not exist. (UNKNOWN_DATABASE)\n`
    );
  }

  private handle(body: string): Response {
    const text: string = body.trim();
    const created = /^CREATE TABLE IF NOT EXISTS `(\w+)`\.`(\w+)` /.exec(text);
    if (created !== null) {
      const name = `${created[1] ?? ''}.${created[2] ?? ''}`;
      if (!this.databases.has(created[1] ?? '')) {
        return this.missing(name);
      }
      if (!this.tables.has(name)) {
        this.tables.set(name, []);
      }
      return response(200, '');
    }
    const select =
      /^SELECT (entry_key, )?argMax\(entry_value, revision\) AS latest_value, max\(revision\) AS latest_revision, argMax\(writer, revision\) AS latest_writer, argMax\(deleted, revision\) AS latest_deleted FROM `(\w+)`\.`(\w+)` WHERE entry_key (?:= (.*)|IN \((.*)\)) GROUP BY entry_key FORMAT JSON$/s.exec(
        text
      );
    if (select !== null) {
      const name = `${select[2] ?? ''}.${select[3] ?? ''}`;
      const rows = this.tables.get(name);
      if (rows === undefined) {
        return this.missing(name);
      }
      const keys: string[] = stringsIn(select[4] ?? select[5] ?? '');
      const data = keys
        .map((key) => this.newest(rows, key))
        .filter((row): row is FakeRow => row !== undefined)
        .map((row) => ({
          ...(select[1] === undefined ? {} : { entry_key: row.entryKey }),
          latest_value: row.entryValue,
          latest_revision: String(row.revision),
          latest_writer: row.writer,
          latest_deleted: row.deleted,
        }));
      return response(200, JSON.stringify({ data, rows: data.length }));
    }
    const insert = new RegExp(
      String.raw`^INSERT INTO \`(\w+)\`\.\`(\w+)\` \(entry_key, entry_value, revision, writer, deleted, updated_at\) SELECT ${STRING}, ${STRING}, intDiv\(max\(revision\), (\d+)\) \* \d+ \+ (\d+), ${STRING}, (\d), now64\(3\) FROM \`\w+\`\.\`\w+\` WHERE entry_key = ${STRING}(?: HAVING (.*))?$`,
      's'
    ).exec(text);
    if (insert !== null) {
      const name = `${insert[1] ?? ''}.${insert[2] ?? ''}`;
      const rows = this.tables.get(name);
      if (rows === undefined) {
        return this.missing(name);
      }
      const key: string = unquote(insert[3] ?? '');
      this.beforeInsert?.(name, key);
      const newest: FakeRow | undefined = this.newest(rows, key);
      const maxRevision: bigint = rows
        .filter((row) => row.entryKey === key)
        .reduce((most, row) => (row.revision > most ? row.revision : most), 0n);
      const count: number = rows.filter((row) => row.entryKey === key).length;
      const having: string = insert[10] ?? '';
      let passes = true;
      if (having === 'count() > 0 AND argMax(deleted, revision) = 0') {
        passes = count > 0 && newest?.deleted === 0;
      } else if (having !== '') {
        const expected = new RegExp(
          String.raw`^count\(\) = 0 OR argMax\(deleted, revision\) = 1 OR toString\(max\(revision\)\) = ${STRING}$`
        ).exec(having);
        if (expected === null) {
          return response(
            400,
            `Code: 62. DB::Exception: cannot parse ${having}`
          );
        }
        passes =
          count === 0 ||
          newest?.deleted === 1 ||
          String(maxRevision) === unquote(expected[1] ?? '');
      }
      if (passes) {
        const size = BigInt(insert[5] ?? '1');
        const step = BigInt(insert[6] ?? '1');
        rows.push({
          entryKey: key,
          entryValue: unquote(insert[4] ?? ''),
          revision: (maxRevision / size) * size + step,
          writer: unquote(insert[7] ?? ''),
          deleted: Number(insert[8] ?? '0'),
        });
        this.afterInsert?.(name, key);
      }
      return response(200, '');
    }
    const list = new RegExp(
      String.raw`^SELECT entry_key FROM \`(\w+)\`\.\`(\w+)\`(?: WHERE startsWith\(entry_key, ${STRING}\))? GROUP BY entry_key HAVING argMax\(deleted, revision\) = 0 FORMAT JSON$`
    ).exec(text);
    if (list !== null) {
      const name = `${list[1] ?? ''}.${list[2] ?? ''}`;
      const rows = this.tables.get(name);
      if (rows === undefined) {
        return this.missing(name);
      }
      const prefix: string = unquote(list[3] ?? '');
      const keys = new Set(rows.map((row) => row.entryKey));
      const data = [...keys]
        .filter((key) => key.startsWith(prefix))
        .filter((key) => this.newest(rows, key)?.deleted === 0)
        .map((key) => ({ entry_key: key }));
      return response(200, JSON.stringify({ data, rows: data.length }));
    }
    return response(
      400,
      `Code: 62. DB::Exception: the fake does not understand: ${text.slice(0, 120)}\n`
    );
  }

  /** The row with the highest revision for a key. */
  private newest(rows: readonly FakeRow[], key: string): FakeRow | undefined {
    let best: FakeRow | undefined;
    for (const row of rows) {
      if (
        row.entryKey === key &&
        (best === undefined || row.revision >= best.revision)
      ) {
        best = row;
      }
    }
    return best;
  }
}
