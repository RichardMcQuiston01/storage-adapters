/**
 * An in-memory stand-in for the Google Drive `files` API, with the behaviour the adapter
 * relies on: a file has a name, a parent folder, text content, private `appProperties` and a
 * creation time; two files may share a name; a search is a `q` string of the two shapes the
 * adapter sends; content is read with `alt: 'media'`; a missing file or folder is a 404
 * "File not found". Two behaviours of the real service that the adapter has to cope with can
 * be switched on: names matched without regard to case, and a listing that does not show a
 * file until a few listings after it was made. Hand edits are made with `setContent`.
 * test/google-drive-live.test.ts runs the adapter against a real Drive folder.
 */
import type {
  DriveClientLike,
  DriveCreateParamsLike,
  DriveDeleteParamsLike,
  DriveFileLike,
  DriveGetParamsLike,
  DriveListParamsLike,
  DriveRequestOptionsLike,
  DriveUpdateParamsLike,
} from '../../src/google-drive/index.js';

/** The error the Google client throws: a message and an HTTP status in `code`. */
export class FakeDriveError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
  }
}

interface StoredFile {
  id: string;
  name: string;
  parents: string[];
  content: string;
  appProperties: Record<string, string>;
  trashed: boolean;
  createdTime: string;
  /** The number of listings that must pass before this file appears in one. */
  hiddenFromLists: number;
}

export interface FakeDriveRequest {
  readonly operation: 'list' | 'get' | 'create' | 'update' | 'delete';
  readonly params: unknown;
  readonly options: DriveRequestOptionsLike | undefined;
}

export interface FakeDriveOptions {
  /** Folders that exist. Defaults to `['folder-1']`. */
  readonly folders?: readonly string[];
  /** Match names in a search without regard to case, as Drive may. */
  readonly caseInsensitiveNames?: boolean;
  /** A new file is left out of this many listings. */
  readonly listLag?: number;
  /** Return at most this many files per page, to exercise paging. */
  readonly pageSize?: number;
}

/** The text a Drive query string literal stands for. */
function unquote(literal: string): string {
  return literal.replace(/\\(.)/g, '$1');
}

const STRING = String.raw`'((?:[^'\\]|\\.)*)'`;
const QUERY = new RegExp(
  `^(?:name = ${STRING} and )?${STRING} in parents and trashed = false$`
);

export class FakeDrive {
  readonly files = new Map<string, StoredFile>();
  readonly requests: FakeDriveRequest[] = [];
  /** Runs before each request is applied; a test uses it to play another writer. */
  before: ((request: FakeDriveRequest) => void | Promise<void>) | null = null;
  /** The errors to throw for the next requests, oldest first. */
  readonly failures: Error[] = [];
  private nextId = 1;
  private clock = 0;
  private readonly folders: Set<string>;

  constructor(private readonly options: FakeDriveOptions = {}) {
    this.folders = new Set(options.folders ?? ['folder-1']);
  }

  /** Makes a file as another writer would, without going through the adapter. */
  add(
    name: string,
    content: string,
    appProperties: Record<string, string> = { revision: '1' },
    parent = 'folder-1'
  ): StoredFile {
    this.clock += 1;
    const file: StoredFile = {
      id: `file-${String(this.nextId++)}`,
      name,
      parents: [parent],
      content,
      appProperties: { ...appProperties },
      trashed: false,
      createdTime: new Date(
        Date.UTC(2026, 10, 10, 12, 0, this.clock)
      ).toISOString(),
      hiddenFromLists: 0,
    };
    this.files.set(file.id, file);
    return file;
  }

  /** The files with this name, oldest first. */
  named(name: string): StoredFile[] {
    return [...this.files.values()]
      .filter((file) => file.name === name)
      .sort((left, right) => (left.createdTime < right.createdTime ? -1 : 1));
  }

  /** Replaces a file's content as editing it in Drive would: the revision is not touched. */
  setContent(id: string, content: string): void {
    const file: StoredFile | undefined = this.files.get(id);
    if (file === undefined) {
      throw new Error(`no file ${id}`);
    }
    file.content = content;
  }

