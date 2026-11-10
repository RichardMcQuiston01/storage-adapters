/**
 * A `StorageAdapter` over a Google Drive folder. Like `/google-sheets`, this is an optional
 * entry point that imports nothing: you pass in the Drive client to use (the one from
 * `@googleapis/drive` fits), so this file never touches the network itself.
 *
 * Drive is a file store, not a database: it has no conditional write and listings can lag
 * behind recent changes. This adapter keeps one small text file per key and is best-effort
 * about `ifRevision`. See `googleDriveAdapter` for what that costs.
 */
import { describeUnknownError } from '../errors.js';
import { createChangePoller } from '../change-poller.js';
import { createKeyedQueue, type KeyedQueue } from '../keyed-queue.js';
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

/** The MIME type every entry file is stored with. */
export const ENTRY_MIME_TYPE = 'text/plain';

/** The largest value stored, in UTF-8 bytes: the limit of Drive's simple (multipart) upload. */
export const MAX_VALUE_BYTES = 5_000_000;

/** The file properties this adapter writes: the revision counter, as text. */
export interface DriveAppPropertiesLike {
  readonly [name: string]: string;
}

/** The parts of a Drive `File` resource this adapter reads. */
export interface DriveFileLike {
  id?: string | null;
  name?: string | null;
  trashed?: boolean | null;
  createdTime?: string | null;
  appProperties?: DriveAppPropertiesLike | null;
}

/** The options a request can carry; the Drive client accepts these. */
export interface DriveRequestOptionsLike {
  signal?: AbortSignal;
  /** `'text'` when reading a file's content. */
  responseType?: 'text';
}

export interface DriveListParamsLike {
  q: string;
  fields: string;
  pageSize: number;
  pageToken?: string;
  orderBy?: string;
  spaces: 'drive';
  supportsAllDrives?: boolean;
  includeItemsFromAllDrives?: boolean;
  corpora?: 'allDrives';
}

export interface DriveGetParamsLike {
  fileId: string;
  /** `'media'` reads the file's content; leave out for its properties. */
  alt?: 'media';
  fields?: string;
  supportsAllDrives?: boolean;
}

export interface DriveCreateParamsLike {
  requestBody: {
    name: string;
    mimeType: string;
    parents: string[];
    appProperties: DriveAppPropertiesLike;
  };
  media: { mimeType: string; body: string };
  fields: string;
  supportsAllDrives?: boolean;
}

export interface DriveUpdateParamsLike {
  fileId: string;
  requestBody: { appProperties: DriveAppPropertiesLike };
  media: { mimeType: string; body: string };
  fields: string;
  supportsAllDrives?: boolean;
}

export interface DriveDeleteParamsLike {
  fileId: string;
  supportsAllDrives?: boolean;
}

/** `files` of the Drive v3 API, reduced to the five calls used here. */
export interface DriveFilesLike {
  list(
    params: DriveListParamsLike,
    options?: DriveRequestOptionsLike
  ): Promise<{
    data: { files?: DriveFileLike[] | null; nextPageToken?: string | null };
  }>;
  /** Properties by default; the file's content (a string) with `alt: 'media'`. */
  get(
    params: DriveGetParamsLike,
    options?: DriveRequestOptionsLike
  ): Promise<{ data: unknown }>;
  create(
    params: DriveCreateParamsLike,
    options?: DriveRequestOptionsLike
  ): Promise<{ data: DriveFileLike }>;
  update(
    params: DriveUpdateParamsLike,
    options?: DriveRequestOptionsLike
  ): Promise<{ data: DriveFileLike }>;
  delete(
    params: DriveDeleteParamsLike,
    options?: DriveRequestOptionsLike
  ): Promise<unknown>;
}

/**
 * What this adapter needs from a Google Drive client: `files` with `list`, `get`, `create`,
 * `update` and `delete`. The client from `@googleapis/drive` or `googleapis`
 * (`drive({ version: 'v3', auth })`) fits as it is.
 */
