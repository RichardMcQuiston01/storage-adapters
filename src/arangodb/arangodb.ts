/**
 * A `StorageAdapter` over ArangoDB's HTTP API. Like `/rest` and `/couchdb`, this is an
 * optional entry point that imports nothing: you pass in the `fetch` to use, so this
 * file never touches the network itself.
 */
import { describeUnknownError } from '../errors.js';
import type { FetchLike, FetchResponseLike } from '../rest/rest.js';
import { createChangeListeners, sqlFailure } from '../sql-shared.js';
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
export type ArangoDbFetch = FetchLike;

export type ArangoDbHeaders = Readonly<Record<string, string>>;

export interface ArangoDbAdapterOptions {
  /** The server's root, for example `http://127.0.0.1:8529`. No trailing slash needed. */
  readonly url: string;
  /** The `fetch` to send requests with. */
  readonly fetch: ArangoDbFetch;
  /** The database to use. Defaults to `_system`. */
  readonly database?: string;
  /** The collection that holds the entries. Defaults to `storage_entry`. */
  readonly collection?: string;
  /**
   * Sent with every request, for example `Authorization: Basic ...` or a `Bearer` JWT.
   * A function is called for each request, so a token can be refreshed; it may be async.
   */
  readonly headers?:
    ArangoDbHeaders | (() => ArangoDbHeaders | Promise<ArangoDbHeaders>);
  /**
   * Create the collection before the first use if it is not there. Defaults to true.
   * Turn it off for an account that may read and write documents but not create
   * collections.
   */
  readonly createCollection?: boolean;
  /**
   * Milliseconds between looks at the subscribed keys for changes other processes made
   * (at least 50). ArangoDB cannot announce changes to a plain HTTP client, so
   * `subscribe` hears only this adapter's own writes unless you give this. Off by default.
   */
  readonly pollIntervalMs?: number;
  /** Called once per run of failed polls, with a message naming the collection. */
  readonly onPollError?: (message: string) => void;
}

const LABEL = 'ArangoDB';
const DEFAULT_DATABASE = '_system';
const DEFAULT_COLLECTION = 'storage_entry';
const MAX_KEY_LENGTH = 254;
const MAX_DETAIL_LENGTH = 200;
const MIN_POLL_INTERVAL_MS = 50;
const POLL_BATCH_SIZE = 100;
const LIST_BATCH_SIZE = 1000;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,255}$/;
const REVISION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const DOCUMENT_NOT_FOUND = 1202;
const COLLECTION_NOT_FOUND = 1203;
const DATABASE_NOT_FOUND = 1228;

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

/** ArangoDB's `errorNum` for an answer, or 0 when it gave none. */
function errorNumberOf(text: string): number {
  const num: unknown = recordOf(text)?.errorNum;
  return typeof num === 'number' ? num : 0;
}

/** What ArangoDB said went wrong: its message and error number, or the start of the body. */
function detailOf(text: string): string {
  const body = recordOf(text);
  let said: string = text.trim();
  if (body !== null && typeof body.errorMessage === 'string') {
    said =
      typeof body.errorNum === 'number'
        ? `${body.errorMessage} (error ${String(body.errorNum)})`
        : body.errorMessage;
  }
  return said.length > MAX_DETAIL_LENGTH
    ? `${said.slice(0, MAX_DETAIL_LENGTH)}...`
    : said;
}

function classifyStatus(status: number): StoreErrorCode {
  if (status === 401 || status === 403) {
    return 'forbidden';
  }
  if (status === 413 || status === 507) {
    return 'quota';
  }
  if (status === 400 || status === 415 || status === 422) {
    return 'invalid';
  }
  return 'unavailable';
}

/**
 * Turns a key into a document `_key`. ArangoDB keys allow only some characters and at
 * most 254 bytes, so letters, digits, `-` and `_` stay and every other byte of the
 * key's UTF-8 becomes `=` and two uppercase hex digits. Prefixes survive, so listing
 * by prefix can match on the escaped text. Returns `undefined` for a key that cannot
 * be stored.
 */
