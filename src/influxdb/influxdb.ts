/**
 * A `StorageAdapter` over InfluxDB 2.x's HTTP API. Like `/rest`, `/couchdb` and
 * `/arangodb`, this is an optional entry point that imports nothing: you pass in the
 * `fetch` to use, so this file never touches the network itself.
 *
 * InfluxDB is a time-series database, not a key-value store, and it cannot check a
 * revision atomically. This adapter works by writing every entry as a point at one fixed
 * timestamp, which InfluxDB overwrites on the next write to the same key. See
 * `influxDbAdapter` for what that costs.
 */
import { describeUnknownError } from '../errors.js';
import type { FetchLike, FetchResponseLike } from '../rest/rest.js';
import { createChangePoller } from '../change-poller.js';
import { sqlFailure } from '../sql-shared.js';
import { decodeUtf8, utf8Bytes } from '../utf8.js';
import {
  compareKeys,
  prefixFailure,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** The `fetch` this adapter sends requests with. The global `fetch` fits. */
export type InfluxDbFetch = FetchLike;

export type InfluxDbHeaders = Readonly<Record<string, string>>;

export interface InfluxDbAdapterOptions {
  /** The server's root, for example `http://127.0.0.1:8086`. No trailing slash needed. */
  readonly url: string;
  /** The `fetch` to send requests with. */
  readonly fetch: InfluxDbFetch;
  /** The organization name or ID. */
  readonly org: string;
  /**
   * The bucket that holds the entries. It must already exist, and it must keep data
   * forever (no retention period): entries are stored at a fixed timestamp in 1970,
   * which a retention period would delete.
   */
  readonly bucket: string;
  /** The measurement that holds the entries. Defaults to `storage_entry`. */
  readonly measurement?: string;
  /**
   * Sent with every request, for example `Authorization: Token ...`. A function is
   * called for each request, so a token can be refreshed; it may be async.
   */
  readonly headers?:
    InfluxDbHeaders | (() => InfluxDbHeaders | Promise<InfluxDbHeaders>);
  /**
   * Milliseconds between looks at the subscribed keys for changes other processes made
   * (at least 50). InfluxDB cannot announce changes to a plain HTTP client, so
   * `subscribe` hears only this adapter's own writes unless you give this. Off by default.
   */
  readonly pollIntervalMs?: number;
  /** Called once per run of failed polls, with a message naming the bucket. */
  readonly onPollError?: (message: string) => void;
}

const LABEL = 'InfluxDB';
const DEFAULT_MEASUREMENT = 'storage_entry';
const MEASUREMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** The longest key, once escaped. Tag values this long are well inside InfluxDB's limits. */
const MAX_ENCODED_KEY_LENGTH = 1024;
const MAX_DETAIL_LENGTH = 200;
/** The one timestamp every entry is written at, so a new write replaces the old point. */
const TIMESTAMP_START = '1970-01-01T00:00:00Z';
const TIMESTAMP_END = '1970-01-01T00:00:01Z';
/** What an empty key is stored as. A key that is really `~` is stored as `%7E`. */
const EMPTY_KEY_MARK = '~';
/** The columns of a pivoted row of an entry: Flux's own, our tag and our three fields. */
const KNOWN_COLUMNS: ReadonlySet<string> = new Set([
  'result',
  'table',
  '_time',
  '_start',
  '_stop',
  '_measurement',
  'entry_key',
  'value',
  'revision',
  'updated_at',
]);

/** A tag value for a key part: letters, digits and `_.:@/-` stay, other bytes become `%XX`. */
function encodeKeyPart(key: string): string | undefined {
  let encoded = '';
  for (const char of key) {
    const codePoint: number = char.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return undefined; // A lone surrogate is not valid Unicode text.
    }
    if (/^[A-Za-z0-9_.:@/-]$/.test(char)) {
      encoded += char;
    } else {
      for (const byte of utf8Bytes(codePoint)) {
        encoded += `%${byte.toString(16).padStart(2, '0').toUpperCase()}`;
      }
    }
  }
  return encoded;
}

/**
 * Turns a key into the tag value it is stored under. Tag values cannot hold newlines or
 * be empty, so every byte outside `A-Za-z0-9_.:@/-` becomes `%` and two uppercase hex
 * digits, and the empty key is stored as `~`. Prefixes survive, so listing by prefix can
 * match on the escaped text. Returns `undefined` for a key that cannot be stored.
 */