export interface DriveClientLike {
  files: DriveFilesLike;
}

export interface GoogleDriveAdapterOptions {
  /** The Drive client. */
  readonly client: DriveClientLike;
  /**
   * The ID of the folder that holds the entries: the long part of its URL after
   * `/folders/`. It must already exist, and the account the client signs in as must be able
   * to add files to it.
   */
  readonly folderId: string;
  /**
   * Set when the folder is in a shared drive. Every request then says it supports shared
   * drives, and listings include them. Needed for a service account (see the README).
   */
  readonly sharedDrive?: boolean;
  /**
   * Milliseconds between looks at the subscribed keys for changes other people or processes
   * made (at least 50). Drive cannot announce changes to a plain API client, so `subscribe`
   * hears only this adapter's own writes unless you give this. Each look lists the folder
   * (and reads the content of any key that changed), so use a few seconds at least. Off by
   * default.
   */
  readonly pollIntervalMs?: number;
  /** Called once per run of failed polls, with a message naming the folder. */
  readonly onPollError?: (message: string) => void;
}

const LABEL = 'Google Drive';
/** Drive file names are limited in practice; keys are file names. */
const MAX_KEY_LENGTH = 255;
const MAX_DETAIL_LENGTH = 300;
const REVISION_PROPERTY = 'revision';
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const FILE_FIELDS = 'id,name,trashed,createdTime,appProperties';

function hasLoneSurrogate(text: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    text
  );
}

