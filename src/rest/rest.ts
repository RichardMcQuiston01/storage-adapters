/**
 * A `StorageAdapter` over a remote JSON key-value API. Like `/postgres` and `/s3`,
 * this is an optional entry point that imports nothing: you pass in the `fetch` to
 * use (the global one, `undici`, a wrapper that adds retries or logging), so this
 * file never touches the network itself.
 *
 * The API it talks to is small, and the README describes it in full:
 *
 *   GET    {baseUrl}/{key}        200 {"value": "...", "revision": "..."}   404 = nothing stored
 *   PUT    {baseUrl}/{key}        body {"value": "..."}, optional If-Match: <revision>
 *   DELETE {baseUrl}/{key}        200, 202, 204 or 404
 *   GET    {baseUrl}?prefix=...   200 {"keys": ["...", ...]}   (optional)
 */
import { describeUnknownError } from '../errors.js';
import { createChangeListeners, sqlFailure } from '../sql-shared.js';
import {
  compareKeys,
  prefixFailure,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** The part of a `Response` this adapter reads. The global `Response` fits. */
export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The part of `fetch` this adapter uses. The global `fetch` fits. */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal: AbortSignal;
  }
) => Promise<FetchResponseLike>;

export type RestHeaders = Readonly<Record<string, string>>;

export interface RestAdapterOptions {
  /** The API's root, for example `https://api.example.com/storage`. No trailing slash needed. */
  readonly baseUrl: string;
  /** The `fetch` to send requests with. */
  readonly fetch: FetchLike;
  /**
   * Sent with every request, for example an `Authorization` header. A function is
   * called for each request, so a token can be refreshed; it may be async.
   */
  readonly headers?: RestHeaders | (() => RestHeaders | Promise<RestHeaders>);
  /** Names the service in messages, for example `"Settings API"`. Defaults to `"REST API"`. */
  readonly name?: string;
}

const DEFAULT_NAME = 'REST API';
/** A conditional write is retried this many times if its key keeps appearing and vanishing. */
const MAX_WRITE_ATTEMPTS = 3;
/** How much of an error body goes into a message. */
const MAX_DETAIL_LENGTH = 200;

/** Maps an HTTP status to a code. */
function classifyStatus(status: number): StoreErrorCode {
  if (status === 401 || status === 403) {
    return 'forbidden';
  }
  if (status === 402 || status === 413 || status === 507) {
    return 'quota';
  }
  if (status === 400 || status === 405 || status === 415 || status === 422) {
    return 'invalid';
  }
  return 'unavailable';
}

/** What the server said about an error: its `error` or `message` field, or the start of its body. */
function detailOf(body: string): string {
  let text: string = body.trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const fields = parsed as { error?: unknown; message?: unknown };
      const said: unknown = fields.error ?? fields.message;
      if (typeof said === 'string') {
        text = said;
      }
    }
  } catch {
    // Not JSON: use the text as it is.
  }
  return text.length > MAX_DETAIL_LENGTH
    ? `${text.slice(0, MAX_DETAIL_LENGTH)}...`
    : text;
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

/**
 * A `StorageAdapter` over a JSON key-value API. `set` with `ifRevision` sends
 * `If-Match`; the server answers 412 (or 409) when the revision is stale, which
 * becomes `conflict`. A server that answers 404 or 412 for a key with nothing stored
 * is asked again with `If-None-Match: *`, so the key is created, as the contract
 * says. `subscribe` reports changes made through the same adapter. Nothing throws:
 * every failure, a network error included, is a `StoreResult`.
 */
