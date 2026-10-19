/**
 * An in-memory stand-in for a Cassandra client, with the behaviour the adapter relies on
 * (checked against a real Cassandra 5.0 node): conditional statements answer with an
 * `[applied]` row, a refused `INSERT ... IF NOT EXISTS` or `UPDATE ... IF revision = ?`
 * also carries the row's current revision, a refused `UPDATE` of a missing row carries
 * nothing else, `bigint` columns come back as objects that print as digits, and a paged
 * `SELECT` hands out a `pageState`. Statements are recognised by their text.
 * test/cassandra-server.test.ts runs the adapter against a real node.
 */
import type {
  CassandraClientLike,
  CassandraExecuteOptions,
  CassandraResultLike,
} from '../../src/cassandra/index.js';

/** Prints as digits, like the `Long` the real driver returns for a `bigint`. */
class FakeLong {
  constructor(readonly value: number) {}
  toString(): string {
    return String(this.value);
  }
}

interface FakeRow {
  entryValue: string | null;
  revision: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** An error shaped like the driver's `ResponseError`. */
export class FakeResponseError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
  }
}

export class FakeCassandra implements CassandraClientLike {
  readonly tables = new Map<string, Map<string, FakeRow>>();
  /** Each statement's first word and table, with its consistency, in order. */
  readonly statements: { query: string; consistency: number | undefined }[] =
    [];
  /** Errors to throw from the next statements, in order. */
  readonly failures: Error[] = [];
  /** Runs just before a conditional write is applied, to simulate another writer. */
  beforeWrite: ((table: string, key: string) => void) | null = null;
  /** When false, revisions come back as plain numbers instead of `Long`-like objects. */
  longRevisions = true;
  pageSize = 1000;

  constructor(tables: readonly string[] = []) {
    for (const name of tables) {
      this.tables.set(name, new Map());
    }
  }

  /** Writes behind the adapter's back, as another process would. */
  put(
    table: string,
    key: string,
    value: string,
    revision: number | null
  ): void {
    const rows = this.tables.get(table) ?? new Map<string, FakeRow>();
    this.tables.set(table, rows);
    rows.set(key, {
      entryValue: value,
      revision,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  /** Removes a row behind the adapter's back. */
  delete(table: string, key: string): void {
    this.tables.get(table)?.delete(key);
  }

  private revisionCell(revision: number | null): unknown {
    if (revision === null) {
      return null;
    }
    return this.longRevisions ? new FakeLong(revision) : revision;
  }

  private tableFor(name: string): Map<string, FakeRow> {
    const rows = this.tables.get(name);
    if (rows === undefined) {
      throw new FakeResponseError(
        `table ${name.split('.').pop() ?? name} does not exist`,
        0x2200
      );
    }
    return rows;
  }

  execute(
    query: string,
    params: readonly unknown[],
    options: CassandraExecuteOptions
  ): Promise<CassandraResultLike> {
    this.statements.push({ query, consistency: options.consistency });
    try {
      const failure: Error | undefined = this.failures.shift();
      if (failure !== undefined) {
        throw failure;
      }
      return Promise.resolve(this.run(query, params, options));
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new Error('failed')
      );
    }
  }

  private run(
    query: string,
    params: readonly unknown[],
    options: CassandraExecuteOptions
  ): CassandraResultLike {
    const text = query.replace(/\s+/g, ' ').trim();
    const created = /^CREATE TABLE IF NOT EXISTS (\S+) /.exec(text);
    if (created !== null) {
      const name = created[1] ?? '';
      if (!this.tables.has(name)) {
        this.tables.set(name, new Map());
      }
      return { rows: [] };
    }
    const key = String(params[0]);
    const select =
      /^SELECT entry_value, revision FROM (\S+) WHERE entry_key = \?$/.exec(
        text
      );
    if (select !== null) {
      const row = this.tableFor(select[1] ?? '').get(key);
      return {
        rows:
          row === undefined
            ? []
            : [
                {
                  entry_value: row.entryValue,
                  revision: this.revisionCell(row.revision),
                },
              ],
      };
    }
    const insert =
      /^INSERT INTO (\S+) \(entry_key, entry_value, revision, created_at, updated_at\) VALUES \(\?, \?, \?, \?, \?\) IF NOT EXISTS$/.exec(
        text
      );
    if (insert !== null) {
      const name = insert[1] ?? '';
      const rows = this.tableFor(name);
      if (key === '') {
        throw new FakeResponseError('Key may not be empty', 0x2200);
      }
      this.beforeWrite?.(name, key);
      const existing = rows.get(key);
      if (existing !== undefined) {
        return {
          rows: [
            {
              '[applied]': false,
              entry_key: key,
              entry_value: existing.entryValue,
              revision: this.revisionCell(existing.revision),
            },
          ],
        };
      }
      rows.set(key, {
        entryValue: String(params[1]),
        revision: Number(String(params[2])),
        createdAt: params[3] as Date,
        updatedAt: params[4] as Date,
      });
      return { rows: [{ '[applied]': true }] };
    }
    const update =
      /^UPDATE (\S+) SET entry_value = \?, revision = \?, updated_at = \? WHERE entry_key = \? IF revision = \?$/.exec(
        text
      );
    if (update !== null) {
      const name = update[1] ?? '';
      const rows = this.tableFor(name);
      const target = String(params[3]);
      this.beforeWrite?.(name, target);
      const existing = rows.get(target);
      if (existing === undefined) {
        return { rows: [{ '[applied]': false }] };
      }
      if (existing.revision !== Number(String(params[4]))) {
        return {
          rows: [
            {
              '[applied]': false,
              revision: this.revisionCell(existing.revision),
            },
          ],
        };
      }
      existing.entryValue = String(params[0]);
      existing.revision = Number(String(params[1]));
      existing.updatedAt = params[2] as Date;
      return { rows: [{ '[applied]': true }] };
    }
    const remove = /^DELETE FROM (\S+) WHERE entry_key = \? IF EXISTS$/.exec(
      text
    );
    if (remove !== null) {
      const rows = this.tableFor(remove[1] ?? '');
      return { rows: [{ '[applied]': rows.delete(key) }] };
    }
    const list = /^SELECT entry_key FROM (\S+)$/.exec(text);
    if (list !== null) {
      const names = [...this.tableFor(list[1] ?? '').keys()];
      const start =
        options.pageState === undefined ? 0 : Number(options.pageState);
      const size = Math.min(options.fetchSize ?? Infinity, this.pageSize);
      const page = names.slice(start, start + size);
      const next = start + size;
      return {
        rows: page.map((entryKey) => ({ entry_key: entryKey })),
        pageState: next < names.length ? String(next) : null,
      };
    }
    const many =
      /^SELECT entry_key, entry_value, revision FROM (\S+) WHERE entry_key IN \?$/.exec(
        text
      );
    if (many !== null) {
      const rows = this.tableFor(many[1] ?? '');
      const wanted = new Set(params[0] as string[]);
      return {
        rows: [...rows.entries()]
          .filter(([entryKey]) => wanted.has(entryKey))
          .map(([entryKey, row]) => ({
            entry_key: entryKey,
            entry_value: row.entryValue,
            revision: this.revisionCell(row.revision),
          })),
      };
    }
    throw new FakeResponseError(
      `the fake does not understand: ${text}`,
      0x2000
    );
  }
}
