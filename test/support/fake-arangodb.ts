/**
 * An in-memory stand-in for the part of ArangoDB's HTTP API the adapter uses, as a
 * `fetch`, following the documented behaviour: documents with `_rev`s, a `POST` that
 * can create (409 when the key exists) or replace (`overwriteMode=replace`), a `PUT`
 * guarded by `If-Match` (412 when stale, 404 when missing), a `DELETE`, collections
 * that can be created, and AQL cursors that hand out rows in batches. The two AQL
 * queries the adapter sends are recognised by their text. test/arangodb-server.test.ts
 * runs the adapter against a real server.
 */
import type { FetchLike, FetchResponseLike } from '../../src/rest/index.js';

interface FakeDocument {
  revision: string;
  value: string;
}

/** A canned answer for the next request. */
export interface FakeFailure {
  readonly status?: number;
  readonly body?: string;
  readonly error?: Error;
}

function reply(status: number, body: unknown): FetchResponseLike {
  const text: string = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(text),
  };
}

function problem(
  status: number,
  errorNum: number,
  errorMessage: string
): FetchResponseLike {
  return reply(status, { error: true, code: status, errorNum, errorMessage });
}

export class FakeArangoDb {
  /** Documents by collection name, then `_key`. */
  readonly collections = new Map<string, Map<string, FakeDocument>>();
  /** `METHOD path?query` for each request, in order. */
  readonly requests: string[] = [];
  /** Headers of each request, in order. */
  readonly sentHeaders: Record<string, string>[] = [];
  /** Answers to give to the next requests, in order, before the normal ones. */
  readonly failures: FakeFailure[] = [];
  /** Runs just before a `POST` or `PUT` of a document is applied, to simulate another writer. */
  beforeWrite: ((collection: string, key: string) => void) | null = null;
  private counter = 0;
  private cursorCounter = 0;
  private readonly cursors = new Map<string, unknown[]>();

  constructor(
    readonly database = '_system',
    collections: readonly string[] = []
  ) {
    for (const name of collections) {
      this.collections.set(name, new Map());
    }
  }

  private newRevision(): string {
    this.counter += 1;
    return `_${this.counter.toString(36).padStart(8, '0')}---`;
  }

  /** Writes behind the adapter's back, as another process would. */
  put(collection: string, key: string, value: string): string {
    const documents =
      this.collections.get(collection) ?? new Map<string, FakeDocument>();
    this.collections.set(collection, documents);
    const revision: string = this.newRevision();
    documents.set(key, { revision, value });
    return revision;
  }

  /** Deletes behind the adapter's back. */
  delete(collection: string, key: string): void {
    this.collections.get(collection)?.delete(key);
  }

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    this.requests.push(`${init.method} ${parsed.pathname}${parsed.search}`);
    this.sentHeaders.push({ ...init.headers });
    const failure: FakeFailure | undefined = this.failures.shift();
    if (failure !== undefined) {
      if (failure.error !== undefined) {
        throw failure.error;
      }
      return reply(failure.status ?? 500, failure.body ?? '');
    }
    const parts: string[] = parsed.pathname
      .split('/')
      .map((part) => decodeURIComponent(part));
    // ['', '_db', db, '_api', area, ...rest]
    const [, underscoreDb, database, underscoreApi, area, ...rest] = parts;
    if (underscoreDb !== '_db' || underscoreApi !== '_api') {
      return problem(404, 404, 'unknown path');
    }
    if (database !== this.database) {
      return problem(404, 1228, 'database not found');
    }
    const body: Record<string, unknown> =
      init.body === undefined
        ? {}
        : (JSON.parse(init.body) as Record<string, unknown>);

