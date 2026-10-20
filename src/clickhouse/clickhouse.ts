/**
 * A `StorageAdapter` over ClickHouse's HTTP interface. Like `/influxdb`, `/couchdb` and
 * `/arangodb`, this is an optional entry point that imports nothing: you pass in the
 * `fetch` to use, so this file never touches the network itself.
 *
 * ClickHouse is an analytical database, not a key-value store: it has no transactions
 * and no way to check a revision atomically. This adapter appends a row for every write
 * and reads the newest one. See `clickHouseAdapter` for what that costs.
 */
import { describeUnknownError } from '../errors.js';
import type { FetchLike, FetchResponseLike } from '../rest/rest.js';
import { createChangePoller } from '../change-poller.js';
import { sqlFailure } from '../sql-shared.js';
import {
  compareKeys,
  prefixFailure,
  utf8Length,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** The `fetch` this adapter sends requests with. The global `fetch` fits. */
export type ClickHouseFetch = FetchLike;

export type ClickHouseHeaders = Readonly<Record<string, string>>;

/** ClickHouse settings sent with every request, for example `{ insert_quorum: 'auto' }`. */
export type ClickHouseSettings = Readonly<
  Record<string, string | number | boolean>
>;

export interface ClickHouseAdapterOptions {
  /** The server's HTTP address, for example `http://127.0.0.1:8123`. No trailing slash needed. */
  readonly url: string;
  /** The `fetch` to send requests with. */
  readonly fetch: ClickHouseFetch;
  /** The database that holds the table. It must already exist. Defaults to `default`. */
  readonly database?: string;
  /** The table that holds the entries. Letters, digits and underscores. Defaults to `storage_entry`. */
  readonly table?: string;
  /**
   * Create the table before first use if it is not there. Defaults to true. Turn it
   * off for an account that may not create tables; the table then needs the columns
   * `entry_key String, entry_value String, revision UInt64, writer String,
   * deleted UInt8, updated_at DateTime64(3)` and `ReplacingMergeTree(revision)`
   * ordered by `entry_key`.
   */
  readonly createTable?: boolean;
  /**
   * Sent with every request, for example `Authorization: Basic ...` or
   * `X-ClickHouse-User` and `X-ClickHouse-Key`. A function is called for each
   * request, so a credential can be refreshed; it may be async.
   */
  readonly headers?:
    ClickHouseHeaders | (() => ClickHouseHeaders | Promise<ClickHouseHeaders>);
  /**
   * ClickHouse settings added to every request. On a replicated cluster, a write is
   * only certain to be seen by the next read with `insert_quorum` and
   * `select_sequential_consistency` set (see ClickHouse's documentation).
   */
  readonly settings?: ClickHouseSettings;
  /**
   * Milliseconds between looks at the subscribed keys for changes other processes made
   * (at least 50). ClickHouse cannot announce changes to a plain HTTP client, so
   * `subscribe` hears only this adapter's own writes unless you give this. Off by default.
   */
  readonly pollIntervalMs?: number;
  /** Called once per run of failed polls, with a message naming the table. */
  readonly onPollError?: (message: string) => void;
}

const LABEL = 'ClickHouse';
const DEFAULT_DATABASE = 'default';
const DEFAULT_TABLE = 'storage_entry';
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_KEY_BYTES = 1024;
/** Values travel inside the SQL text; this keeps it well under what a server accepts. */
const MAX_VALUE_BYTES = 4_000_000;
/** ClickHouse refuses SQL over `max_query_size` (256 KiB by default); requests raise it as needed. */
const DEFAULT_MAX_QUERY_SIZE = 262_144;
const MAX_DETAIL_LENGTH = 200;
/** Revisions count up in steps of this many; the low bits are random, so two writers racing differ. */
const REVISION_STEP = 1_048_576;

/** A string literal: backslash, quote and control characters are escaped. */
function sqlString(text: string): string {
  return `'${text.replace(/[\\'\0\n\r\t\b\f]/g, (char) => {
    switch (char) {
      case '\0':
        return '\\0';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      default:
        return `\\${char}`;
    }
  })}'`;
}

function hasLoneSurrogate(text: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    text
  );
}