export function encodeInfluxKey(key: string): string | undefined {
  if (key === '') {
    return EMPTY_KEY_MARK;
  }
  const encoded: string | undefined = encodeKeyPart(key);
  return encoded === undefined || encoded.length > MAX_ENCODED_KEY_LENGTH
    ? undefined
    : encoded;
}

/**
 * The key a tag value stands for: the reverse of `encodeInfluxKey`. Returns `undefined`
 * for a tag value the adapter could not have made, so a point written by something else
 * into the same measurement is not mistaken for an entry.
 */
export function decodeInfluxKey(name: string): string | undefined {
  if (name === EMPTY_KEY_MARK) {
    return '';
  }
  let key = '';
  const bytes: number[] = [];
  const flush = (): boolean => {
    if (bytes.length === 0) {
      return true;
    }
    const text: string | undefined = decodeUtf8(bytes);
    bytes.length = 0;
    if (text === undefined) {
      return false;
    }
    key += text;
    return true;
  };
  for (let index = 0; index < name.length; index += 1) {
    const char: string = name.charAt(index);
    if (char === '%') {
      const hex: string = name.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) {
        return undefined;
      }
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else if (/^[A-Za-z0-9_.:@/-]$/.test(char)) {
      if (!flush()) {
        return undefined;
      }
      key += char;
    } else {
      return undefined;
    }
  }
  if (!flush()) {
    return undefined;
  }
  return key !== '' && encodeInfluxKey(key) === name ? key : undefined;
}

/**
 * A value as stored: backslash, newline, carriage return and NUL are escaped, because
 * InfluxDB's query answers turn a lone newline into CRLF and so would not give the value
 * back exactly.
 */
export function escapeInfluxValue(value: string): string {
  return value.replace(/[\\\n\r\0]/g, (char) => {
    switch (char) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\0':
        return '\\0';
      default:
        return '\\\\';
    }
  });
}

/** The reverse of `escapeInfluxValue`; `undefined` for text that is not an escaped value. */
export function unescapeInfluxValue(text: string): string | undefined {
  let value = '';
  for (let index = 0; index < text.length; index += 1) {
    const char: string = text.charAt(index);
    if (char !== '\\') {
      value += char;
      continue;
    }
    index += 1;
    switch (text.charAt(index)) {
      case 'n':
        value += '\n';
        break;
      case 'r':
        value += '\r';
        break;
      case '0':
        value += '\0';
        break;
      case '\\':
        value += '\\';
        break;
      default:
        return undefined;
    }
  }
  return value;
}

/** A Flux string literal: quotes, backslashes, newlines and `${` are escaped. */
function fluxString(text: string): string {
  return `"${text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\$\{/g, '\\${')}"`;
}

/** Splits CSV text into rows of cells, honouring quotes (cells may hold commas and newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const char: string = text.charAt(index);
    if (quoted) {
      if (char === '"') {
        if (text.charAt(index + 1) === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      started = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
      started = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text.charAt(index + 1) === '\n') {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      started = false;
    } else {
      cell += char;
      started = true;
    }
  }
  if (started || cell !== '') {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

type FluxRows =
  | { readonly ok: true; readonly rows: readonly Record<string, string>[] }
  | { readonly ok: false; readonly detail: string };

/**
 * The rows of an annotated CSV answer, each keyed by its column name. A blank line starts
 * a new table with its own header; `#` lines are annotations. Flux reports an error that
 * happens while it runs as a table with an `error` column.
 */
