/**
 * A `StorageAdapter` over Apache CouchDB (and servers that speak its HTTP API, such
 * as Cloudant). Like `/rest`, this is an optional entry point that imports nothing:
 * you pass in the `fetch` to use, so this file never touches the network itself.
 */
import { describeUnknownError } from '../errors.js';
import type { FetchLike, FetchResponseLike } from '../rest/rest.js';
import { createChangeListeners, sqlFailure } from '../sql-shared.js';
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
export type CouchDbFetch = FetchLike;

export type CouchDbHeaders = Readonly<Record<string, string>>;

export interface CouchDbAdapterOptions {
  /** The server's root, for example `http://127.0.0.1:5984`. No trailing slash needed. */
  readonly url: string;
  /** The database to keep entries in. It must exist; the adapter does not create it. */
  readonly database: string;
  /** The `fetch` to send requests with. */
  readonly fetch: CouchDbFetch;
  /**
   * Sent with every request, for example `Authorization: Basic ...`. A function is
   * called for each request, so a token can be refreshed; it may be async.
   */
  readonly headers?:
    CouchDbHeaders | (() => CouchDbHeaders | Promise<CouchDbHeaders>);
  /**
   * Put in front of every document id, so several adapters (or other documents) can
   * share a database. Defaults to `storage:`. Document ids cannot start with `_`, so
   * with `''` a key that does is `invalid`.
   */
  readonly prefix?: string;
  /**
   * Milliseconds the server may hold a request for changes open before answering
   * empty, while someone is subscribed. Defaults to 25000, which stays under the 30
   * seconds many proxies allow.
   */
  readonly changesTimeoutMs?: number;
  /** Called when listening for changes fails, with a message naming the database. */
  readonly onChangesError?: (message: string) => void;
  /**
   * Milliseconds to wait before asking for changes again after a failure, for as
   * long as someone is subscribed. Defaults to 5000; `0` never retries.
   */
  readonly changesRetryMs?: number;
}

const LABEL = 'CouchDB';
const DEFAULT_PREFIX = 'storage:';
const DEFAULT_CHANGES_TIMEOUT_MS = 25_000;
const DEFAULT_RETRY_MS = 5000;
/** An answer that comes back sooner than this with nothing in it is followed by a short wait. */
const QUICK_EMPTY_ANSWER_MS = 250;
/** A write that keeps meeting a newer revision is tried this many times. */
const MAX_WRITE_ATTEMPTS = 5;
const LIST_PAGE_SIZE = 1000;
const MAX_KEY_BYTES = 1024;
const MAX_DETAIL_LENGTH = 200;
const REVISION_PATTERN = /^[1-9][0-9]*-[0-9a-f]{32}$/;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

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

/** What CouchDB said went wrong: its `error` and `reason`, or the start of the body. */
function detailOf(text: string): string {
  const body = recordOf(text);
  let said: string = text.trim();
  if (body !== null) {
    const parts: string[] = [body.error, body.reason].filter(
      (part): part is string => typeof part === 'string' && part !== ''
    );
    if (parts.length > 0) {
      said = parts.join(': ');
    }
  }
  return said.length > MAX_DETAIL_LENGTH
    ? `${said.slice(0, MAX_DETAIL_LENGTH)}...`
    : said;
}

function classifyStatus(status: number): StoreErrorCode {
  if (status === 401 || status === 403) {
    return 'forbidden';
  }
  if (status === 402 || status === 413 || status === 507) {
    return 'quota';
  }
  if (status === 400 || status === 415 || status === 422) {
    return 'invalid';
  }
  return 'unavailable';
}

/** The count at the front of a CouchDB revision such as `3-9f8a...`. */
function generationOf(revision: string): number {
  const generation: number = Number.parseInt(revision, 10);
  return Number.isSafeInteger(generation) ? generation : 0;
}

/** What has been reported for a key, so a change is not announced twice. */
interface Seen {
  generation: number;
  removed: boolean;
}

type Reply =
  | { readonly ok: true; readonly status: number; readonly text: string }
  | {
      readonly ok: false;
      readonly code: StoreErrorCode;
      readonly detail: string;
    };