  private async enter(
    operation: FakeDriveRequest['operation'],
    params: unknown,
    options: DriveRequestOptionsLike | undefined
  ): Promise<void> {
    const request: FakeDriveRequest = { operation, params, options };
    this.requests.push(request);
    await this.before?.(request);
    const failure: Error | undefined = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
  }

  private static missing(id: string): FakeDriveError {
    return new FakeDriveError(`File not found: ${id}.`, 404);
  }

  private find(id: string): StoredFile {
    const file: StoredFile | undefined = this.files.get(id);
    if (file === undefined) {
      throw FakeDrive.missing(id);
    }
    return file;
  }

  private static view(file: StoredFile): DriveFileLike {
    return {
      id: file.id,
      name: file.name,
      trashed: file.trashed,
      createdTime: file.createdTime,
      appProperties: { ...file.appProperties },
    };
  }

  readonly client: DriveClientLike = {
    files: {
      list: async (
        params: DriveListParamsLike,
        options?: DriveRequestOptionsLike
      ) => {
        await this.enter('list', params, options);
        const match: RegExpMatchArray | null = QUERY.exec(params.q);
        if (match === null) {
          throw new FakeDriveError(`Invalid Value: ${params.q}`, 400);
        }
        const name: string | undefined =
          match[1] === undefined ? undefined : unquote(match[1]);
        const folder: string = unquote(match[2] ?? '');
        if (!this.folders.has(folder)) {
          throw FakeDrive.missing(folder);
        }
        const visible: StoredFile[] = [];
        for (const file of this.files.values()) {
          if (file.hiddenFromLists > 0) {
            file.hiddenFromLists -= 1;
            continue;
          }
          const sameName: boolean =
            name === undefined ||
            (this.options.caseInsensitiveNames === true
              ? file.name.toLowerCase() === name.toLowerCase()
              : file.name === name);
          if (file.parents.includes(folder) && !file.trashed && sameName) {
            visible.push(file);
          }
        }
        const size: number = Math.min(
          params.pageSize,
          this.options.pageSize ?? params.pageSize
        );
        const start: number =
          params.pageToken === undefined ? 0 : Number(params.pageToken);
        const page: StoredFile[] = visible.slice(start, start + size);
        const more: boolean = start + size < visible.length;
        return {
          data: {
            files: page.map((file) => FakeDrive.view(file)),
            nextPageToken: more ? String(start + size) : null,
          },
        };
      },

      get: async (
        params: DriveGetParamsLike,
        options?: DriveRequestOptionsLike
      ) => {
        await this.enter('get', params, options);
        const file: StoredFile = this.find(params.fileId);
        return {
          data: params.alt === 'media' ? file.content : FakeDrive.view(file),
        };
      },

      create: async (
        params: DriveCreateParamsLike,
        options?: DriveRequestOptionsLike
      ) => {
        await this.enter('create', params, options);
        for (const parent of params.requestBody.parents) {
          if (!this.folders.has(parent)) {
            throw FakeDrive.missing(parent);
          }
        }
        const file: StoredFile = this.add(
          params.requestBody.name,
          params.media.body,
          params.requestBody.appProperties,
          params.requestBody.parents[0]
        );
        file.hiddenFromLists = this.options.listLag ?? 0;
        return { data: { id: file.id } };
      },

      update: async (
        params: DriveUpdateParamsLike,
        options?: DriveRequestOptionsLike
      ) => {
        await this.enter('update', params, options);
        const file: StoredFile = this.find(params.fileId);
        file.content = params.media.body;
        Object.assign(file.appProperties, params.requestBody.appProperties);
        return { data: { id: file.id } };
      },

      delete: async (
        params: DriveDeleteParamsLike,
        options?: DriveRequestOptionsLike
      ) => {
        await this.enter('delete', params, options);
        this.find(params.fileId);
        this.files.delete(params.fileId);
        return {};
      },
    },
  };
}