function parseFluxCsv(text: string): FluxRows {
  const rows: Record<string, string>[] = [];
  let header: string[] | null = null;
  for (const cells of parseCsv(text)) {
    if (cells.length === 1 && cells[0] === '') {
      header = null;
      continue;
    }
    if ((cells[0] ?? '').startsWith('#')) {
      continue;
    }
    if (header === null) {
      header = cells;
      continue;
    }
    if (header[0] === 'error') {
      return { ok: false, detail: cells[0] ?? 'unknown error' };
    }
    const row: Record<string, string> = {};
    header.forEach((name, column) => {
      if (name !== '') {
        row[name] = cells[column] ?? '';
      }
    });
    rows.push(row);
  }
  return { ok: true, rows };
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

/** What InfluxDB said went wrong: its message, or the start of the body. */
function detailOf(text: string): string {
  const body = recordOf(text);
  let said: string = text.trim();
  if (body !== null) {
    if (typeof body.message === 'string') {
      said = body.message;
    } else if (typeof body.error === 'string') {
      said = body.error;
    }
  }
  return said.length > MAX_DETAIL_LENGTH
    ? `${said.slice(0, MAX_DETAIL_LENGTH)}...`
    : said;
}

function classifyStatus(status: number, detail: string): StoreErrorCode {
  if (status === 401 || status === 403) {
    return 'forbidden';
  }
  if (status === 413 || status === 507) {
    return 'quota';
  }
  if (
    status === 400 ||
    status === 415 ||
    status === 422 ||
    /beyond retention policy/i.test(detail)
  ) {
    return 'invalid';
  }
  return 'unavailable';
}

/** A revision no other write is likely to share: the time, and some random digits. */
function newRevision(): string {
  const random: string = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `${String(Date.now())}-${random}`;
}

type Reply =
  | { readonly ok: true; readonly status: number; readonly text: string }
  | {
      readonly ok: false;
      readonly code: StoreErrorCode;
      readonly detail: string;
    };

/**
 * A `StorageAdapter` over InfluxDB 2.x. Each entry is one point in one measurement,
 * tagged `entry_key` with the (escaped) key and holding the value, a revision and the time of the
 * write as fields. Every point is written at the same timestamp, so InfluxDB replaces the
 * previous one instead of keeping a history. A write without `ifRevision` is one request
 * that gives the entry a fresh revision.
 *
 * InfluxDB cannot check a revision atomically. `set` with `ifRevision` reads the entry,
 * compares, then writes, so two processes holding the same revision can both succeed; use
 * this adapter where one process writes a key at a time, or accept last-write-wins.
 * (Writes made through one adapter object do wait for each other, so among them the
 * check holds.) A key with nothing stored is created. `remove` uses the delete API. `list` runs a Flux query
 * for the keys that start with the prefix. `subscribe` reports this adapter's own writes
 * and, with `pollIntervalMs`, changes other processes make. Nothing throws: every
 * failure, a network error included, is a `StoreResult`.
 *
 * It needs a bucket with no retention period and an InfluxDB that answers Flux queries
 * and the delete API (2.x; InfluxDB 3 does not).
 */
export function influxDbAdapter(
  options: InfluxDbAdapterOptions
): StorageAdapter {
  const baseUrl: string = options.url.replace(/\/+$/, '');
  const { org, bucket } = options;
  const measurement: string = options.measurement ?? DEFAULT_MEASUREMENT;
  const measurementIsSafe: boolean = MEASUREMENT_PATTERN.test(measurement);
  const inBucket = `org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}`;
  const writeUrl = `${baseUrl}/api/v2/write?${inBucket}&precision=ns`;
  const deleteUrl = `${baseUrl}/api/v2/delete?${inBucket}`;
  const queryUrl = `${baseUrl}/api/v2/query?org=${encodeURIComponent(org)}`;
  const range = `range(start: ${TIMESTAMP_START}, stop: ${TIMESTAMP_END})`;
  const source = `from(bucket: ${fluxString(bucket)}) |> ${range} |> filter(fn: (r) => r._measurement == ${fluxString(measurement)}`;
  const pivot =
    '|> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")';

  const headersFor = async (
    extra: Record<string, string>
  ): Promise<Record<string, string>> => {
    const configured: InfluxDbHeaders | undefined =
      typeof options.headers === 'function'
        ? await options.headers()
        : options.headers;
    return { Accept: 'application/json', ...configured, ...extra };
  };

  /** Sends one request. A network failure becomes a result, so callers only branch on it. */
  const send = async (
    method: string,
    url: string,
    signal: AbortSignal,
    body: string,
    extra: Record<string, string>
  ): Promise<Reply> => {
    try {
      const response: FetchResponseLike = await options.fetch(url, {
        method,
        headers: await headersFor(extra),
        body,
        signal,
      });
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

  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): { name: string } | StoreResult<T> => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    if (!measurementIsSafe) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use measurement "${measurement}": use letters, digits and underscores, starting with a letter or underscore`
      );
    }
    const name: string | undefined = encodeInfluxKey(key);
    if (name === undefined) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use this key: it must be valid Unicode text of at most ${String(MAX_ENCODED_KEY_LENGTH)} characters once escaped`
      );
    }
    return { name };
  };

  /** A failed result for an answer whose status was not what the call expected. */
  const unexpected = <T>(
    key: string,
    verb: string,
    status: number,
    text: string
  ): StoreResult<T> => {
    const said: string = detailOf(text);
    let advice = `; bucket "${bucket}", organization "${org}"`;
    if (/beyond retention policy/i.test(said)) {
      advice = `; the bucket "${bucket}" has a retention period, and entries are stored at a fixed timestamp in 1970, so it needs to keep data forever`;
    } else if (
      status === 404 ||
      (status >= 500 && /database|bucket/i.test(said))
    ) {
      advice = `; check that the organization "${org}" and the bucket "${bucket}" exist`;
    }
    return sqlFailure(
      LABEL,
      classifyStatus(status, said),
      key,
      `could not be ${verb} (HTTP ${String(status)}${said === '' ? '' : `: ${said}`}${advice})`
    );
  };

  /** Runs a Flux query and returns its rows. */
  const query = async (
    flux: string,
    signal: AbortSignal
  ): Promise<
    | { readonly ok: true; readonly rows: readonly Record<string, string>[] }
    | { readonly ok: false; readonly reply: Reply }
  > => {
    const sent = await send('POST', queryUrl, signal, flux, {
      'Content-Type': 'application/vnd.flux',
      Accept: 'application/csv',
    });
    if (!sent.ok || sent.status !== 200) {
      return { ok: false, reply: sent };
    }
    const parsed: FluxRows = parseFluxCsv(sent.text);
    return parsed.ok
      ? parsed
      : {
          ok: false,
          reply: {
            ok: false,
            code: 'unavailable',
            detail: `query failed (${parsed.detail})`,
          },
        };
  };

  const queryFailure = <T>(
    key: string,
    verb: string,
    reply: Reply
  ): StoreResult<T> =>
    reply.ok
      ? unexpected(key, verb, reply.status, reply.text)
      : sqlFailure(
          LABEL,
          reply.code,
          key,
          reply.detail.startsWith('query failed')
            ? `could not be ${verb} (${reply.detail})`
            : reply.detail
        );

  /** Turns one pivoted row into an entry; `undefined` if it is not one. */
  const entryFrom = (row: Record<string, string>): StoredValue | undefined => {
    // Any column besides ours means the point has a tag or field the adapter did not write.
    if (Object.keys(row).some((column) => !KNOWN_COLUMNS.has(column))) {
      return undefined;
    }
    const revision: string | undefined = row.revision;
    const value: string | undefined = unescapeInfluxValue(row.value ?? '');
    if (revision === undefined || revision === '' || value === undefined) {
      return undefined;
    }
    return { value, revision };
  };

  /** Reads the entry for a key. `null` means nothing is stored. */
  const readEntry = async (
    key: string,
    name: string,
    signal: AbortSignal
  ): Promise<StoreResult<StoredValue | null>> => {
    const answer = await query(
      `${source} and r.entry_key == ${fluxString(name)}) ${pivot}`,
      signal
    );
    if (!answer.ok) {
      return queryFailure(key, 'read', answer.reply);
    }
    if (answer.rows.length === 0) {
      return { ok: true, value: null };
    }
    const entry: StoredValue | undefined =
      answer.rows.length === 1 && answer.rows[0] !== undefined
        ? entryFrom(answer.rows[0])
        : undefined;
    if (entry === undefined) {
      return sqlFailure(
        LABEL,
        'corrupt',
        key,
        'holds a point that is not a stored entry (it needs a "revision" field and a text "value" field, and no other tags; remove the key to start again)'
      );
    }
    return { ok: true, value: entry };
  };

  /** Writes the entry, replacing the point already there. */
  const writeEntry = async (
    key: string,
    name: string,
    value: string,
    revision: string,
    signal: AbortSignal
  ): Promise<StoreResult<StoredValue>> => {
    const line = `${measurement},entry_key=${name.replace(/[ ,=]/g, '\\$&')} value="${escapeInfluxValue(value).replace(/["\\]/g, '\\$&')}",revision="${revision}",updated_at=${String(Date.now())}i 0`;
    const sent = await send('POST', writeUrl, signal, line, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    if (!sent.ok) {
      return sqlFailure(LABEL, sent.code, key, sent.detail);
    }
    if (sent.status !== 204 && sent.status !== 200) {
      return unexpected(key, 'written', sent.status, sent.text);
    }
    return { ok: true, value: { value, revision } };
  };

  /** Reads these keys together; throws if that fails. */
  const readKeys = async (
    keys: readonly string[]
  ): Promise<ReadonlyMap<string, StoredValue>> => {
    const names = new Map<string, string>();
    for (const key of keys) {
      const name: string | undefined = encodeInfluxKey(key);
      if (name !== undefined) {
        names.set(name, key);
      }
    }
    const found = new Map<string, StoredValue>();
    if (names.size === 0) {
      return found;
    }
    const set: string = [...names.keys()].map(fluxString).join(', ');
    const controller = new AbortController();
    const answer = await query(
      `${source} and contains(value: r.entry_key, set: [${set}])) ${pivot}`,
      controller.signal
    );
    if (!answer.ok) {
      throw new Error(
        answer.reply.ok
          ? `HTTP ${String(answer.reply.status)}: ${detailOf(answer.reply.text)}`
          : answer.reply.detail
      );
    }
    for (const row of answer.rows) {
      const key: string | undefined = names.get(row.entry_key ?? '');
      const entry: StoredValue | undefined = entryFrom(row);
      if (key !== undefined && entry !== undefined) {
        found.set(key, entry);
      }
    }
    return found;
  };

  const poller = createChangePoller({
    intervalMs: options.pollIntervalMs,
    readKeys,
    onError: options.onPollError,
    describeFailure: (cause) =>
      `${LABEL} could not poll bucket "${bucket}" for changes (${cause})`,
  });

  const adapter = {
    async get(key, { signal }) {
      const checked = refusal<StoredValue | null>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      return readEntry(key, checked.name, signal);
    },

    async set(key, value, { signal, ifRevision }) {
      const checked = refusal<StoredValue>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      if (
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
          value
        )
      ) {
        return sqlFailure(
          LABEL,
          'invalid',
          key,
          'cannot store this value: it is not valid Unicode text'
        );
      }
      if (ifRevision !== undefined) {
        // InfluxDB cannot compare and write in one step, so this reads first.
        const current = await readEntry(key, checked.name, signal);
        if (!current.ok) {
          return current;
        }
        if (current.value !== null && current.value.revision !== ifRevision) {
          return sqlFailure(
            LABEL,
            'conflict',
            key,
            `holds revision ${current.value.revision}, but revision ${ifRevision} was expected`
          );
        }
      }
      const written = await writeEntry(
        key,
        checked.name,
        value,
        newRevision(),
        signal
      );
      if (written.ok) {
        poller.announce(key, written.value);
      }
      return written;
    },

    async remove(key, { signal }) {
      const checked = refusal<null>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      const sent = await send(
        'POST',
        deleteUrl,
        signal,
        JSON.stringify({
          start: TIMESTAMP_START,
          stop: TIMESTAMP_END,
          predicate: `_measurement=${fluxString(measurement)} AND entry_key=${fluxString(checked.name)}`,
        }),
        { 'Content-Type': 'application/json' }
      );
      if (!sent.ok) {
        return sqlFailure(LABEL, sent.code, key, sent.detail);
      }
      if (sent.status !== 204 && sent.status !== 200) {
        return unexpected(key, 'removed', sent.status, sent.text);
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
      if (!measurementIsSafe) {
        return prefixFailure(
          LABEL,
          'invalid',
          keyPrefix,
          `cannot use measurement "${measurement}": use letters, digits and underscores, starting with a letter or underscore`
        );
      }
      const encodedPrefix: string | undefined = encodeKeyPart(keyPrefix);
      if (encodedPrefix === undefined) {
        return prefixFailure(
          LABEL,
          'invalid',
          keyPrefix,
          'cannot use this prefix: it must be valid Unicode text'
        );
      }
      const answer = await query(
        `import "strings"\n${source} and r._field == "revision"${encodedPrefix === '' ? '' : ` and strings.hasPrefix(v: r.entry_key, prefix: ${fluxString(encodedPrefix)})`}) |> keep(columns: ["entry_key"]) |> group()`,
        signal
      );
      if (!answer.ok) {
        const reply: Reply = answer.reply;
        return prefixFailure(
          LABEL,
          reply.ok
            ? classifyStatus(reply.status, detailOf(reply.text))
            : reply.code,
          keyPrefix,
          `could not list keys (${reply.ok ? `HTTP ${String(reply.status)}: ${detailOf(reply.text)}` : reply.detail})`
        );
      }
      const keys: string[] = [];
      for (const row of answer.rows) {
        const key: string | undefined = decodeInfluxKey(row.entry_key ?? '');
        if (key !== undefined && key.startsWith(keyPrefix)) {
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
   * Writes to one key wait for the one before them. InfluxDB cannot compare and write in
   * one step, so this is what makes `ifRevision` reliable among the writers that share
   * this adapter.
   */
  const tails = new Map<string, Promise<unknown>>();
  const inTurn = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const result: Promise<T> = (tails.get(key) ?? Promise.resolve()).then(run);
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
