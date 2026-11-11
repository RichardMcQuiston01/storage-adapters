/**
 * Two in-memory stand-ins for Google Cloud Storage.
 *
 * `FakeGcsStore` is a `GcsStoreLike`: objects with a generation that changes on every write,
 * and `ifGenerationMatch` checked the way GCS checks it (`'0'` means only if there is no
 * object; any other value must equal the current generation, else HTTP 412).
 *
 * `FakeGcsBucket` is shaped like a `Bucket` of `@google-cloud/storage` (`file`, `getFiles`,
 * and a `File` with `getMetadata`, `download`, `save` and `delete`), with the behaviour
 * `gcsObjectStore` relies on, taken from the client's source: `save` fills in `file.metadata`
 * from the upload's answer, a `File` made with a generation reads exactly that generation
 * (404 once it has been replaced), and a missing object is an error with `code: 404`.
 * test/gcs-live.test.ts runs the adapter against a real bucket.
 */
import type {
  GcsBucketLike,
  GcsFileLike,
  GcsObjectLike,
  GcsStoreLike,
} from '../../src/gcs/index.js';

/** The error the Google client throws: a message and an HTTP status in `code`. */
export class FakeGcsError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
  }
}

export interface FakeGcsStoreOptions {
  /** A conditional write to a missing object answers 404 instead of 412. */
  readonly missingIsNotFound?: boolean;
}

export interface FakeGcsStoreRequest {
  readonly operation: 'get' | 'put' | 'delete' | 'list';
  readonly key: string;
  readonly ifGenerationMatch?: string | undefined;
}

export class FakeGcsStore implements GcsStoreLike {
  readonly objects = new Map<string, { body: string; generation: string }>();
  readonly requests: FakeGcsStoreRequest[] = [];
  /** Runs before each request is applied; a test uses it to play another writer. */
  before: ((request: FakeGcsStoreRequest) => void | Promise<void>) | null =
    null;
  /** The errors to throw for the next requests, oldest first. */
  readonly failures: Error[] = [];
  private nextGeneration = 1_731_200_000_000_000;

  constructor(private readonly options: FakeGcsStoreOptions = {}) {}

  /** Writes as another writer would, without any condition. */
  write(key: string, body: string): string {
    this.nextGeneration += 1_000;
    const generation: string = String(this.nextGeneration);
    this.objects.set(key, { body, generation });
    return generation;
  }

  private async enter(request: FakeGcsStoreRequest): Promise<void> {
    this.requests.push(request);
    await this.before?.(request);
    const failure: Error | undefined = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
  }

  async getObject(key: string): Promise<GcsObjectLike | null> {
    await this.enter({ operation: 'get', key });
    const found = this.objects.get(key);
    return found === undefined ? null : { ...found };
  }

  async putObject(
    key: string,
    body: string,
    options: { readonly ifGenerationMatch?: string }
  ): Promise<{ readonly generation: string }> {
    await this.enter({
      operation: 'put',
      key,
      ifGenerationMatch: options.ifGenerationMatch,
    });
    const match: string | undefined = options.ifGenerationMatch;
    const current = this.objects.get(key);
    if (match !== undefined) {
      if (
        match === '0' ? current !== undefined : current?.generation !== match
      ) {
        throw new FakeGcsError(
          current === undefined && this.options.missingIsNotFound === true
            ? 'No such object.'
            : 'Precondition Failed',
          current === undefined && this.options.missingIsNotFound === true
            ? 404
            : 412
        );
      }
    }
    return { generation: this.write(key, body) };
  }

  async deleteObject(key: string): Promise<void> {
    await this.enter({ operation: 'delete', key });
    this.objects.delete(key);
  }

  async listKeys(prefix: string): Promise<string[]> {
    await this.enter({ operation: 'list', key: prefix });
    return [...this.objects.keys()].filter((name) => name.startsWith(prefix));
  }
}

interface FakeObject {
  data: Uint8Array;
  generation: string;
}

