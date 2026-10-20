/**
 * An in-memory stand-in for `rethinkdb-ts`'s `r` and a RethinkDB server, with the
 * behaviour the adapter relies on (from RethinkDB's documentation): `get` of a missing
 * document is `null`; `replace` with a function runs it on the current document (`null`
 * when there is none) and applies the result atomically; `r.error` makes the write answer
 * `{ errors: 1, first_error }` rather than reject; `returnChanges` reports `old_val` and
 * `new_val`; a changefeed delivers `{ old_val, new_val }` for every change to the key;
 * strings compare by code point. Queries are built lazily and run on `run`, as ReQL's are.
 * test/rethinkdb-server.test.ts runs the adapter against a real server.
 */
import type {
  ReqlBuilderLike,
  ReqlCursorLike,
  ReqlDatabaseLike,
  ReqlDatumLike,
  ReqlQueryLike,
  ReqlSelectionLike,
  ReqlStreamLike,
  ReqlTableLike,
} from '../../src/rethinkdb/index.js';

type Doc = Record<string, unknown>;

/** What an expression is worth: a value, or the error `r.error` raised. */
class Datum implements ReqlDatumLike {
  constructor(
    readonly value: unknown,
    readonly failure: string | null = null
  ) {}

  run(): Promise<unknown> {
    return Promise.resolve(this.value);
  }

  private map(compute: (value: unknown) => unknown): Datum {
    if (this.failure !== null) {
      return this;
    }
    try {
      return new Datum(compute(this.value));
    } catch (error: unknown) {
      return new Datum(
        undefined,
        error instanceof Error ? error.message : 'failed'
      );
    }
  }

  eq(other: unknown): Datum {
    const right = unwrap(other);
    return this.map(
      (value) => value === right || (value === null && right === null)
    );
  }

  getField(name: string): Datum {
    return this.map((value) => {
      const record = value as Doc | null;
      if (record === null || typeof record !== 'object' || !(name in record)) {
        throw new Error(`No attribute \`${name}\` in object`);
      }
      return record[name];
    });
  }

  hasFields(...names: string[]): Datum {
    return this.map((value) => {
      const record = value as Doc | null;
      return (
        record !== null &&
        typeof record === 'object' &&
        names.every(
          (name) => record[name] !== undefined && record[name] !== null
        )
      );
    });
  }

  typeOf(): Datum {
    return this.map((value) =>
      value === null
        ? 'NULL'
        : typeof value === 'number'
          ? 'NUMBER'
          : typeof value === 'string'
            ? 'STRING'
            : typeof value === 'boolean'
              ? 'BOOL'
              : 'OBJECT'
    );
  }

  add(other: unknown): Datum {
    const right = unwrap(other);
    return this.map((value) => {
      if (typeof value !== 'number' || typeof right !== 'number') {
        throw new Error(
          `Expected type NUMBER but found ${typeof value === 'string' ? 'STRING' : 'other'}`
        );
      }
      return value + right;
    });
  }

  merge(other: unknown): Datum {
    return this.map((value) => {
      const addition = unwrapDeep(other) as Doc;
      return { ...(value as Doc), ...addition };
    });
  }

  and(...others: unknown[]): Datum {
    return this.map((value) => {
      let result = Boolean(value);
      for (const other of others) {
        result = result && Boolean(unwrap(other));
      }
      return result;
    });
  }
}

/** A failure inside an expression, which only matters if it ends up as the result. */
class Raised {
  constructor(readonly message: string) {}
}

function unwrap(value: unknown): unknown {
  return value instanceof Datum ? value.value : value;
}

/** A plain value with every datum inside it replaced by what it is worth. */
function unwrapDeep(value: unknown): unknown {
  if (value instanceof Datum) {
    if (value.failure !== null) {
      throw new Error(value.failure);
    }
    return value.value;
  }
  if (value instanceof Raised) {
    throw new Error(value.message);
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    !Array.isArray(value)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([name, inner]) => [name, unwrapDeep(inner)])
    );
  }
  return value;
}