function recordOf(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** What ClickHouse said went wrong: the start of its message. */
function detailOf(text: string): string {
  const said: string = text.trim().replace(/\s+/g, ' ');
  return said.length > MAX_DETAIL_LENGTH
    ? `${said.slice(0, MAX_DETAIL_LENGTH)}...`
    : said;
}

function classifyFailure(status: number, detail: string): StoreErrorCode {
  if (
    status === 401 ||
    status === 403 ||
    /Code: (194|497|516)\b/.test(detail)
  ) {
    return 'forbidden';
  }
  if (status === 413 || /Max query size exceeded/i.test(detail)) {
    return 'invalid';
  }
  if (status === 400 && /Code: (62|27|53|6)\b/.test(detail)) {
    return 'invalid';
  }
  return 'unavailable';
}

type Reply =
  | { readonly ok: true; readonly status: number; readonly text: string }
  | {
      readonly ok: false;
      readonly code: StoreErrorCode;
      readonly detail: string;
    };

type Row = Record<string, unknown>;

interface Latest {
  readonly value: string;
  readonly revision: string;
  readonly writer: string;
  readonly deleted: boolean;
}

/** The numeric or string cell of a row as text; `undefined` if it is neither. */
function cellText(cell: unknown): string | undefined {
  if (typeof cell === 'string') {
    return cell;
  }
  return typeof cell === 'number' || typeof cell === 'bigint'
    ? String(cell)
    : undefined;
}

function latestFrom(row: Row): Latest | undefined {
  const value: unknown = row.latest_value;
  const revision: string | undefined = cellText(row.latest_revision);
  const writer: unknown = row.latest_writer;
  const deleted: string | undefined = cellText(row.latest_deleted);
  if (
    typeof value !== 'string' ||
    revision === undefined ||
    !/^\d+$/.test(revision) ||
    typeof writer !== 'string' ||
    deleted === undefined
  ) {
    return undefined;
  }
  return { value, revision, writer, deleted: deleted !== '0' };
}

/** A token that tells this write's row from any other writer's. */
function newWriter(): string {
  const random: string = Math.floor(Math.random() * 0xffffffffffff)
    .toString(16)
    .padStart(12, '0');
  return `${String(Date.now())}-${random}`;
}

/**
 * A `StorageAdapter` over ClickHouse. Each write appends a row (key, value, revision, a
 * token naming the writer, and a deleted flag) to a `ReplacingMergeTree` table, and a
 * read takes the row with the highest revision. A write without `ifRevision` is one
 * statement that gives the entry the next revision; `remove` appends a row marked
 * deleted.
 *
 * ClickHouse has no transactions, so a revision cannot be checked atomically. `set` with
 * `ifRevision` runs one statement that inserts only if the key's newest revision is the
 * expected one, then reads back to see whether its row won. That narrows the window to
 * the moment between ClickHouse reading the key and storing the row: two processes that
 * write the same key at the same instant can both be told they succeeded, and the one
 * with the lower revision is lost, as in last-write-wins. (Writes made through one
 * adapter object wait for each other, so among them the check holds.) Use this adapter
 * where one process writes a key at a time, or accept that.
 *
 * Because rows are appended, the table keeps old versions until ClickHouse merges them,
 * and removed keys keep one small row marked deleted; neither affects what you read.
 * `list` reads the table's keys that start with the prefix. `subscribe` reports this
 * adapter's own writes and, with `pollIntervalMs`, changes other processes make. Nothing
 * throws: every failure, a network error included, is a `StoreResult`.
 */
export function clickHouseAdapter(
  options: ClickHouseAdapterOptions
): StorageAdapter {
  const baseUrl: string = options.url.replace(/\/+$/, '');
  const database: string = options.database ?? DEFAULT_DATABASE;
  const table: string = options.table ?? DEFAULT_TABLE;
  const namesAreSafe: boolean =
    NAME_PATTERN.test(database) && NAME_PATTERN.test(table);
  const target = `\`${database}\`.\`${table}\``;
  const where = `table "${table}" in database "${database}"`;
  const latest =
    'argMax(entry_value, revision) AS latest_value, max(revision) AS latest_revision, argMax(writer, revision) AS latest_writer, argMax(deleted, revision) AS latest_deleted';

  const headersFor = async (): Promise<Record<string, string>> => {
    const configured: ClickHouseHeaders | undefined =
      typeof options.headers === 'function'
        ? await options.headers()
        : options.headers;
    return { 'Content-Type': 'text/plain; charset=utf-8', ...configured };
  };

  /** Sends one statement. A network failure becomes a result, so callers only branch on it. */
  const send = async (sql: string, signal: AbortSignal): Promise<Reply> => {
    const settings: Record<string, string> = {
      wait_end_of_query: '1',
      max_query_size: String(
        Math.max(DEFAULT_MAX_QUERY_SIZE, utf8Length(sql) + 1024)
      ),
    };
    for (const [name, setting] of Object.entries(options.settings ?? {})) {
      settings[name] = String(setting);
    }
    const query: string = Object.entries(settings)
      .map(
        ([name, setting]) =>
          `${encodeURIComponent(name)}=${encodeURIComponent(setting)}`
      )
      .join('&');
    try {
      const response: FetchResponseLike = await options.fetch(
        `${baseUrl}/?${query}`,
        { method: 'POST', headers: await headersFor(), body: sql, signal }
      );
      return { ok: true, status: response.status, text: await response.text() };
    } catch (error: unknown) {
      return {
        ok: false,
        code: 'unavailable',
        detail: signal.aborted
          ? 'request was aborted'
          : `could not be reached (${describeUnknownError(error)})`,
      };
    }
  };

  /** Describes a reply that was not a success. */
  const failureOf = (
    reply: Reply
  ): { readonly code: StoreErrorCode; readonly detail: string } => {
    if (!reply.ok) {
      return { code: reply.code, detail: reply.detail };
    }
    const said: string = detailOf(reply.text);
    let advice = '';
    if (/Code: (60|81)\b/.test(said)) {
      advice = `; check that the ${where} exists (or leave createTable on)`;
    } else if (/Code: (194|497|516)\b/.test(said) || reply.status === 401) {
      advice = '; check the credentials sent in headers';
    }
    return {
      code: classifyFailure(reply.status, said),
      detail: `HTTP ${String(reply.status)}${said === '' ? '' : `: ${said}`}${advice}`,
    };
  };

  /** Runs a statement and returns its rows (a `SELECT ... FORMAT JSON`), or what went wrong. */
  const run = async (
    sql: string,
    signal: AbortSignal
  ): Promise<
    | { readonly ok: true; readonly rows: readonly Row[] }
    | {
        readonly ok: false;
        readonly code: StoreErrorCode;
        readonly detail: string;
      }
  > => {
    const reply: Reply = await send(sql, signal);
    if (!reply.ok || reply.status !== 200) {
      return { ok: false, ...failureOf(reply) };
    }
    if (!/\bFORMAT JSON\s*$/.test(sql)) {
      return { ok: true, rows: [] };
    }
    const body: Record<string, unknown> | null = recordOf(reply.text);
    if (body === null || !Array.isArray(body.data)) {
      return {
        ok: false,
        code: 'unavailable',
        detail: `answered with something that is not JSON rows (${detailOf(reply.text)})`,
      };
    }
    return { ok: true, rows: body.data as Row[] };
  };

  let created: Promise<string | null> | null = null;
  /** Creates the table once; resolves to a message if that failed (and is tried again next time). */
  const ensureTable = (signal: AbortSignal): Promise<string | null> => {
    if (options.createTable === false) {
      return Promise.resolve(null);
    }
    if (created === null) {
      const attempt: Promise<string | null> = run(
        `CREATE TABLE IF NOT EXISTS ${target} (entry_key String, entry_value String, revision UInt64, writer String, deleted UInt8, updated_at DateTime64(3, 'UTC')) ENGINE = ReplacingMergeTree(revision) ORDER BY entry_key`,
        signal
      ).then((answer) =>
        answer.ok
          ? null
          : `could not create ${where} (${answer.detail}; the database must exist)`
      );
      created = attempt;
      void attempt.then((problem) => {
        if (problem !== null && created === attempt) {
          created = null;
        }
      });
    }
    return created;
  };

  /** The current row for a key; `null` when nothing is stored or it was removed. */
  const readLatest = async (
    key: string,
    signal: AbortSignal
  ): Promise<
    | { readonly ok: true; readonly latest: Latest | null }
    | {
        readonly ok: false;
        readonly code: StoreErrorCode;
        readonly detail: string;
      }
  > => {
    const answer = await run(
      `SELECT ${latest} FROM ${target} WHERE entry_key = ${sqlString(key)} GROUP BY entry_key FORMAT JSON`,
      signal
    );
    if (!answer.ok) {
      return answer;
    }
    const row: Row | undefined = answer.rows[0];
    if (row === undefined) {
      return { ok: true, latest: null };
    }
    const found: Latest | undefined = latestFrom(row);
    return found === undefined
      ? {
          ok: false,
          code: 'corrupt',
          detail:
            'holds a row that is not a stored entry (the table needs the columns entry_key, entry_value, revision, writer and deleted; remove the key to start again)',
        }
      : { ok: true, latest: found.deleted ? null : found };
  };

  const checkKey = (key: string, signal: AbortSignal): string | null => {
    if (signal.aborted) {
      return 'request was aborted';
    }
    if (!namesAreSafe) {
      return `cannot use ${where}: use letters, digits and underscores, starting with a letter or underscore`;
    }
    if (hasLoneSurrogate(key)) {
      return 'cannot use this key: it is not valid Unicode text';
    }
    if (utf8Length(key) > MAX_KEY_BYTES) {
      return `cannot use this key: it takes ${String(utf8Length(key))} bytes and the limit is ${String(MAX_KEY_BYTES)}`;
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

  /** Reads these keys together; throws if that fails. */
  const readKeys = async (
    keys: readonly string[]
  ): Promise<ReadonlyMap<string, StoredValue>> => {
    const found = new Map<string, StoredValue>();
    const usable: string[] = keys.filter(
      (key) => !hasLoneSurrogate(key) && utf8Length(key) <= MAX_KEY_BYTES
    );
    if (usable.length === 0 || !namesAreSafe) {
      return found;
    }
    const controller = new AbortController();
    const problem: string | null = await ensureTable(controller.signal);
    if (problem !== null) {
      throw new Error(problem);
    }
    const answer = await run(
      `SELECT entry_key, ${latest} FROM ${target} WHERE entry_key IN (${usable.map(sqlString).join(', ')}) GROUP BY entry_key FORMAT JSON`,
      controller.signal
    );
    if (!answer.ok) {
      throw new Error(answer.detail);
    }
    for (const row of answer.rows) {
      const entry: Latest | undefined = latestFrom(row);
      if (typeof row.entry_key === 'string' && entry !== undefined) {
        if (!entry.deleted) {
          found.set(row.entry_key, {
            value: entry.value,
            revision: entry.revision,
          });
        }
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
      const notCreated: string | null = await ensureTable(signal);
      if (notCreated !== null) {
        return sqlFailure(LABEL, 'unavailable', key, notCreated);
      }
      const current = await readLatest(key, signal);
      if (!current.ok) {
        return sqlFailure(
          LABEL,
          current.code,
          key,
          `could not be read (${current.detail})`
        );
      }
      return {
        ok: true,
        value:
          current.latest === null
            ? null
            : {
                value: current.latest.value,
                revision: current.latest.revision,
              },
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
      if (utf8Length(value) > MAX_VALUE_BYTES) {
        return sqlFailure(
          LABEL,
          'invalid',
          key,
          `cannot store this value: it takes ${String(utf8Length(value))} bytes and the limit is ${String(MAX_VALUE_BYTES)}`
        );
      }
      const notCreated: string | null = await ensureTable(signal);
      if (notCreated !== null) {
        return sqlFailure(LABEL, 'unavailable', key, notCreated);
      }
      const writer: string = newWriter();
      const step: number = Math.floor(Math.random() * REVISION_STEP);
      // The condition and the new revision come from the key's rows in one statement.
      const condition: string =
        ifRevision === undefined
          ? ''
          : ` HAVING count() = 0 OR argMax(deleted, revision) = 1 OR toString(max(revision)) = ${sqlString(ifRevision)}`;
      const written = await run(
        `INSERT INTO ${target} (entry_key, entry_value, revision, writer, deleted, updated_at) SELECT ${sqlString(key)}, ${sqlString(value)}, intDiv(max(revision), ${String(REVISION_STEP)}) * ${String(REVISION_STEP)} + ${String(REVISION_STEP + step)}, ${sqlString(writer)}, 0, now64(3) FROM ${target} WHERE entry_key = ${sqlString(key)}${condition}`,
        signal
      );
      if (!written.ok) {
        return sqlFailure(
          LABEL,
          written.code,
          key,
          `could not be written (${written.detail})`
        );
      }
      // Read back: this tells a refused condition and a lost race from a stored row.
      const current = await readLatest(key, signal);
      if (!current.ok) {
        return sqlFailure(
          LABEL,
          current.code,
          key,
          `was written but could not be read back to confirm it (${current.detail})`
        );
      }
      if (current.latest?.writer !== writer) {
        return sqlFailure(
          LABEL,
          'conflict',
          key,
          ifRevision !== undefined && current.latest !== null
            ? `holds revision ${current.latest.revision}, but revision ${ifRevision} was expected`
            : 'was written by another writer at the same moment, and that write won'
        );
      }
      const stored: StoredValue = {
        value,
        revision: current.latest.revision,
      };
      poller.announce(key, stored);
      return { ok: true, value: stored };
    },

    async remove(key, { signal }) {
      const problem: string | null = checkKey(key, signal);
      if (problem !== null) {
        return refused(key, problem);
      }
      const notCreated: string | null = await ensureTable(signal);
      if (notCreated !== null) {
        return sqlFailure(LABEL, 'unavailable', key, notCreated);
      }
      const removed = await run(
        `INSERT INTO ${target} (entry_key, entry_value, revision, writer, deleted, updated_at) SELECT ${sqlString(key)}, '', intDiv(max(revision), ${String(REVISION_STEP)}) * ${String(REVISION_STEP)} + ${String(REVISION_STEP + Math.floor(Math.random() * REVISION_STEP))}, ${sqlString(newWriter())}, 1, now64(3) FROM ${target} WHERE entry_key = ${sqlString(key)} HAVING count() > 0 AND argMax(deleted, revision) = 0`,
        signal
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
      if (!namesAreSafe || hasLoneSurrogate(keyPrefix)) {
        return prefixFailure(
          LABEL,
          'invalid',
          keyPrefix,
          namesAreSafe
            ? 'cannot use this prefix: it is not valid Unicode text'
            : `cannot use ${where}: use letters, digits and underscores, starting with a letter or underscore`
        );
      }
      const notCreated: string | null = await ensureTable(signal);
      if (notCreated !== null) {
        return prefixFailure(LABEL, 'unavailable', keyPrefix, notCreated);
      }
      const answer = await run(
        `SELECT entry_key FROM ${target}${keyPrefix === '' ? '' : ` WHERE startsWith(entry_key, ${sqlString(keyPrefix)})`} GROUP BY entry_key HAVING argMax(deleted, revision) = 0 FORMAT JSON`,
        signal
      );
      if (!answer.ok) {
        return prefixFailure(
          LABEL,
          answer.code,
          keyPrefix,
          `could not list keys (${answer.detail})`
        );
      }
      const keys: string[] = [];
      for (const row of answer.rows) {
        if (typeof row.entry_key === 'string') {
          keys.push(row.entry_key);
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
  const tails = new Map<string, Promise<unknown>>();
  const inTurn = <T>(key: string, runWrite: () => Promise<T>): Promise<T> => {
    const result: Promise<T> = (tails.get(key) ?? Promise.resolve()).then(
      runWrite
    );
    const tail: Promise<unknown> = result.then(
      () => undefined,
      () => undefined
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    });
    return result;
  };

  return {
    ...adapter,
    set: (key, value, setOptions) =>
      poller.trackWrite(key, () =>
        inTurn(key, () => adapter.set(key, value, setOptions))
      ),
    remove: (key, removeOptions) =>
      poller.trackWrite(key, () =>
        inTurn(key, () => adapter.remove(key, removeOptions))
      ),
  };
}