export interface FakeGcsBucketRequest {
  readonly operation:
    'getMetadata' | 'download' | 'save' | 'delete' | 'getFiles';
  readonly name: string;
  readonly options?: unknown;
}

export class FakeGcsBucket implements GcsBucketLike {
  readonly objects = new Map<string, FakeObject>();
  readonly requests: FakeGcsBucketRequest[] = [];
  /** Runs before each request is applied. */
  before: ((request: FakeGcsBucketRequest) => void | Promise<void>) | null =
    null;
  /** The errors to throw for the next requests, oldest first. */
  readonly failures: Error[] = [];
  /** Leave the generation out of `getMetadata`'s answer. */
  hideGenerationInMetadata = false;
  /** Leave `file.metadata` empty after a save. */
  hideMetadataAfterSave = false;
  private nextGeneration = 1_731_200_000_000_000;

  /** Writes as another writer would. */
  put(name: string, text: string | Uint8Array): string {
    this.nextGeneration += 1_000;
    const generation: string = String(this.nextGeneration);
    this.objects.set(name, {
      data: typeof text === 'string' ? new TextEncoder().encode(text) : text,
      generation,
    });
    return generation;
  }

  private async enter(request: FakeGcsBucketRequest): Promise<void> {
    this.requests.push(request);
    await this.before?.(request);
    const failure: Error | undefined = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
  }

  file(
    name: string,
    options?: { readonly generation?: string | number }
  ): GcsFileLike {
    // Like the real client, a generation is turned into a number.
    const pinned: number | undefined =
      options?.generation === undefined
        ? undefined
        : Number(options.generation);
    const file = {
      metadata: undefined as
        { generation?: string | number | null } | undefined,
      getMetadata: async () => {
        await this.enter({ operation: 'getMetadata', name });
        const found = this.objects.get(name);
        if (found === undefined) {
          throw new FakeGcsError(`No such object: ${name}`, 404);
        }
        return [
          this.hideGenerationInMetadata ? {} : { generation: found.generation },
          {},
        ] as const;
      },
      download: async () => {
        await this.enter({
          operation: 'download',
          name,
          options: { generation: pinned },
        });
        const found = this.objects.get(name);
        if (
          found === undefined ||
          (pinned !== undefined && Number(found.generation) !== pinned)
        ) {
          throw new FakeGcsError(`No such object: ${name}`, 404);
        }
        return [found.data] as const;
      },
      save: async (
        data: string,
        saveOptions: {
          readonly resumable?: boolean;
          readonly contentType?: string;
          readonly preconditionOpts?: {
            readonly ifGenerationMatch?: string | number;
          };
        }
      ) => {
        await this.enter({ operation: 'save', name, options: saveOptions });
        const match = saveOptions.preconditionOpts?.ifGenerationMatch;
        const current = this.objects.get(name);
        if (match !== undefined) {
          const wanted: string = String(match);
          if (
            wanted === '0'
              ? current !== undefined
              : current?.generation !== wanted
          ) {
            throw new FakeGcsError('Precondition Failed', 412);
          }
        }
        const generation: string = this.put(name, data);
        if (!this.hideMetadataAfterSave) {
          file.metadata = { generation };
        }
      },
      delete: async (deleteOptions?: { readonly ignoreNotFound?: boolean }) => {
        await this.enter({
          operation: 'delete',
          name,
          options: deleteOptions,
        });
        if (
          !this.objects.delete(name) &&
          deleteOptions?.ignoreNotFound !== true
        ) {
          throw new FakeGcsError(`No such object: ${name}`, 404);
        }
        return [{}] as const;
      },
    };
    return file;
  }

  async getFiles(options: { readonly prefix?: string }) {
    await this.enter({
      operation: 'getFiles',
      name: options.prefix ?? '',
      options,
    });
    const names: { name: string }[] = [...this.objects.keys()]
      .filter((name) => name.startsWith(options.prefix ?? ''))
      .map((name) => ({ name }));
    return [names] as const;
  }
}