export function encodeArangoKey(key: string): string | undefined {
  let encoded = '';
  for (const char of key) {
    const codePoint: number = char.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return undefined; // A lone surrogate is not valid Unicode text.
    }
    if (/^[A-Za-z0-9_-]$/.test(char)) {
      encoded += char;
    } else {
      for (const byte of utf8Bytes(codePoint)) {
        encoded += `=${byte.toString(16).padStart(2, '0').toUpperCase()}`;
      }
    }
  }
  if (encoded === '' || encoded.length > MAX_KEY_LENGTH) {
    return undefined;
  }
  return encoded;
}

/**
 * The key a document `_key` stands for: the reverse of `encodeArangoKey`. Returns
 * `undefined` for a `_key` the adapter could not have made, so a document written by
 * something else into the same collection is not mistaken for an entry.
 */
export function decodeArangoKey(name: string): string | undefined {
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
    if (char === '=') {
      const hex: string = name.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) {
        return undefined;
      }
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else if (/^[A-Za-z0-9_-]$/.test(char)) {
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
  return encodeArangoKey(key) === name ? key : undefined;
}

type Reply =
  | { readonly ok: true; readonly status: number; readonly text: string }
  | {
      readonly ok: false;
      readonly code: StoreErrorCode;
      readonly detail: string;
    };

function sameStored(a: StoredValue | null, b: StoredValue | null): boolean {
  return a === null || b === null
    ? a === b
    : a.value === b.value && a.revision === b.revision;
}

/**
 * A `StorageAdapter` over ArangoDB. Each entry is a document `{ _key, value }` in one
 * collection and its revision is the document's `_rev`. A write without `ifRevision`
 * is one request that creates or replaces the document. `set` with `ifRevision` sends
 * the revision in `If-Match`, so ArangoDB answers 412 when it is stale, which becomes
 * `conflict`; a key with nothing stored is created. `list` runs an AQL query for the
 * keys that start with the prefix. `subscribe` reports this adapter's own writes and,
 * with `pollIntervalMs`, changes other processes make. Nothing throws: every failure,
 * a network error included, is a `StoreResult`.
 */
export function arangoDbAdapter(
  options: ArangoDbAdapterOptions
): StorageAdapter {
  const baseUrl: string = options.url.replace(/\/+$/, '');
  const database: string = options.database ?? DEFAULT_DATABASE;
  const collection: string = options.collection ?? DEFAULT_COLLECTION;
  const namesAreSafe: boolean =
    NAME_PATTERN.test(database) && NAME_PATTERN.test(collection);
  const createCollection: boolean = options.createCollection ?? true;
  const dbUrl = `${baseUrl}/_db/${encodeURIComponent(database)}/_api`;
  const documentsUrl = `${dbUrl}/document/${encodeURIComponent(collection)}`;
  const listeners = createChangeListeners();
  let ready: Promise<Reply | null> | null = null;

  const pollIntervalMs: number | null =
    options.pollIntervalMs !== undefined &&
    Number.isFinite(options.pollIntervalMs) &&
    options.pollIntervalMs > 0
      ? Math.max(MIN_POLL_INTERVAL_MS, Math.floor(options.pollIntervalMs))
      : null;
  const subscribedKeys = new Map<string, number>();
  const lastSeen = new Map<string, StoredValue | null>();
  const localWrites = new Map<string, number>();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollsFailing = false;

  const headersFor = async (
    extra: Record<string, string>
  ): Promise<Record<string, string>> => {
    const configured: ArangoDbHeaders | undefined =
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
    body?: unknown,
    extra: Record<string, string> = {}
  ): Promise<Reply> => {
    try {
      const response: FetchResponseLike = await options.fetch(url, {
        method,
        headers: await headersFor(
          body === undefined
            ? extra
            : { 'Content-Type': 'application/json', ...extra }
        ),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  /** Creates the collection once if it is not there; a failure is not remembered. */
  const prepare = (signal: AbortSignal): Promise<Reply | null> => {
    if (!createCollection) {
      return Promise.resolve(null);
    }
    if (ready === null) {
      ready = (async (): Promise<Reply | null> => {
        const sent = await send('POST', `${dbUrl}/collection`, signal, {
          name: collection,
        });
        if (!sent.ok) {
          return sent;
        }
        // 409 means it exists; 401 and 403 mean this account may not create collections,
        // which is fine if the collection is already there. Anything else is a problem.
        if (
          sent.status === 200 ||
          sent.status === 201 ||
          sent.status === 409 ||
          sent.status === 401 ||
          sent.status === 403
        ) {
          return null;
        }
        return sent;
      })();
      void ready.then((outcome) => {
        if (outcome !== null) {
          ready = null; // Try again next time.
        }
      });
    }
    return ready;
  };

  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): { name: string } | StoreResult<T> => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    if (!namesAreSafe) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use database "${database}" and collection "${collection}": names may hold only letters, digits, _ and -`
      );
    }
    const name: string | undefined = encodeArangoKey(key);
    if (name === undefined) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use this key: it must be valid Unicode text of at most ${String(MAX_KEY_LENGTH)} characters once escaped, and not empty`
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
    const num: number = errorNumberOf(text);
    if (num === COLLECTION_NOT_FOUND || num === DATABASE_NOT_FOUND) {
      return sqlFailure(
        LABEL,
        'unavailable',
        key,
        `could not be ${verb} (${num === DATABASE_NOT_FOUND ? `database "${database}"` : `collection "${collection}"`} does not exist: ${detailOf(text)})`
      );
    }
    const said: string = detailOf(text);
    return sqlFailure(
      LABEL,
      classifyStatus(status),
      key,
      `could not be ${verb} (HTTP ${String(status)}${said === '' ? '' : `: ${said}`})`
    );
  };

  const prepared = async <T>(
    key: string,
    signal: AbortSignal
  ): Promise<StoreResult<T> | null> => {
    const problem: Reply | null = await prepare(signal);
    if (problem === null) {
      return null;
    }
    return problem.ok
      ? unexpected<T>(
          key,
          'prepared (the collection could not be created)',
          problem.status,
          problem.text
        )
      : sqlFailure(LABEL, problem.code, key, problem.detail);
  };

  const documentUrl = (name: string): string =>
    `${documentsUrl}/${encodeURIComponent(name)}`;

  /** Reads one document. `null` means nothing is stored under the key. */
  const readDocument = async (
    key: string,
    name: string,
    signal: AbortSignal
  ): Promise<StoreResult<StoredValue | null>> => {
    const sent = await send('GET', documentUrl(name), signal);
    if (!sent.ok) {
      return sqlFailure(LABEL, sent.code, key, sent.detail);
    }
    if (sent.status === 404) {
      const num: number = errorNumberOf(sent.text);
      return num === COLLECTION_NOT_FOUND || num === DATABASE_NOT_FOUND
        ? unexpected(key, 'read', sent.status, sent.text)
        : { ok: true, value: null };
    }
    if (sent.status !== 200) {
      return unexpected(key, 'read', sent.status, sent.text);
    }
    const body = recordOf(sent.text);
    if (
      body === null ||
      typeof body.value !== 'string' ||
      typeof body._rev !== 'string'
    ) {
      return sqlFailure(
        LABEL,
        'corrupt',
        key,
        'holds a document that is not a stored entry (it needs a text "value")'
      );
    }
    return { ok: true, value: { value: body.value, revision: body._rev } };
  };

  type Written =
    | { readonly kind: 'written'; readonly revision: string }
    | { readonly kind: 'refused' }
    | { readonly kind: 'failed'; readonly result: StoreResult<never> };

  /** Reads the revision out of a write's answer. */
  const writtenFrom = (key: string, sent: Reply & { ok: true }): Written => {
    const revision: unknown = recordOf(sent.text)?._rev;
    if (
      (sent.status === 200 || sent.status === 201 || sent.status === 202) &&
      typeof revision === 'string'
    ) {
      return { kind: 'written', revision };
    }
    return {
      kind: 'failed',
      result:
        sent.status === 200 || sent.status === 201 || sent.status === 202
          ? sqlFailure(
              LABEL,
              'corrupt',
              key,
              'answered a write with something that is not a revision'
            )
          : unexpected(key, 'written', sent.status, sent.text),
    };
  };

  /** Creates or replaces the document in one request. */
  const replaceDocument = async (
    key: string,
    name: string,
    value: string,
    signal: AbortSignal
  ): Promise<Written> => {
    const sent = await send(
      'POST',
      `${documentsUrl}?overwriteMode=replace`,
      signal,
      { _key: name, value }
    );
    return sent.ok
      ? writtenFrom(key, sent)
      : {
          kind: 'failed',
          result: sqlFailure(LABEL, sent.code, key, sent.detail),
        };
  };

  /** Creates the document only if the key is free; `refused` means it was taken. */
  const createDocument = async (
    key: string,
    name: string,
    value: string,
    signal: AbortSignal
  ): Promise<Written> => {
    const sent = await send('POST', documentsUrl, signal, {
      _key: name,
      value,
    });
    if (!sent.ok) {
      return {
        kind: 'failed',
        result: sqlFailure(LABEL, sent.code, key, sent.detail),
      };
    }
    if (sent.status === 409) {
      return { kind: 'refused' };
    }
    return writtenFrom(key, sent);
  };

  /** Replaces the document only if it still has this revision; `refused` means it does not. */
  const replaceIfRevision = async (
    key: string,
    name: string,
    value: string,
    revision: string,
    signal: AbortSignal
  ): Promise<Written> => {
    const sent = await send(
      'PUT',
      documentUrl(name),
      signal,
      { value },
      { 'If-Match': `"${revision}"` }
    );
    if (!sent.ok) {
      return {
        kind: 'failed',
        result: sqlFailure(LABEL, sent.code, key, sent.detail),
      };
    }
    if (sent.status === 412) {
      return { kind: 'refused' };
    }
    if (
      sent.status === 404 &&
      errorNumberOf(sent.text) === DOCUMENT_NOT_FOUND
    ) {
      return { kind: 'refused' }; // Nothing there to replace.
    }
    return writtenFrom(key, sent);
  };

  /** Runs an AQL query and returns every row, following the cursor. */
  const runQuery = async (
    query: string,
    bindVars: Record<string, unknown>,
    batchSize: number,
    signal: AbortSignal
  ): Promise<
    | { readonly ok: true; readonly rows: unknown[] }
    | { readonly ok: false; readonly reply: Reply }
  > => {
    const rows: unknown[] = [];
    let sent = await send('POST', `${dbUrl}/cursor`, signal, {
      query,
      bindVars,
      batchSize,
    });
    for (;;) {
      if (!sent.ok) {
        return { ok: false, reply: sent };
      }
      const body =
        sent.status === 200 || sent.status === 201 ? recordOf(sent.text) : null;
      if (body === null || !Array.isArray(body.result)) {
        return { ok: false, reply: sent };
      }
      rows.push(...(body.result as unknown[]));
      if (body.hasMore !== true || typeof body.id !== 'string') {
        return { ok: true, rows };
      }
      sent = await send(
        'PUT',
        `${dbUrl}/cursor/${encodeURIComponent(body.id)}`,
        signal
      );
    }
  };

  /* ---------------------------------------------------------------- */
  /* Change notices                                                    */
  /* ---------------------------------------------------------------- */

  const announce = (key: string, stored: StoredValue | null): void => {
    if (subscribedKeys.has(key)) {
      lastSeen.set(key, stored);
      localWrites.set(key, (localWrites.get(key) ?? 0) + 1);
    }
    listeners.notify(key, stored);
  };

  /**
   * Reads the subscribed keys together and tells subscribers about any that differ from
   * what they were last told. A key seen for the first time is only noted: what is
   * stored when you subscribe is not a change. A key this adapter wrote while the query
   * ran is skipped, because the answer may be older than that write.
   */
  const pollKeys = async (keys: readonly string[]): Promise<void> => {
    const signal: AbortSignal = new AbortController().signal;
    const problem: Reply | null = await prepare(signal);
    if (problem !== null) {
      throw new Error(
        problem.ok
          ? `HTTP ${String(problem.status)}: ${detailOf(problem.text)}`
          : problem.detail
      );
    }
    const stamps = new Map<string, number>(
      keys.map((key) => [key, localWrites.get(key) ?? 0])
    );
    const found = new Map<string, StoredValue>();
    for (let start = 0; start < keys.length; start += POLL_BATCH_SIZE) {
      const batch: string[] = keys.slice(start, start + POLL_BATCH_SIZE);
      const names: string[] = batch.flatMap((key) => {
        const name: string | undefined = encodeArangoKey(key);
        return name === undefined ? [] : [name];
      });
      const result = await runQuery(
        'FOR d IN @@collection FILTER d._key IN @names RETURN { name: d._key, revision: d._rev, value: d.value }',
        { '@collection': collection, names },
        names.length + 1,
        signal
      );
      if (!result.ok) {
        const reply: Reply = result.reply;
        throw new Error(
          reply.ok
            ? `HTTP ${String(reply.status)}: ${detailOf(reply.text)}`
            : reply.detail
        );
      }
      for (const row of result.rows) {
        const entry = row as {
          name?: unknown;
          revision?: unknown;
          value?: unknown;
        } | null;
        const key: string | undefined =
          typeof entry?.name === 'string'
            ? decodeArangoKey(entry.name)
            : undefined;
        if (
          key !== undefined &&
          typeof entry?.revision === 'string' &&
          typeof entry.value === 'string'
        ) {
          found.set(key, { value: entry.value, revision: entry.revision });
        }
      }
    }
    for (const key of keys) {
      if (
        !subscribedKeys.has(key) ||
        (localWrites.get(key) ?? 0) !== stamps.get(key)
      ) {
        continue;
      }
      const current: StoredValue | null = found.get(key) ?? null;
      const known: boolean = lastSeen.has(key);
      const before: StoredValue | null = lastSeen.get(key) ?? null;
      lastSeen.set(key, current);
      if (known && !sameStored(before, current)) {
        listeners.notify(key, current);
      }
    }
  };

  const pollFailed = (error: unknown): void => {
    if (!pollsFailing) {
      pollsFailing = true;
      try {
        options.onPollError?.(
          `${LABEL} could not poll collection "${collection}" for changes (${describeUnknownError(error)})`
        );
      } catch {
        // A faulty error handler must not break the adapter.
      }
    }
  };

  const scheduleNextPoll = (): void => {
    if (
      pollIntervalMs === null ||
      pollTimer !== null ||
      subscribedKeys.size === 0
    ) {
      return;
    }
    pollTimer = setTimeout(() => {
      pollTimer = null;
      const keys: string[] = [...subscribedKeys.keys()];
      void (keys.length === 0 ? Promise.resolve() : pollKeys(keys))
        .then(() => {
          pollsFailing = false;
        })
        .catch(pollFailed)
        .finally(scheduleNextPoll);
    }, pollIntervalMs);
    // Polling alone should not keep a program running.
    (pollTimer as { unref?: () => void }).unref?.();
  };

  /* ---------------------------------------------------------------- */

  return {
    async get(key, { signal }) {
      const checked = refusal<StoredValue | null>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      const problem = await prepared<StoredValue | null>(key, signal);
      if (problem !== null) {
        return problem;
      }
      return readDocument(key, checked.name, signal);
    },

    async set(key, value, { signal, ifRevision }) {
      const checked = refusal<StoredValue>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      const { name } = checked;
      const problem = await prepared<StoredValue>(key, signal);
      if (problem !== null) {
        return problem;
      }
      const finish = (revision: string): StoreResult<StoredValue> => {
        const stored: StoredValue = { value, revision };
        announce(key, stored);
        return { ok: true, value: stored };
      };
      const conflict = (holds: StoredValue | null): StoreResult<StoredValue> =>
        sqlFailure(
          LABEL,
          'conflict',
          key,
          holds === null
            ? `changed while it was being written, so revision ${ifRevision ?? ''} no longer applies`
            : `holds revision ${holds.revision ?? ''}, but revision ${ifRevision ?? ''} was expected`
        );

      if (ifRevision === undefined) {
        const written = await replaceDocument(key, name, value, signal);
        if (written.kind === 'written') {
          return finish(written.revision);
        }
        return written.kind === 'failed' ? written.result : conflict(null);
      }

      // A revision ArangoDB would not recognise can never match what is stored.
      if (REVISION_PATTERN.test(ifRevision)) {
        const written = await replaceIfRevision(
          key,
          name,
          value,
          ifRevision,
          signal
        );
        if (written.kind === 'written') {
          return finish(written.revision);
        }
        if (written.kind === 'failed') {
          return written.result;
        }
      }
      const read = await readDocument(key, name, signal);
      if (!read.ok) {
        return read;
      }
      if (read.value !== null) {
        return conflict(read.value);
      }
      // Nothing is stored, so there is no revision to differ from: create it.
      const created = await createDocument(key, name, value, signal);
      if (created.kind === 'written') {
        return finish(created.revision);
      }
      if (created.kind === 'failed') {
        return created.result;
      }
      const now = await readDocument(key, name, signal);
      return conflict(now.ok ? now.value : null);
    },

    async remove(key, { signal }) {
      const checked = refusal<null>(key, signal);
      if (!('name' in checked)) {
        return checked;
      }
      const problem = await prepared<null>(key, signal);
      if (problem !== null) {
        return problem;
      }
      const sent = await send('DELETE', documentUrl(checked.name), signal);
      if (!sent.ok) {
        return sqlFailure(LABEL, sent.code, key, sent.detail);
      }
      if (sent.status === 404) {
        const num: number = errorNumberOf(sent.text);
        if (num === COLLECTION_NOT_FOUND || num === DATABASE_NOT_FOUND) {
          return unexpected(key, 'removed', sent.status, sent.text);
        }
      } else if (
        sent.status !== 200 &&
        sent.status !== 201 &&
        sent.status !== 202
      ) {
        return unexpected(key, 'removed', sent.status, sent.text);
      }
      announce(key, null);
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
      if (!namesAreSafe) {
        return prefixFailure(
          LABEL,
          'invalid',
          keyPrefix,
          `cannot use database "${database}" and collection "${collection}": names may hold only letters, digits, _ and -`
        );
      }
      // The empty prefix is every key; a prefix is matched on its escaped form, which
      // keeps the same start.
      const escaped: string =
        keyPrefix === '' ? '' : (encodeArangoKey(keyPrefix) ?? '');
      if (keyPrefix !== '' && escaped === '') {
        return {
          ok: true,
          value: [],
        };
      }
      const problem = await prepare(signal);
      if (problem !== null) {
        return prefixFailure(
          LABEL,
          problem.ok ? classifyStatus(problem.status) : problem.code,
          keyPrefix,
          problem.ok
            ? `could not list keys (HTTP ${String(problem.status)}: ${detailOf(problem.text)})`
            : `could not list keys (${problem.detail})`
        );
      }
      const result = await runQuery(
        'FOR d IN @@collection FILTER STARTS_WITH(d._key, @prefix) RETURN d._key',
        { '@collection': collection, prefix: escaped },
        LIST_BATCH_SIZE,
        signal
      );
      if (!result.ok) {
        const reply: Reply = result.reply;
        return prefixFailure(
          LABEL,
          reply.ok ? classifyStatus(reply.status) : reply.code,
          keyPrefix,
          reply.ok
            ? `could not list keys (HTTP ${String(reply.status)}: ${detailOf(reply.text)})`
            : `could not list keys (${reply.detail})`
        );
      }
      const keys: string[] = [];
      for (const row of result.rows) {
        const key: string | undefined =
          typeof row === 'string' ? decodeArangoKey(row) : undefined;
        if (key !== undefined && key.startsWith(keyPrefix)) {
          keys.push(key);
        }
      }
      return { ok: true, value: keys.sort(compareKeys) };
    },

    subscribe(key, onChange) {
      const stop: () => void = listeners.subscribe(key, onChange);
      if (pollIntervalMs === null) {
        return stop;
      }
      subscribedKeys.set(key, (subscribedKeys.get(key) ?? 0) + 1);
      // Note what is stored now, then keep looking.
      void pollKeys([key]).catch(pollFailed).finally(scheduleNextPoll);
      let stopped = false;
      return () => {
        if (stopped) {
          return;
        }
        stopped = true;
        stop();
        const remaining: number = (subscribedKeys.get(key) ?? 1) - 1;
        if (remaining > 0) {
          subscribedKeys.set(key, remaining);
          return;
        }
        subscribedKeys.delete(key);
        lastSeen.delete(key);
        localWrites.delete(key);
        if (subscribedKeys.size === 0 && pollTimer !== null) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      };
    },
  };
}
