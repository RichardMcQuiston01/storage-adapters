/**
 * An in-memory stand-in for the part of CouchDB's HTTP API the adapter uses, as a
 * `fetch`: documents with `_rev`s that must match to be replaced, deletions that
 * leave a marker, `_all_docs` in id order, and a long-polling `_changes` feed
 * filtered by `doc_ids`. test/couchdb-server.test.ts runs the adapter against a
 * real server.
 */
import type { FetchLike, FetchResponseLike } from '../../src/rest/index.js';

interface FakeDocument {
  generation: number;
  revision: string;
  value: string;
  deleted: boolean;
}

interface Change {
  seq: number;
  id: string;
  revision: string;
  deleted: boolean;
  value: string;
}

interface Waiter {
  ids: Set<string>;
  since: number;
  resolve: () => void;
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

export class FakeCouchDb {
  readonly documents = new Map<string, FakeDocument>();
  /** `METHOD path?query` for each request, in order. */
  readonly requests: string[] = [];
  /** Answers to give to the next requests, in order, before the normal ones. */
  readonly failures: FakeFailure[] = [];
  private readonly log: Change[] = [];
  private sequence = 0;
  private counter = 0;
  private readonly waiters = new Set<Waiter>();
  openChangesRequests = 0;

  constructor(readonly database = 'settings') {
    // Not an entry: the adapter must skip it when listing.
    this.documents.set('_design/views', {
      generation: 1,
      revision: this.newRevision(1),
      value: '',
      deleted: false,
    });
  }

  private newRevision(generation: number): string {
    this.counter += 1;
    return `${String(generation)}-${this.counter.toString(16).padStart(32, '0')}`;
  }

  private write(id: string, value: string, deleted: boolean): FakeDocument {
    const generation: number = (this.documents.get(id)?.generation ?? 0) + 1;
    const document: FakeDocument = {
      generation,
      revision: this.newRevision(generation),
      value,
      deleted,
    };
    this.documents.set(id, document);
    this.sequence += 1;
    this.log.push({
      seq: this.sequence,
      id,
      revision: document.revision,
      deleted,
      value,
    });
    for (const waiter of [...this.waiters]) {
      if (waiter.ids.has(id)) {
        waiter.resolve();
      }
    }
    return document;
  }

  /** Writes behind the adapter's back, as another process would. */
  put(id: string, value: string): string {
    return this.write(id, value, false).revision;
  }

  /** Deletes behind the adapter's back. */
  delete(id: string): void {
    this.write(id, '', true);
  }

  private changesSince(since: number, ids: Set<string>): Change[] {
    const latest = new Map<string, Change>();
    for (const change of this.log) {
      if (change.seq > since && ids.has(change.id)) {
        latest.set(change.id, change);
      }
    }
    return [...latest.values()].sort((a, b) => a.seq - b.seq);
  }

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    this.requests.push(`${init.method} ${parsed.pathname}${parsed.search}`);
    const failure: FakeFailure | undefined = this.failures.shift();
    if (failure !== undefined) {
      if (failure.error !== undefined) {
        throw failure.error;
      }
      return reply(failure.status ?? 500, failure.body ?? '');
    }
    const [, database, rawId, ...rest] = parsed.pathname
      .split('/')
      .map((part) => decodeURIComponent(part));
    if (database !== this.database) {
      return reply(404, {
        error: 'not_found',
        reason: 'Database does not exist.',
      });
    }
    if (rawId === '_changes') {
      return this.changes(parsed, init);
    }
    if (rawId === '_all_docs') {
      return this.allDocuments(parsed);
    }
    const id: string = [rawId, ...rest].join('/');
    const current: FakeDocument | undefined = this.documents.get(id);
    const alive: boolean = current !== undefined && !current.deleted;
    switch (init.method) {
      case 'GET':
        if (current === undefined || current.deleted) {
          return reply(404, {
            error: 'not_found',
            reason: current === undefined ? 'missing' : 'deleted',
          });
        }
        return reply(200, {
          _id: id,
          _rev: current.revision,
          value: current.value,
        });
      case 'PUT': {
        const body = JSON.parse(init.body ?? '{}') as {
          value?: string;
          _rev?: string;
        };
        if (typeof body.value !== 'string') {
          return reply(400, {
            error: 'bad_request',
            reason: 'Document must have a value',
          });
        }
        const expected: string | undefined = body._rev;
        const matches: boolean = alive
          ? expected === current?.revision
          : expected === undefined || expected === current?.revision;
        if (!matches) {
          return reply(409, {
            error: 'conflict',
            reason: 'Document update conflict.',
          });
        }
        const written = this.write(id, body.value, false);
        return reply(201, { ok: true, id, rev: written.revision });
      }
      case 'DELETE': {
        if (!alive) {
          return reply(404, { error: 'not_found', reason: 'missing' });
        }
        if (parsed.searchParams.get('rev') !== current?.revision) {
          return reply(409, {
            error: 'conflict',
            reason: 'Document update conflict.',
          });
        }
        const written = this.write(id, '', true);
        return reply(200, { ok: true, id, rev: written.revision });
      }
      default:
        return reply(405, { error: 'method_not_allowed' });
    }
  };