/** A string literal inside a Drive search query: backslash and quote are escaped. */
function queryString(text: string): string {
  return `'${text.replace(/[\\']/g, (char) => `\\${char}`)}'`;
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

/** Turns what the Drive client threw into a code and a message that says what to do. */
function describeFailure(error: unknown, signal: AbortSignal): Failed {
  if (signal.aborted) {
    return { code: 'unavailable', detail: 'request was aborted' };
  }
  const message: string = shorten(describeUnknownError(error));
  const status: number | undefined = statusOf(error);
  if (
    /storage ?quota|do not have storage quota|storageQuotaExceeded/i.test(
      message
    )
  ) {
    return {
      code: 'quota',
      detail: `${message} (the account that owns the new file has no room: a service account has no Drive storage of its own, so use a folder in a shared drive with sharedDrive: true, or sign in as a user; otherwise free up space)`,
    };
  }
  if (
    status === 403 &&
    /has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(
      message
    )
  ) {
    const project: string =
      /\bproject (\S+) before\b/i.exec(message)?.[1] ??
      'that owns the credentials';
    return {
      code: 'forbidden',
      detail: `the Google Drive API is not enabled for Google Cloud project ${project}: open https://console.cloud.google.com/apis/library/drive.googleapis.com in that project, click Enable, wait a few minutes, then try again (Google said: ${message})`,
    };
  }
  if (
    (status === 403 || status === 401) &&
    /insufficient (authentication )?scopes?|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(
      message
    )
  ) {
    return {
      code: 'forbidden',
      detail: `${message} (the credentials were not granted a Drive scope: ask for https://www.googleapis.com/auth/drive, or https://www.googleapis.com/auth/drive.file if the adapter's folder was created by the same app)`,
    };
  }
  switch (status) {
    case 429:
      return {
        code: 'unavailable',
        detail: `${message} (Google Drive is rate limiting this account: slow down, or lengthen pollIntervalMs)`,
      };
    case 401:
      return {
        code: 'forbidden',
        detail: `${message} (the client's credentials were not accepted: check the key file or token)`,
      };
    case 403:
      return /rate ?limit|quota/i.test(message)
        ? {
            code: 'unavailable',
            detail: `${message} (Google Drive is rate limiting this account: slow down)`,
          }
        : {
            code: 'forbidden',
            detail: `${message} (the account the client signs in as cannot edit this folder: share the folder with it as an Editor)`,
          };
    case 404:
      return {
        code: 'unavailable',
        detail: `${message} (not found: check folderId, which is the long part of the folder's URL after /folders/, and that the folder is shared with the account the client signs in as)`,
      };
    default:
      return {
        code: 'unavailable',
        detail: `could not be reached (${message})`,
      };
  }
}

/** One key's file, as found. */
interface Entry {
  readonly id: string;
  /** `null` when the revision property is missing or not a whole number. */
  readonly revision: string | null;
}

function revisionOf(file: DriveFileLike): string | null {
  const text: string | undefined = file.appProperties?.[REVISION_PROPERTY];
  return text !== undefined && /^[0-9]{1,15}$/.test(text) && Number(text) >= 1
    ? text
    : null;
}

function entryOf(file: DriveFileLike): Entry | null {
  return typeof file.id === 'string' && file.id !== ''
    ? { id: file.id, revision: revisionOf(file) }
    : null;
}

/** The oldest of several files for one key: the one every writer agrees is first. */
function oldest(files: readonly DriveFileLike[]): DriveFileLike | undefined {
  return [...files].sort((left, right) => {
    const byTime: number = compareKeys(
      left.createdTime ?? '',
      right.createdTime ?? ''
    );
    return byTime !== 0 ? byTime : compareKeys(left.id ?? '', right.id ?? '');
  })[0];
}

/**
 * A `StorageAdapter` over one Google Drive folder. Each key is a plain-text file named
 * after the key, holding the value, with the revision (a counter) in the file's private
 * `appProperties`. People can open the files in Drive and read them, or change a value by
 * hand.
 *
 * Drive has no conditional write, so a revision cannot be checked atomically. `set` reads
 * the file's revision, compares it with `ifRevision`, then writes the file: two writers that
 * update the same key within the moment between those two requests can both be told they
 * succeeded, and the later write wins. Creating a key is safer: Drive lets two files share
 * a name, so after creating one the adapter lists the folder, and if an older file for the
 * same key exists, deletes its own and returns `conflict`. (Drive's listings can lag, so
 * this can miss a file made a moment ago.) Writes made through one adapter object wait for
 * each other, so among them the check holds. Use this adapter where one writer changes a
 * key at a time, or accept that.
 *
 * Costs: `get` takes two requests (the file's properties, then its content), `set` two or
 * three, `remove` one or two, and `list` pages through the folder. The adapter remembers
 * each key's file ID, so repeat requests do not search by name. A value change made by
 * hand in Drive does not change `revision`, so `ifRevision` does not notice it. `remove`
 * deletes the file permanently, and a key written again starts at revision 1. A key can be
 * up to 255 characters, since it is a file name. `subscribe` reports this adapter's own
 * writes and, with `pollIntervalMs`, changes made by others. Nothing throws: every
 * failure, a network error included, is a `StoreResult`.
 */
export function googleDriveAdapter(
  options: GoogleDriveAdapterOptions
): StorageAdapter {
  const folderId: string = options.folderId.trim();
  const files: DriveFilesLike = options.client.files;
  const shared: boolean = options.sharedDrive === true;
  const where = `folder "${folderId}"`;
  const optionsProblem: string | null =
    folderId === ''
      ? 'cannot be used: folderId is empty (it is the long part of the folder URL after /folders/)'
      : null;
  const sharedFlag: { supportsAllDrives?: boolean } = shared
    ? { supportsAllDrives: true }
    : {};

  /** Each key's file, remembered so repeat requests skip the search by name. */
  const knownIds = new Map<string, string>();
  /** What each key last held, so a poll reads a file's content only after it changed. */
  const lastValues = new Map<string, StoredValue>();

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
      return { ok: false, ...describeFailure(error, signal) };
    } finally {
      if (onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
      // A request that finishes after an abort must not leave an unhandled rejection.
      aborted.catch(() => undefined);
    }
  };

  /** Lists files in the folder; `name` narrows to one name. Pages until done. */
  const listFolder = async (
    signal: AbortSignal,
    name: string | null,
    fields: string
  ): Promise<
    | { readonly ok: true; readonly files: DriveFileLike[] }
    | ({ readonly ok: false } & Failed)
  > => {
    const query: string = `${name === null ? '' : `name = ${queryString(name)} and `}${queryString(folderId)} in parents and trashed = false`;
    const found: DriveFileLike[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const token: string | undefined = pageToken;
      const answer = await call(signal, () =>
        files.list(
          {
            q: query,
            fields: `nextPageToken,files(${fields})`,
            pageSize: PAGE_SIZE,
            spaces: 'drive',
            ...(token === undefined ? {} : { pageToken: token }),
            ...(shared
              ? {
                  supportsAllDrives: true,
                  includeItemsFromAllDrives: true,
                  corpora: 'allDrives' as const,
                }
              : {}),
          },
          { signal }
        )
      );
      if (!answer.ok) {
        return answer;
      }
      found.push(...(answer.value.data.files ?? []));
      const next: string | null | undefined = answer.value.data.nextPageToken;
      if (typeof next !== 'string' || next === '') {
        return { ok: true, files: found };
      }
      pageToken = next;
    }
    return {
      ok: false,
      code: 'unavailable',
      detail: `${where} has more than ${String(MAX_PAGES * PAGE_SIZE)} files, so it cannot be listed (use a folder of its own for this adapter)`,
    };
  };

  /** The file for a key: the remembered one if it still exists, else the oldest by that name. */
  const findEntry = async (
    key: string,
    signal: AbortSignal
  ): Promise<
    | { readonly ok: true; readonly entry: Entry | null }
    | ({ readonly ok: false } & Failed)
  > => {
    const remembered: string | undefined = knownIds.get(key);
    if (remembered !== undefined) {
      const answer = await call(signal, () =>
        files.get(
          { fileId: remembered, fields: FILE_FIELDS, ...sharedFlag },
          { signal }
        )
      );
      if (answer.ok) {
        const file = answer.value.data as DriveFileLike | null;
        const entry: Entry | null =
          file !== null &&
          typeof file === 'object' &&
          file.trashed !== true &&
          file.name === key
            ? entryOf({ ...file, id: file.id ?? remembered })
            : null;
        if (entry !== null) {
          return { ok: true, entry };
        }
        knownIds.delete(key);
      } else if (/not found/i.test(answer.detail)) {
        // A file that was deleted by hand answers 404: forget it and search again.
        knownIds.delete(key);
      } else {
        return answer;
      }
    }
    const listed = await listFolder(signal, key, FILE_FIELDS);
    if (!listed.ok) {
      return listed;
    }
    // Drive may match names loosely, so keep only exact matches.
    const exact: DriveFileLike | undefined = oldest(
      listed.files.filter((file) => file.name === key)
    );
    const entry: Entry | null = exact === undefined ? null : entryOf(exact);
    if (entry !== null) {
      knownIds.set(key, entry.id);
    }
    return { ok: true, entry };
  };

  /** Reads a file's content as text. */
  const readContent = async (
    fileId: string,
    signal: AbortSignal
  ): Promise<
    | { readonly ok: true; readonly text: string }
    | ({ readonly ok: false } & Failed)
  > => {
    const answer = await call(signal, () =>
      files.get(
        { fileId, alt: 'media', ...sharedFlag },
        { signal, responseType: 'text' }
      )
    );
    if (!answer.ok) {
      return answer;
    }
    const data: unknown = answer.value.data;
    return {
      ok: true,
      text:
        typeof data === 'string'
          ? data
          : data === null || data === undefined
            ? ''
            : JSON.stringify(data),
    };
  };

  const checkKey = (key: string, signal: AbortSignal): string | null => {
    if (signal.aborted) {
      return 'request was aborted';
    }
    if (optionsProblem !== null) {
      return optionsProblem;
    }
    if (key === '') {
      return 'cannot use an empty key (a file needs a name)';
    }
    if (hasLoneSurrogate(key)) {
      return 'cannot use this key: it is not valid Unicode text';
    }
    if (key.length > MAX_KEY_LENGTH) {
      return `cannot use this key: it has ${String(key.length)} characters and the limit is ${String(MAX_KEY_LENGTH)}`;
    }
    if (key !== key.trim()) {
      return 'cannot use this key: it starts or ends with a space, which Drive file names may not keep';
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

  const corrupt = <T>(key: string): StoreResult<T> =>
    sqlFailure(
      LABEL,
      'corrupt',
      key,
      `holds a file whose revision property is missing or not a whole number (delete the file in ${where} to start again)`
    );

  /** Reads these keys together; throws if that fails. */
  const readKeys = async (
    keys: readonly string[]
  ): Promise<ReadonlyMap<string, StoredValue>> => {
    const found = new Map<string, StoredValue>();
    if (optionsProblem !== null) {
      throw new Error(optionsProblem);
    }
    const signal: AbortSignal = new AbortController().signal;
    const listed = await listFolder(signal, null, FILE_FIELDS);
    if (!listed.ok) {
      throw new Error(listed.detail);
    }
    const wanted = new Set<string>(keys);
    const byName = new Map<string, DriveFileLike[]>();
    for (const file of listed.files) {
      if (typeof file.name === 'string' && wanted.has(file.name)) {
        byName.set(file.name, [...(byName.get(file.name) ?? []), file]);
      }
    }
    for (const [name, candidates] of byName) {
      const entry: Entry | null = entryOf(oldest(candidates) ?? {});
      if (entry === null || entry.revision === null) {
        continue;
      }
      const remembered: StoredValue | undefined = lastValues.get(name);
      if (remembered?.revision === entry.revision) {
        found.set(name, remembered);
        continue;
      }
      const content = await readContent(entry.id, signal);
      if (!content.ok) {
        throw new Error(content.detail);
      }
      const stored: StoredValue = {
        value: content.text,
        revision: entry.revision,
      };
      lastValues.set(name, stored);
      found.set(name, stored);
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
      const found = await findEntry(key, signal);
      if (!found.ok) {
        return sqlFailure(
          LABEL,
          found.code,
          key,
          `could not be read (${found.detail})`
        );
      }
      if (found.entry === null) {
        return { ok: true, value: null };
      }
      if (found.entry.revision === null) {
        return corrupt(key);
      }
      const content = await readContent(found.entry.id, signal);
      if (!content.ok) {
        if (/not found/i.test(content.detail)) {
          knownIds.delete(key);
          return { ok: true, value: null };
        }
        return sqlFailure(
          LABEL,
          content.code,
          key,
          `could not be read (${content.detail})`
        );
      }
      const stored: StoredValue = {
        value: content.text,
        revision: found.entry.revision,
      };
      lastValues.set(key, stored);
      return { ok: true, value: stored };
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
      const found = await findEntry(key, signal);
      if (!found.ok) {
        return sqlFailure(
          LABEL,
          found.code,
          key,
          `could not be read before writing (${found.detail})`
        );
      }
      const entry: Entry | null = found.entry;
      if (entry !== null && entry.revision === null) {
        return corrupt(key);
      }
      if (
        entry !== null &&
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
      if (entry !== null) {
        const revision: string = String(Number(entry.revision) + 1);
        const written = await call(signal, () =>
          files.update(
            {
              fileId: entry.id,
              requestBody: { appProperties: { [REVISION_PROPERTY]: revision } },
              media: { mimeType: ENTRY_MIME_TYPE, body: value },
              fields: 'id',
              ...sharedFlag,
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
        lastValues.set(key, stored);
        poller.announce(key, stored);
        return { ok: true, value: stored };
      }
      // A new key: create the file, then check that no older file has the same name.
      const created = await call(signal, () =>
        files.create(
          {
            requestBody: {
              name: key,
              mimeType: ENTRY_MIME_TYPE,
              parents: [folderId],
              appProperties: { [REVISION_PROPERTY]: '1' },
            },
            media: { mimeType: ENTRY_MIME_TYPE, body: value },
            fields: 'id',
            ...sharedFlag,
          },
          { signal }
        )
      );
      if (!created.ok) {
        return sqlFailure(
          LABEL,
          created.code,
          key,
          `could not be written (${created.detail})`
        );
      }
      const ownId: string | null | undefined = created.value.data.id;
      if (typeof ownId !== 'string' || ownId === '') {
        return sqlFailure(
          LABEL,
          'unavailable',
          key,
          'was written but Drive did not say which file it made, so it cannot be confirmed'
        );
      }
      const listed = await listFolder(signal, key, FILE_FIELDS);
      if (!listed.ok) {
        // The file is made; only the check for a rival failed. Keep it and say nothing more.
        knownIds.set(key, ownId);
      } else {
        const winner: DriveFileLike | undefined = oldest(
          listed.files.filter((file) => file.name === key)
        );
        if (winner !== undefined && winner.id !== ownId) {
          // An older file for this key exists: it stands, ours is removed.
          await call(signal, () =>
            files.delete({ fileId: ownId, ...sharedFlag }, { signal })
          );
          return sqlFailure(
            LABEL,
            'conflict',
            key,
            'was created by another writer at the same moment, and that write won'
          );
        }
        knownIds.set(key, ownId);
      }
      const stored: StoredValue = { value, revision: '1' };
      lastValues.set(key, stored);
      poller.announce(key, stored);
      return { ok: true, value: stored };
    },

    async remove(key, { signal }) {
      const problem: string | null = checkKey(key, signal);
      if (problem !== null) {
        return refused(key, problem);
      }
      const found = await findEntry(key, signal);
      if (!found.ok) {
        return sqlFailure(
          LABEL,
          found.code,
          key,
          `could not be read before removing (${found.detail})`
        );
      }
      if (found.entry === null) {
        return { ok: true, value: null };
      }
      const entryId: string = found.entry.id;
      const removed = await call(signal, () =>
        files.delete({ fileId: entryId, ...sharedFlag }, { signal })
      );
      if (!removed.ok && !/not found/i.test(removed.detail)) {
        return sqlFailure(
          LABEL,
          removed.code,
          key,
          `could not be removed (${removed.detail})`
        );
      }
      knownIds.delete(key);
      lastValues.delete(key);
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
      const listed = await listFolder(signal, null, 'name');
      if (!listed.ok) {
        return prefixFailure(
          LABEL,
          listed.code,
          keyPrefix,
          `could not list keys (${listed.detail})`
        );
      }
      const names = new Set<string>();
      for (const file of listed.files) {
        if (typeof file.name === 'string' && file.name.startsWith(keyPrefix)) {
          names.add(file.name);
        }
      }
      return { ok: true, value: [...names].sort(compareKeys) };
    },

    subscribe(key, onChange) {
      return poller.subscribe(key, onChange);
    },
  } satisfies StorageAdapter;

  /**
   * Work on one key waits for the work before it, so `ifRevision` is reliable among the
   * writers that share this adapter, and a read sees this adapter's own earlier writes.
   */
  const queue: KeyedQueue = createKeyedQueue();

  return {
    get: (key, getOptions) =>
      queue.run(key, () => adapter.get(key, getOptions)),
    set: (key, value, setOptions) =>
      poller.trackWrite(key, () =>
        queue.run(key, () => adapter.set(key, value, setOptions))
      ),
    remove: (key, removeOptions) =>
      poller.trackWrite(key, () =>
        queue.run(key, () => adapter.remove(key, removeOptions))
      ),
    list: adapter.list,
    subscribe: adapter.subscribe,
  };
}