    if (area === 'collection' && init.method === 'POST') {
      const name = String(body.name);
      if (this.collections.has(name)) {
        return problem(409, 1207, 'duplicate name');
      }
      this.collections.set(name, new Map());
      return reply(200, { error: false, code: 200, name });
    }
    if (area === 'cursor') {
      return this.cursor(init.method, rest[0], body);
    }
    if (area !== 'document') {
      return problem(404, 404, 'unknown path');
    }
    const [collectionName, key] = rest;
    const documents =
      collectionName === undefined
        ? undefined
        : this.collections.get(collectionName);
    if (collectionName === undefined || documents === undefined) {
      return problem(404, 1203, 'collection or view not found');
    }
    switch (init.method) {
      case 'GET': {
        const found = key === undefined ? undefined : documents.get(key);
        if (key === undefined || found === undefined) {
          return problem(404, 1202, 'document not found');
        }
        return reply(200, {
          _key: key,
          _id: `${collectionName}/${key}`,
          _rev: found.revision,
          value: found.value,
        });
      }
      case 'POST': {
        const newKey = String(body._key);
        this.beforeWrite?.(collectionName, newKey);
        const replace = parsed.searchParams.get('overwriteMode') === 'replace';
        if (documents.has(newKey) && !replace) {
          return problem(409, 1210, 'unique constraint violated');
        }
        const revision: string = this.put(
          collectionName,
          newKey,
          String(body.value)
        );
        return reply(202, {
          _id: `${collectionName}/${newKey}`,
          _key: newKey,
          _rev: revision,
        });
      }
      case 'PUT': {
        const existing = key === undefined ? undefined : documents.get(key);
        if (key === undefined || existing === undefined) {
          return problem(404, 1202, 'document not found');
        }
        this.beforeWrite?.(collectionName, key);
        const current = documents.get(key);
        if (current === undefined) {
          return problem(404, 1202, 'document not found');
        }
        const ifMatch: string | undefined = init.headers['If-Match'];
        if (
          ifMatch !== undefined &&
          ifMatch.replace(/^"|"$/g, '') !== current.revision
        ) {
          return reply(412, {
            error: true,
            code: 412,
            errorNum: 1200,
            errorMessage: 'precondition failed',
            _key: key,
            _rev: current.revision,
          });
        }
        const revision: string = this.put(
          collectionName,
          key,
          String(body.value)
        );
        return reply(202, {
          _id: `${collectionName}/${key}`,
          _key: key,
          _rev: revision,
          _oldRev: current.revision,
        });
      }
      case 'DELETE': {
        const existing = key === undefined ? undefined : documents.get(key);
        if (key === undefined || existing === undefined) {
          return problem(404, 1202, 'document not found');
        }
        documents.delete(key);
        return reply(202, {
          _id: `${collectionName}/${key}`,
          _key: key,
          _rev: existing.revision,
        });
      }
      default:
        return problem(405, 405, 'method not allowed');
    }
  };

  private cursor(
    method: string,
    id: string | undefined,
    body: Record<string, unknown>
  ): FetchResponseLike {
    if (method === 'PUT' && id !== undefined) {
      const remaining = this.cursors.get(id);
      if (remaining === undefined) {
        return problem(404, 1600, 'cursor not found');
      }
      return this.batch(
        id,
        remaining,
        Number(this.cursorBatch.get(id) ?? 1000)
      );
    }
    const query = String(body.query);
    const bindVars = (body.bindVars ?? {}) as Record<string, unknown>;
    const collectionName = String(bindVars['@collection']);
    const documents = this.collections.get(collectionName);
    if (documents === undefined) {
      return problem(404, 1203, 'collection or view not found');
    }
    let rows: unknown[];
    if (query.includes('STARTS_WITH')) {
      const prefix = String(bindVars.prefix);
      rows = [...documents.keys()].filter((key) => key.startsWith(prefix));
    } else if (query.includes('IN @names')) {
      const names = new Set(bindVars.names as string[]);
      rows = [...documents.entries()]
        .filter(([key]) => names.has(key))
        .map(([key, found]) => ({
          name: key,
          revision: found.revision,
          value: found.value,
        }));
    } else {
      return problem(400, 1501, 'unsupported query in the fake');
    }
    this.cursorCounter += 1;
    const created = String(this.cursorCounter);
    const size = Number(body.batchSize ?? 1000);
    this.cursorBatch.set(created, size);
    this.cursors.set(created, rows);
    return this.batch(created, rows, size, 201);
  }

  private readonly cursorBatch = new Map<string, number>();

  private batch(
    id: string,
    rows: unknown[],
    size: number,
    status = 200
  ): FetchResponseLike {
    const result = rows.splice(0, size);
    const hasMore = rows.length > 0;
    if (!hasMore) {
      this.cursors.delete(id);
    }
    return reply(status, {
      error: false,
      code: status,
      result,
      hasMore,
      ...(hasMore ? { id } : {}),
    });
  }
}