  private allDocuments(parsed: URL): FetchResponseLike {
    const startKey = JSON.parse(
      parsed.searchParams.get('startkey') ?? '""'
    ) as string;
    const limit = Number(parsed.searchParams.get('limit') ?? '1000000');
    const rows = [...this.documents.entries()]
      .filter(([id, document]) => !document.deleted && id >= startKey)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, limit)
      .map(([id, document]) => ({
        id,
        key: id,
        value: { rev: document.revision },
      }));
    return reply(200, { total_rows: this.documents.size, offset: 0, rows });
  }

  private async changes(
    parsed: URL,
    init: Parameters<FetchLike>[1]
  ): Promise<FetchResponseLike> {
    const since: string = parsed.searchParams.get('since') ?? '0';
    if (parsed.searchParams.get('feed') !== 'longpoll') {
      return reply(200, {
        results: [],
        last_seq: since === 'now' ? String(this.sequence) : since,
        pending: 0,
      });
    }
    if (!/^[0-9]+$/.test(since)) {
      return reply(400, {
        error: 'bad_request',
        reason: "Malformed sequence supplied in 'since' parameter.",
      });
    }
    const ids = new Set<string>(
      (JSON.parse(init.body ?? '{}') as { doc_ids?: string[] }).doc_ids ?? []
    );
    const answer = (): FetchResponseLike => {
      const results = this.changesSince(Number(since), ids).map((change) => ({
        seq: String(change.seq),
        id: change.id,
        changes: [{ rev: change.revision }],
        ...(change.deleted ? { deleted: true } : {}),
        doc: change.deleted
          ? { _id: change.id, _rev: change.revision, _deleted: true }
          : { _id: change.id, _rev: change.revision, value: change.value },
      }));
      return reply(200, {
        results,
        last_seq: String(this.sequence),
        pending: 0,
      });
    };
    if (this.changesSince(Number(since), ids).length > 0) {
      return answer();
    }
    this.openChangesRequests += 1;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeoutMs = Number(parsed.searchParams.get('timeout') ?? '60000');
        const waiter: Waiter = {
          ids,
          since: Number(since),
          resolve: () => finish(),
        };
        const timer = setTimeout(() => finish(), timeoutMs);
        const finish = (): void => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          init.signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          reject(new Error('The operation was aborted.'));
        };
        if (init.signal.aborted) {
          onAbort();
          return;
        }
        init.signal.addEventListener('abort', onAbort);
        this.waiters.add(waiter);
      });
    } finally {
      this.openChangesRequests -= 1;
    }
    return answer();
  }
}