/**
 * A `StorageAdapter` over CouchDB. Each entry is a document `{ _id: prefix + key,
 * value }` and its revision is the document's `_rev`. `set` with `ifRevision` sends
 * that `_rev`, so CouchDB answers 409 when it is stale, which becomes `conflict`; a
 * key with nothing stored is created. `list` reads a range of `_all_docs`.
 * `subscribe` follows the database's `_changes` feed, so it hears writes from any
 * process; the feed is read with long polling, which needs only `fetch`. Nothing
 * throws: every failure, a network error included, is a `StoreResult`.
 */
export function couchDbAdapter(options: CouchDbAdapterOptions): StorageAdapter {
  const baseUrl: string = options.url.replace(/\/+$/, '');
  const databaseUrl = `${baseUrl}/${encodeURIComponent(options.database)}`;
  const prefix: string = options.prefix ?? DEFAULT_PREFIX;
  const changesTimeoutMs: number =
    options.changesTimeoutMs ?? DEFAULT_CHANGES_TIMEOUT_MS;
  const retryMs: number = options.changesRetryMs ?? DEFAULT_RETRY_MS;
  const listeners = createChangeListeners();

  const documentUrl = (id: string): string =>
    `${databaseUrl}/${encodeURIComponent(id)}`;

  const headersFor = async (
    extra: Record<string, string>
  ): Promise<Record<string, string>> => {
    const configured: CouchDbHeaders | undefined =
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
    body?: string
  ): Promise<Reply> => {
    try {
      const response: FetchResponseLike = await options.fetch(url, {
        method,
        headers: await headersFor(
          body === undefined ? {} : { 'Content-Type': 'application/json' }
        ),
        ...(body === undefined ? {} : { body }),
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

  /** The document id for a key, or a failed result if CouchDB cannot hold it. */
  const idFor = <T>(key: string): { id: string } | StoreResult<T> => {
    if (LONE_SURROGATE.test(key)) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        'cannot use this key: it is not valid Unicode text'
      );
    }
    if (utf8Length(key) > MAX_KEY_BYTES) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use this key: it is longer than ${String(MAX_KEY_BYTES)} bytes`
      );
    }
    const id = `${prefix}${key}`;
    if (id === '' || id.startsWith('_')) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        'cannot use this key: document ids cannot be empty or start with "_" (give the adapter a prefix)'
      );
    }
    return { id };
  };

  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): { id: string } | StoreResult<T> => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    return idFor<T>(key);
  };

  /** A failed result for an answer whose status was not what the call expected. */
  const unexpected = <T>(
    key: string,
    verb: string,
    status: number,
    text: string
  ): StoreResult<T> => {
    const said: string = detailOf(text);
    return sqlFailure(
      LABEL,
      classifyStatus(status),
      key,
      `could not be ${verb} (HTTP ${String(status)}${said === '' ? '' : `: ${said}`})`
    );
  };

  /** Reads one document. `null` means nothing is stored (it never existed or was deleted). */
  const readDocument = async (
    key: string,
    id: string,
    signal: AbortSignal
  ): Promise<StoreResult<StoredValue | null>> => {
    const sent = await send('GET', documentUrl(id), signal);
    if (!sent.ok) {
      return sqlFailure(LABEL, sent.code, key, sent.detail);
    }
    if (sent.status === 404) {
      const reason: unknown = recordOf(sent.text)?.reason;
      if (reason === 'missing' || reason === 'deleted') {
        return { ok: true, value: null };
      }
      return sqlFailure(
        LABEL,
        'unavailable',
        key,
        `could not be read (database "${options.database}" does not exist or cannot be found: ${detailOf(sent.text)})`
      );
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

  /** Writes a document. `revision` is the one it must replace, if any. */
  const putDocument = async (
    key: string,
    id: string,
    value: string,
    revision: string | undefined,
    signal: AbortSignal
  ): Promise<
    | { readonly kind: 'written'; readonly revision: string }
    | { readonly kind: 'conflict' }
    | { readonly kind: 'failed'; readonly result: StoreResult<never> }
  > => {
    const sent = await send(
      'PUT',
      documentUrl(id),
      signal,
      JSON.stringify(
        revision === undefined ? { value } : { value, _rev: revision }
      )
    );
    if (!sent.ok) {
      return {
        kind: 'failed',
        result: sqlFailure(LABEL, sent.code, key, sent.detail),
      };
    }
    if (sent.status === 409) {
      return { kind: 'conflict' };
    }
    const written: unknown = recordOf(sent.text)?.rev;
    if (
      (sent.status === 201 || sent.status === 202) &&
      typeof written === 'string'
    ) {
      return { kind: 'written', revision: written };
    }
    return {
      kind: 'failed',
      result:
        sent.status === 201 || sent.status === 202
          ? sqlFailure(
              LABEL,
              'corrupt',
              key,
              'answered a write with something that is not a revision'
            )
          : unexpected(key, 'written', sent.status, sent.text),
    };
  };

  /* ---------------------------------------------------------------- */
  /* Change notices                                                    */
  /* ---------------------------------------------------------------- */

  const seen = new Map<string, Seen>();

  /** Tells subscribers about a write or removal unless they have already heard. */
  const settle = (
    key: string,
    revision: string,
    value: string | null
  ): void => {
    if (!listeners.has(key)) {
      return;
    }
    const generation: number = generationOf(revision);
    const known: Seen | undefined = seen.get(key);
    if (known !== undefined && generation <= known.generation) {
      return;
    }
    if (value === null && known?.removed === true) {
      seen.set(key, { generation, removed: true });
      return; // Already told it was removed.
    }
    seen.set(key, { generation, removed: value === null });
    listeners.notify(key, value === null ? null : { value, revision });
  };

  /** How many subscriptions each key has; the feed is asked about these keys. */
  const subscribed = new Map<string, number>();
  let running = 0;
  let current: AbortController | null = null;
  let since: string | null = null;
  let wake: (() => void) | null = null;
  let restartQueued = false;

  const reportChangesError = (action: string, error: unknown): void => {
    try {
      options.onChangesError?.(
        `${LABEL} could not ${action} for database "${options.database}" (${describeUnknownError(error)})`
      );
    } catch {
      // A faulty error handler must not break the adapter.
    }
  };

  /** Waits, unless listening is stopped or restarted first. */
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      (timer as { unref?: () => void }).unref?.();
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const keyOf = (id: string): string | undefined =>
    id.startsWith(prefix) ? id.slice(prefix.length) : undefined;

  /** Asks the feed for changes to the subscribed documents, until stopped or restarted. */
  const listen = async (round: number): Promise<void> => {
    while (running === round) {
      const controller = new AbortController();
      current = controller;
      const signal: AbortSignal = controller.signal;
      try {
        if (since === null) {
          const start = await send(
            'GET',
            `${databaseUrl}/_changes?since=now&limit=0`,
            signal
          );
          const startBody = start.ok ? recordOf(start.text) : null;
          if (!start.ok || start.status !== 200 || startBody === null) {
            throw new Error(
              start.ok
                ? `HTTP ${String(start.status)}: ${detailOf(start.text)}`
                : start.detail
            );
          }
          since = String(startBody.last_seq ?? '0');
        }
        // Record where each subscribed document stands, so a change that happened
        // before it was subscribed to is not mistaken for a new one.
        for (const key of subscribed.keys()) {
          if (seen.has(key)) {
            continue;
          }
          const id = idFor<never>(key);
          if (!('id' in id)) {
            continue;
          }
          const read = await readDocument(key, id.id, signal);
          if (!read.ok) {
            throw new Error(read.error);
          }
          if (running === round && !seen.has(key)) {
            seen.set(key, {
              generation:
                read.value === null
                  ? 0
                  : generationOf(read.value.revision ?? ''),
              removed: read.value === null,
            });
          }
        }
        const ids: string[] = [...subscribed.keys()].map(
          (key) => `${prefix}${key}`
        );
        const startedAt: number = Date.now();
        const query = `feed=longpoll&include_docs=true&filter=_doc_ids&timeout=${String(changesTimeoutMs)}&since=${encodeURIComponent(since)}`;
        const reply = await send(
          'POST',
          `${databaseUrl}/_changes?${query}`,
          signal,
          JSON.stringify({ doc_ids: ids })
        );
        if (running !== round) {
          return;
        }
        const body = reply.ok ? recordOf(reply.text) : null;
        if (!reply.ok || reply.status !== 200 || body === null) {
          if (reply.ok && (reply.status === 400 || reply.status === 404)) {
            since = null; // The position is not valid any more; start again from now.
          }
          throw new Error(
            reply.ok
              ? `HTTP ${String(reply.status)}: ${detailOf(reply.text)}`
              : reply.detail
          );
        }
        const results: unknown = body.results;
        for (const result of Array.isArray(results)
          ? (results as unknown[])
          : []) {
          const change = result as {
            id?: unknown;
            deleted?: unknown;
            changes?: unknown;
            doc?: unknown;
          };
          const key: string | undefined =
            typeof change.id === 'string' ? keyOf(change.id) : undefined;
          const doc = change.doc as { _rev?: unknown; value?: unknown } | null;
          const latest = (
            Array.isArray(change.changes) ? change.changes[0] : null
          ) as {
            rev?: unknown;
          } | null;
          const revision: unknown = doc?._rev ?? latest?.rev;
          if (key === undefined || typeof revision !== 'string') {
            continue;
          }
          if (change.deleted === true) {
            settle(key, revision, null);
          } else if (typeof doc?.value === 'string') {
            settle(key, revision, doc.value);
          }
        }
        if (body.last_seq !== undefined && running === round) {
          since = String(body.last_seq);
        }
        if (
          Array.isArray(results) &&
          results.length === 0 &&
          Date.now() - startedAt < QUICK_EMPTY_ANSWER_MS
        ) {
          await pause(QUICK_EMPTY_ANSWER_MS); // A server that ignores `timeout`.
        }
      } catch (error: unknown) {
        if (running !== round) {
          return;
        }
        reportChangesError('listen for changes', error);
        if (retryMs <= 0) {
          return;
        }
        await pause(retryMs);
      }
    }
  };

  const stopListening = (): void => {
    running += 1;
    current?.abort();
    current = null;
    wake?.();
    since = null;
  };

  /** Starts (or restarts, with the subscribed keys as they are now) listening. */
  const startListening = (): void => {
    running += 1;
    current?.abort();
    current = null;
    wake?.();
    void listen(running);
  };

  /** Several subscriptions made together share one restart. */
  const queueRestart = (): void => {
    if (restartQueued) {
      return;
    }
    restartQueued = true;
    void Promise.resolve().then(() => {
      restartQueued = false;
      if (subscribed.size > 0) {
        startListening();
      }
    });
  };

  /* ---------------------------------------------------------------- */

  return {
    async get(key, { signal }) {
      const checked = refusal<StoredValue | null>(key, signal);
      if (!('id' in checked)) {
        return checked;
      }
      return readDocument(key, checked.id, signal);
    },

    async set(key, value, { signal, ifRevision }) {
      const checked = refusal<StoredValue>(key, signal);
      if (!('id' in checked)) {
        return checked;
      }
      const { id } = checked;
      if (LONE_SURROGATE.test(value)) {
        return sqlFailure(
          LABEL,
          'invalid',
          key,
          'cannot store this value: it is not valid Unicode text'
        );
      }
      const finish = (revision: string): StoreResult<StoredValue> => {
        const stored: StoredValue = { value, revision };
        settle(key, revision, value);
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
        // Last write wins: replace whatever is stored, trying again if it moves.
        for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
          const read = await readDocument(key, id, signal);
          if (!read.ok) {
            return read;
          }
          const put = await putDocument(
            key,
            id,
            value,
            read.value?.revision,
            signal
          );
          if (put.kind === 'written') {
            return finish(put.revision);
          }
          if (put.kind === 'failed') {
            return put.result;
          }
        }
        return sqlFailure(
          LABEL,
          'conflict',
          key,
          `kept changing while it was being written (gave up after ${String(MAX_WRITE_ATTEMPTS)} tries)`
        );
      }

      // A revision CouchDB would not recognise can never match what is stored.
      if (REVISION_PATTERN.test(ifRevision)) {
        const put = await putDocument(key, id, value, ifRevision, signal);
        if (put.kind === 'written') {
          return finish(put.revision);
        }
        if (put.kind === 'failed') {
          return put.result;
        }
      }
      const read = await readDocument(key, id, signal);
      if (!read.ok) {
        return read;
      }
      if (read.value !== null) {
        return conflict(read.value);
      }
      // Nothing is stored, so there is no revision to differ from: create it.
      const created = await putDocument(key, id, value, undefined, signal);
      if (created.kind === 'written') {
        return finish(created.revision);
      }
      if (created.kind === 'failed') {
        return created.result;
      }
      const now = await readDocument(key, id, signal);
      return conflict(now.ok ? now.value : null);
    },

    async remove(key, { signal }) {
      const checked = refusal<null>(key, signal);
      if (!('id' in checked)) {
        return checked;
      }
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        const read = await readDocument(key, checked.id, signal);
        if (!read.ok) {
          return read;
        }
        if (read.value === null) {
          return { ok: true, value: null };
        }
        const sent = await send(
          'DELETE',
          `${documentUrl(checked.id)}?rev=${encodeURIComponent(read.value.revision ?? '')}`,
          signal
        );
        if (!sent.ok) {
          return sqlFailure(LABEL, sent.code, key, sent.detail);
        }
        if (sent.status === 200 || sent.status === 202) {
          const tombstone: unknown = recordOf(sent.text)?.rev;
          if (typeof tombstone === 'string') {
            settle(key, tombstone, null);
          }
          return { ok: true, value: null };
        }
        if (sent.status === 404) {
          return { ok: true, value: null };
        }
        if (sent.status !== 409) {
          return unexpected(key, 'removed', sent.status, sent.text);
        }
      }
      return sqlFailure(
        LABEL,
        'conflict',
        key,
        `kept changing while it was being removed (gave up after ${String(MAX_WRITE_ATTEMPTS)} tries)`
      );
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
      const fullPrefix = `${prefix}${keyPrefix}`;
      const found: string[] = [];
      let startKey: string = fullPrefix;
      for (;;) {
        const sent = await send(
          'GET',
          `${databaseUrl}/_all_docs?limit=${String(LIST_PAGE_SIZE + 1)}&startkey=${encodeURIComponent(JSON.stringify(startKey))}`,
          signal
        );
        if (!sent.ok) {
          return prefixFailure(
            LABEL,
            sent.code,
            keyPrefix,
            `could not list keys (${sent.detail})`
          );
        }
        const body = sent.status === 200 ? recordOf(sent.text) : null;
        if (body === null || !Array.isArray(body.rows)) {
          return prefixFailure(
            LABEL,
            sent.status === 200 ? 'corrupt' : classifyStatus(sent.status),
            keyPrefix,
            sent.status === 200
              ? 'could not list keys (answered with something that is not a list of rows)'
              : `could not list keys (HTTP ${String(sent.status)}: ${detailOf(sent.text)})`
          );
        }
        const rows = body.rows as { id?: unknown }[];
        const more: boolean = rows.length > LIST_PAGE_SIZE;
        let leftTheRange = false;
        for (const row of more ? rows.slice(0, LIST_PAGE_SIZE) : rows) {
          const id: unknown = row.id;
          if (typeof id !== 'string' || id.startsWith('_')) {
            continue; // Design documents and the like are not entries.
          }
          if (!id.startsWith(fullPrefix)) {
            leftTheRange = true;
            break;
          }
          found.push(id.slice(prefix.length));
        }
        const last: unknown = rows[rows.length - 1]?.id;
        if (!more || leftTheRange || typeof last !== 'string') {
          break;
        }
        startKey = last;
      }
      return { ok: true, value: found.sort(compareKeys) };
    },

    subscribe(key, onChange) {
      const unsubscribe: () => void = listeners.subscribe(key, onChange);
      const count: number = subscribed.get(key) ?? 0;
      subscribed.set(key, count + 1);
      if (count === 0) {
        queueRestart();
      }
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        unsubscribe();
        const remaining: number = (subscribed.get(key) ?? 1) - 1;
        if (remaining > 0) {
          subscribed.set(key, remaining);
          return;
        }
        subscribed.delete(key);
        seen.delete(key);
        if (subscribed.size === 0) {
          stopListening();
        }
      };
    },
  };
}