export function restAdapter(options: RestAdapterOptions): StorageAdapter {
  const baseUrl: string = options.baseUrl.replace(/\/+$/, '');
  const label: string = options.name ?? DEFAULT_NAME;
  const listeners = createChangeListeners();

  const urlOf = (key: string): string =>
    `${baseUrl}/${encodeURIComponent(key)}`;

  const headersFor = async (
    extra: Record<string, string>
  ): Promise<Record<string, string>> => {
    const configured: RestHeaders | undefined =
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
    extra: Record<string, string> = {},
    body?: string
  ): Promise<
    | {
        readonly ok: true;
        readonly response: FetchResponseLike;
        readonly text: string;
      }
    | {
        readonly ok: false;
        readonly code: StoreErrorCode;
        readonly detail: string;
      }
  > => {
    try {
      const response: FetchResponseLike = await options.fetch(url, {
        method,
        headers: await headersFor(extra),
        ...(body === undefined ? {} : { body }),
        signal,
      });
      return { ok: true, response, text: await response.text() };
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
  ): StoreResult<T> | null => {
    if (signal.aborted) {
      return sqlFailure(label, 'unavailable', key, 'request was aborted');
    }
    if (key === '') {
      return sqlFailure(label, 'invalid', key, 'cannot use an empty key');
    }
    return null;
  };

  /** A failed result for a response whose status was not what the call expected. */
  const unexpected = <T>(
    key: string,
    verb: string,
    status: number,
    text: string
  ): StoreResult<T> => {
    const said: string = detailOf(text);
    return sqlFailure(
      label,
      classifyStatus(status),
      key,
      `could not be ${verb} (HTTP ${status}${said === '' ? '' : `: ${said}`})`
    );
  };

  /** The revision a response carries: its JSON `revision`, otherwise its `ETag` header. */
  const revisionOf = (
    response: FetchResponseLike,
    body: Record<string, unknown> | null
  ): string | undefined => {
    const fromBody: unknown = body?.revision;
    if (typeof fromBody === 'string' && fromBody !== '') {
      return fromBody;
    }
    if (typeof fromBody === 'number' && Number.isFinite(fromBody)) {
      return String(fromBody);
    }
    const etag: string | null = response.headers.get('ETag');
    return etag === null || etag === '' ? undefined : etag;
  };

  /** The revision the server holds now, `null` if nothing is stored there. */
  const currentRevision = async (
    key: string,
    signal: AbortSignal
  ): Promise<StoreResult<string | null>> => {
    const sent = await send('GET', urlOf(key), signal);
    if (!sent.ok) {
      return sqlFailure(label, sent.code, key, sent.detail);
    }
    if (sent.response.status === 404) {
      return { ok: true, value: null };
    }
    if (sent.response.status !== 200) {
      return unexpected(key, 'read', sent.response.status, sent.text);
    }
    const body = recordOf(sent.text);
    return { ok: true, value: revisionOf(sent.response, body) ?? '' };
  };

  return {
    async get(key, { signal }) {
      const refused = refusal<StoredValue | null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      const sent = await send('GET', urlOf(key), signal);
      if (!sent.ok) {
        return sqlFailure(label, sent.code, key, sent.detail);
      }
      if (sent.response.status === 404) {
        return { ok: true, value: null };
      }
      if (sent.response.status !== 200) {
        return unexpected(key, 'read', sent.response.status, sent.text);
      }
      const body = recordOf(sent.text);
      if (body === null || typeof body.value !== 'string') {
        return sqlFailure(
          label,
          'corrupt',
          key,
          'answered a read with something that is not {"value": "..."}'
        );
      }
      const revision: string | undefined = revisionOf(sent.response, body);
      return {
        ok: true,
        value:
          revision === undefined
            ? { value: body.value }
            : { value: body.value, revision },
      };
    },

    async set(key, value, { signal, ifRevision }) {
      const refused = refusal<StoredValue>(key, signal);
      if (refused !== null) {
        return refused;
      }
      const payload: string = JSON.stringify({ value });
      // The first try carries the caller's revision. If the server then says the
      // key is not there, the next creates it, then loops if someone beat us to it.
      let mode: 'checked' | 'create' | 'plain' =
        ifRevision === undefined ? 'plain' : 'checked';
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        const conditions: Record<string, string> =
          mode === 'checked'
            ? { 'If-Match': ifRevision ?? '' }
            : mode === 'create'
              ? { 'If-None-Match': '*' }
              : {};
        const sent = await send(
          'PUT',
          urlOf(key),
          signal,
          { 'Content-Type': 'application/json', ...conditions },
          payload
        );
        if (!sent.ok) {
          return sqlFailure(label, sent.code, key, sent.detail);
        }
        const status: number = sent.response.status;
        if (status === 200 || status === 201 || status === 204) {
          const revision: string | undefined = revisionOf(
            sent.response,
            recordOf(sent.text)
          );
          const stored: StoredValue =
            revision === undefined ? { value } : { value, revision };
          listeners.notify(key, stored);
          return { ok: true, value: stored };
        }
        if (mode === 'create' && (status === 412 || status === 409)) {
          // Someone created it first: it is there now, so check against it again.
          mode = 'checked';
          continue;
        }
        if (
          mode === 'checked' &&
          (status === 412 || status === 409 || status === 404)
        ) {
          const current = await currentRevision(key, signal);
          if (!current.ok) {
            return current;
          }
          if (current.value === null) {
            mode = 'create'; // Nothing stored, so there is nothing to conflict with.
            continue;
          }
          return sqlFailure(
            label,
            'conflict',
            key,
            `holds revision ${current.value}, but revision ${ifRevision ?? ''} was expected`
          );
        }
        return unexpected(key, 'written', status, sent.text);
      }
      return sqlFailure(
        label,
        'unavailable',
        key,
        'changed too often to be written'
      );
    },

    async remove(key, { signal }) {
      const refused = refusal<null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      const sent = await send('DELETE', urlOf(key), signal);
      if (!sent.ok) {
        return sqlFailure(label, sent.code, key, sent.detail);
      }
      const status: number = sent.response.status;
      if (
        status !== 200 &&
        status !== 202 &&
        status !== 204 &&
        status !== 404
      ) {
        return unexpected(key, 'removed', status, sent.text);
      }
      listeners.notify(key, null);
      return { ok: true, value: null };
    },

    async list(prefix, { signal }) {
      if (signal.aborted) {
        return prefixFailure(
          label,
          'unavailable',
          prefix,
          'request to list keys was aborted'
        );
      }
      const sent = await send(
        'GET',
        `${baseUrl}?prefix=${encodeURIComponent(prefix)}`,
        signal
      );
      if (!sent.ok) {
        return prefixFailure(label, sent.code, prefix, sent.detail);
      }
      const status: number = sent.response.status;
      if (status === 404 || status === 405 || status === 501) {
        return prefixFailure(
          label,
          'invalid',
          prefix,
          `cannot list keys: the server answered GET ${baseUrl}?prefix= with HTTP ${status}`
        );
      }
      if (status !== 200) {
        const said: string = detailOf(sent.text);
        return prefixFailure(
          label,
          classifyStatus(status),
          prefix,
          `could not list keys (HTTP ${status}${said === '' ? '' : `: ${said}`})`
        );
      }
      const body = recordOf(sent.text);
      const keys: unknown = body?.keys;
      if (
        !Array.isArray(keys) ||
        !keys.every((key) => typeof key === 'string')
      ) {
        return prefixFailure(
          label,
          'corrupt',
          prefix,
          'answered a listing with something that is not {"keys": ["..."]}'
        );
      }
      return {
        ok: true,
        // Asked for by prefix, but filtered again so a server that ignores it is harmless.
        value: (keys as string[])
          .filter((key) => key.startsWith(prefix))
          .sort(compareKeys),
      };
    },

    subscribe: listeners.subscribe,
  };
}