const MAXVAL = Symbol('maxval');
const MINVAL = Symbol('minval');

function codePointCompare(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0) ?? 0);
  const right = Array.from(b, (char) => char.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

export interface FakeRun {
  readonly query: string;
  readonly connection: unknown;
}

interface Feed {
  readonly table: string;
  readonly key: string;
  readonly deliver: (change: unknown) => void;
  readonly close: () => void;
}

export class FakeRethinkDb {
  /** Documents by `db.table`, then primary key. */
  readonly tables = new Map<string, Map<string, Doc>>();
  /** Every query that was run, in order. */
  readonly runs: FakeRun[] = [];
  /** Errors to reject the next runs with, in order. */
  readonly failures: Error[] = [];
  /** Runs just before a `replace` is applied, to simulate another writer. */
  beforeReplace: ((table: string, key: string) => void) | null = null;
  /** Milliseconds a write takes to answer, so feeds and writes can overlap. */
  writeLatencyMs = 0;
  private readonly feeds = new Set<Feed>();

  constructor(tables: readonly string[] = []) {
    for (const name of tables) {
      this.tables.set(name, new Map());
    }
  }

  /** Writes behind the adapter's back, as another process would. */
  put(table: string, doc: Doc): void {
    const rows = this.rowsOf(table);
    const key = String(doc.id);
    const old = rows.get(key) ?? null;
    rows.set(key, doc);
    this.emit(table, key, old, doc);
  }

  /** Removes a document behind the adapter's back. */
  remove(table: string, key: string): void {
    const rows = this.rowsOf(table);
    const old = rows.get(key) ?? null;
    rows.delete(key);
    this.emit(table, key, old, null);
  }

  /** Ends every open changefeed, as a lost connection would. */
  dropFeeds(): void {
    for (const feed of [...this.feeds]) {
      feed.close();
    }
  }

  get openFeeds(): number {
    return this.feeds.size;
  }

  private rowsOf(table: string): Map<string, Doc> {
    const rows = this.tables.get(table) ?? new Map<string, Doc>();
    this.tables.set(table, rows);
    return rows;
  }

  private emit(
    table: string,
    key: string,
    oldVal: Doc | null,
    newVal: Doc | null
  ): void {
    for (const feed of this.feeds) {
      if (feed.key === key && feed.table === table) {
        feed.deliver({ old_val: oldVal, new_val: newVal });
      }
    }
  }

  private query(
    text: string,
    execute: () => Promise<unknown> | unknown
  ): ReqlQueryLike {
    return {
      run: async (connection?: unknown) => {
        this.runs.push({ query: text, connection });
        const failure = this.failures.shift();
        if (failure !== undefined) {
          throw failure;
        }
        return execute();
      },
    };
  }

  readonly r: ReqlBuilderLike = {
    db: (dbName: string): ReqlDatabaseLike => ({
      table: (tableName: string) => this.table(`${dbName}.${tableName}`),
      tableList: () =>
        this.query(`tableList ${dbName}`, () =>
          [...this.tables.keys()]
            .filter((name) => name.startsWith(`${dbName}.`))
            .map((name) => name.slice(dbName.length + 1))
        ),
      tableCreate: (tableName: string) =>
        this.query(`tableCreate ${dbName}.${tableName}`, () => {
          if (this.tables.has(`${dbName}.${tableName}`)) {
            throw new Error(`Table \`${dbName}.${tableName}\` already exists`);
          }
          this.tables.set(`${dbName}.${tableName}`, new Map());
          return { tables_created: 1 };
        }),
    }),
    branch: (
      test: unknown,
      whenTrue: unknown,
      whenFalse: unknown
    ): ReqlDatumLike => {
      if (test instanceof Datum && test.failure !== null) {
        return test;
      }
      const chosen = unwrap(test) ? whenTrue : whenFalse;
      if (chosen instanceof Datum) {
        return chosen;
      }
      if (chosen instanceof Raised) {
        return new Datum(undefined, chosen.message);
      }
      return new Datum(chosen);
    },
    error: (message: string) => new Raised(message),
    maxval: MAXVAL,
    minval: MINVAL,
  };

  private table(name: string): ReqlTableLike {
    const stream = (select: () => Doc[], text: string): ReqlStreamLike => ({
      pluck: (...fields: string[]) =>
        this.query(`${text}.pluck(${fields.join(',')})`, () =>
          select().map((doc) =>
            Object.fromEntries(fields.map((field) => [field, doc[field]]))
          )
        ),
      run: (connection?: unknown) =>
        this.query(text, () => select()).run(connection),
    });
    return {
      ...stream(() => [...this.rowsOf(name).values()], `table ${name}`),
      get: (key: string): ReqlSelectionLike => this.selection(name, key),
      between: (low: unknown, high: unknown) =>
        stream(
          () =>
            [...this.rowsOf(name).values()]
              .filter((doc) => {
                const id = String(doc.id);
                return (
                  (low === MINVAL || codePointCompare(id, String(low)) >= 0) &&
                  (high === MAXVAL || codePointCompare(id, String(high)) < 0)
                );
              })
              .sort((a, b) => codePointCompare(String(a.id), String(b.id))),
          `table ${name}.between(${String(low)}, ${typeof high === 'symbol' ? 'maxval' : String(high)})`
        ),
      wait: () => this.query(`wait ${name}`, () => ({ ready: 1 })),
    };
  }

  private selection(table: string, key: string): ReqlSelectionLike {
    const text = `table ${table}.get(${key})`;
    return {
      run: (connection?: unknown) =>
        this.query(text, () => this.rowsOf(table).get(key) ?? null).run(
          connection
        ),
      delete: () =>
        this.query(`${text}.delete()`, async () => {
          const rows = this.rowsOf(table);
          const old = rows.get(key) ?? null;
          rows.delete(key);
          this.emit(table, key, old, null);
          await this.later();
          return { deleted: old === null ? 0 : 1, errors: 0 };
        }),
      replace: (func, options) =>
        this.query(`${text}.replace()`, async () => {
          this.beforeReplace?.(table, key);
          const rows = this.rowsOf(table);
          const old = rows.get(key) ?? null;
          const outcome = func(new Datum(old));
          let next: unknown;
          try {
            next = unwrapDeep(outcome);
          } catch (error: unknown) {
            return {
              errors: 1,
              first_error: `Runtime error: ${error instanceof Error ? error.message : 'failed'}`,
            };
          }
          rows.set(key, next as Doc);
          this.emit(table, key, old, next as Doc);
          await this.later();
          return {
            errors: 0,
            inserted: old === null ? 1 : 0,
            replaced: old === null ? 0 : 1,
            ...(options?.returnChanges === true
              ? { changes: [{ old_val: old, new_val: next }] }
              : {}),
          };
        }),
      changes: () =>
        this.query(`${text}.changes()`, () => this.openFeed(table, key)),
    };
  }

  private later(): Promise<void> {
    return this.writeLatencyMs > 0
      ? new Promise((resolve) => setTimeout(resolve, this.writeLatencyMs))
      : Promise.resolve();
  }

  private openFeed(table: string, key: string): ReqlCursorLike {
    let callback:
      ((error: Error | undefined, change: unknown) => unknown) | null = null;
    let finish: (() => void) | null = null;
    const buffered: unknown[] = [];
    let closed = false;
    const feed: Feed = {
      table,
      key,
      deliver: (change) => {
        if (callback === null) {
          buffered.push(change);
        } else {
          callback(undefined, change);
        }
      },
      close: () => {
        closed = true;
        this.feeds.delete(feed);
        finish?.();
      },
    };
    this.feeds.add(feed);
    return {
      each: (cb) =>
        new Promise<unknown>((resolve) => {
          callback = cb;
          finish = () => resolve(undefined);
          for (const change of buffered.splice(0)) {
            cb(undefined, change);
          }
          if (closed) {
            resolve(undefined);
          }
        }),
      close: () => {
        feed.close();
        return Promise.resolve();
      },
    };
  }
}
