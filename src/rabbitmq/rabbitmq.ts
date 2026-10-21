/**
 * A `StorageAdapter` over a RabbitMQ stream. Like `/redis` and `/nats`, this is an
 * optional entry point that imports no client: you connect with `amqplib`, open a
 * channel, and pass it in.
 *
 * RabbitMQ is a message broker with no get-by-key, so this adapter keeps its data as an
 * append-only log: every write is a message in a stream, and each adapter replays the
 * stream into a table in memory. See `rabbitMqAdapter` for what that means.
 */
import { describeUnknownError } from '../errors.js';
import { createChangeListeners, sqlFailure } from '../sql-shared.js';
import { decodeUtf8, encodeUtf8 } from '../utf8.js';
import {
  compareKeys,
  prefixFailure,
  utf8Length,
  type StorageAdapter,
  type StoredValue,
  type StoreErrorCode,
  type StoreResult,
} from '../storage.js';

/** A message of a stream, as `amqplib`'s `consume` hands it over. */
export interface RabbitMqMessageLike {
  readonly content: Uint8Array;
  readonly properties: {
    /** Streams put the message's offset in `x-stream-offset`. */
    readonly headers?: Record<string, unknown> | undefined;
  };
}

/**
 * The part of an `amqplib` confirm channel (`connection.createConfirmChannel()`) this
 * adapter calls. It must be a confirm channel, so a publish is only reported done once
 * the broker has stored it.
 */
export interface RabbitMqChannelLike {
  assertQueue(
    queue: string,
    options: { durable: boolean; arguments: Record<string, unknown> }
  ): Promise<unknown>;
  prefetch(count: number): Promise<unknown>;
  sendToQueue(
    queue: string,
    content: Uint8Array,
    options: { persistent: boolean },
    callback: (error: unknown) => void
  ): unknown;
  consume(
    queue: string,
    onMessage: (message: RabbitMqMessageLike | null) => void,
    options: { noAck: boolean; arguments: Record<string, unknown> }
  ): Promise<{ consumerTag: string }>;
  ack(message: RabbitMqMessageLike): void;
  cancel(consumerTag: string): Promise<unknown>;
  /** Called with `'close'` and `'error'`. */
  on(event: string, listener: (error?: unknown) => void): unknown;
}

export interface RabbitMqAdapterOptions {
  /**
   * A confirm channel, or a function that opens one. With a function, the adapter asks
   * for a new channel whenever the old one closes; with a channel, it cannot recover
   * from one that closes. The adapter never closes the channel or the connection.
   */
  readonly channel: RabbitMqChannelLike | (() => Promise<RabbitMqChannelLike>);
  /**
   * Turns the bytes of a message into what the channel accepts. `amqplib` only accepts
   * a Node `Buffer`, so with it pass `(bytes) => Buffer.from(bytes)`. Without it the
   * channel is handed a plain `Uint8Array`.
   */
  readonly toBuffer?: (bytes: Uint8Array) => Uint8Array;
  /** The stream that holds the entries. Defaults to `storage_entry`. */
  readonly stream?: string;
  /**
   * Declare the stream before first use if it is not there. Defaults to true.
   * Without `streamArguments` the stream never expires and grows with every write;
   * see `compact` for keeping it small.
   */
  readonly createStream?: boolean;
  /**
   * Extra arguments for declaring the stream, for example
   * `{ 'x-max-age': '7D', 'x-stream-max-segment-size-bytes': 1_000_000 }`. RabbitMQ
   * deletes whole old segments once they pass the age or size limit, so also use
   * `snapshotIntervalMs` or call `compact` more often than the limit, or the entries
   * in the deleted part are lost. RabbitMQ refuses to declare a stream with arguments
   * that differ from the existing one, so give every process the same
   * `streamArguments` (or `createStream: false` where the stream is known to exist).
   * To change an existing stream, set a RabbitMQ policy.
   */
  readonly streamArguments?: Readonly<Record<string, unknown>>;
  /**
   * Milliseconds between automatic snapshots (at least 1000). While this adapter is
   * connected, it publishes a snapshot (see `compact`) whenever the stream has had
   * writes since the last one. Off by default. Set it to well under the stream's
   * maximum age.
   */
  readonly snapshotIntervalMs?: number;
  /**
   * `'linearizable'` (the default): `get` and `list` first put a marker through the
   * stream, so they see every write that finished before they were called, from any
   * process. `'local'`: they read this adapter's copy, which is as current as the
   * last message it received; no marker, much cheaper, and possibly a moment behind
   * other processes' writes.
   */
  readonly readConsistency?: 'linearizable' | 'local';
  /** Milliseconds to wait for a message to come back from the stream. Defaults to 10000. */
  readonly timeoutMs?: number;
  /**
   * Milliseconds before reconnecting after the channel or the consumer fails, while
   * anyone is subscribed (other calls reconnect when they are made). Defaults to 2000;
   * `0` never retries on its own.
   */
  readonly retryMs?: number;
  /** Called with a message naming the stream when the consumer or channel fails. */
  readonly onError?: (message: string) => void;
}

/** What `compact` reports. */
export interface RabbitMqSnapshot {
  /** The stream offset the snapshot is current as of. */
  readonly through: string;
  /** How many entries it holds. */
  readonly entries: number;
}

/** What `rabbitMqAdapter` returns: a `StorageAdapter` that can also compact and stop consuming. */
export interface RabbitMqAdapter extends StorageAdapter {
  /**
   * Publishes a snapshot: a message holding every entry as of now (revisions included).
   * Once a snapshot is in the stream, RabbitMQ may delete everything before it, through
   * the stream's age or size limit, and a process that starts later builds its table
   * from the oldest snapshot still in the stream plus the messages after it, instead of
   * from the beginning. A snapshot must fit in one message, so this fails with
   * `invalid` for a table of more than about 8 MB.
   */
  compact(): Promise<StoreResult<RabbitMqSnapshot>>;
  /** Stops consuming the stream. Later calls fail with `unavailable`. Idempotent. */
  close(): Promise<void>;
}

const LABEL = 'RabbitMQ';
const DEFAULT_STREAM = 'storage_entry';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 2000;
const MAX_KEY_BYTES = 1024;
/** RabbitMQ's default message size limit is 16 MiB; this leaves a wide margin. */
const MAX_VALUE_BYTES = 4_000_000;
const PREFETCH = 500;
/** A snapshot travels as one message, which RabbitMQ limits to 16 MiB by default. */
const MAX_SNAPSHOT_BYTES = 8_000_000;
const MIN_SNAPSHOT_INTERVAL_MS = 1000;
const OFFSET_HEADER = 'x-stream-offset';

/** What one message in the stream says. */
interface Operation {
  readonly id: string;
  readonly op: 'set' | 'remove' | 'sync' | 'snapshot';
  readonly key?: string;
  readonly value?: string;
  /** The revision the writer expected the key to hold. */
  readonly expect?: string;
  /** A snapshot: the offset of the last message it reflects, and every entry as of then. */
  readonly at?: number;
  readonly entries?: readonly SnapshotEntry[];
}

interface SnapshotEntry {
  readonly key: string;
  readonly value: string;
  readonly revision: string;
}

/** What happened to an operation when its message was applied, in stream order. */
type Outcome =
  | { readonly applied: true; readonly stored: StoredValue | null }
  | { readonly applied: false; readonly current: StoredValue };

type Settled =
  | { readonly ok: true; readonly outcome: Outcome }
  | {
      readonly ok: false;
      readonly code: StoreErrorCode;
      readonly detail: string;
    };

function parseOperation(content: Uint8Array): Operation | undefined {
  const text: string | undefined = decodeUtf8(Array.from(content));
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    (record.op !== 'set' &&
      record.op !== 'remove' &&
      record.op !== 'sync' &&
      record.op !== 'snapshot')
  ) {
    return undefined;
  }
  if (record.op === 'sync') {
    return { id: record.id, op: 'sync' };
  }
  if (record.op === 'snapshot') {
    if (typeof record.at !== 'number' || !Array.isArray(record.entries)) {
      return undefined;
    }
    const entries: SnapshotEntry[] = [];
    for (const entry of record.entries as unknown[]) {
      const item = entry as Record<string, unknown> | null;
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof item.key !== 'string' ||
        typeof item.value !== 'string' ||
        typeof item.revision !== 'string'
      ) {
        return undefined;
      }
      entries.push({
        key: item.key,
        value: item.value,
        revision: item.revision,
      });
    }
    return { id: record.id, op: 'snapshot', at: record.at, entries };
  }
  if (typeof record.key !== 'string') {
    return undefined;
  }
  if (record.op === 'remove') {
    return { id: record.id, op: 'remove', key: record.key };
  }
  if (typeof record.value !== 'string') {
    return undefined;
  }
  return {
    id: record.id,
    op: 'set',
    key: record.key,
    value: record.value,
    ...(typeof record.expect === 'string' ? { expect: record.expect } : {}),
  };
}

function hasLoneSurrogate(text: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    text
  );
}

function newOperationId(): string {
  const random: string = Math.floor(Math.random() * 0xffffffffffff)
    .toString(16)
    .padStart(12, '0');
  return `${String(Date.now())}-${random}`;
}

/** AMQP's reply codes: 403 is refused access, the rest are treated as unavailable. */
function codeOf(error: unknown): StoreErrorCode {
  const code: unknown =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return code === 403 ? 'forbidden' : 'unavailable';
}

/**
 * A `StorageAdapter` that keeps its data in a RabbitMQ stream. Every `set` and
 * `remove` is a message appended to the stream, and the adapter reads the whole stream
 * into a table in memory when it starts and keeps following it. A revision is the
 * message's offset in the stream: unique, and growing for the whole stream.
 *
 * Because every process sees the same messages in the same order, `ifRevision` is
 * decided by the stream itself: a write applies only if the key still held the expected
 * revision at its place in the log, so it is atomic across processes (and a key with
 * nothing stored is created). A write returns once it has come back from the stream and
 * been applied, so the writer knows whether it won. `subscribe` hears every change, from
 * any process, as the messages arrive.
 *
 * The costs are the point of the design. All entries live in memory in every process,
 * and starting means reading the stream from the beginning, so this suits settings and
 * state, not documents or many large values. A stream left alone grows with every write
 * and removal. To keep it small, give it a maximum age or size (`streamArguments`) and
 * have snapshots published well within that limit (`snapshotIntervalMs`, or `compact`):
 * a snapshot holds every entry, so RabbitMQ can delete the messages before it and a
 * process that starts later builds its table from the oldest snapshot left. `list` and,
 * by default, `get` put a small marker message through the stream first, so they are
 * current, at the price of a round trip each; use `readConsistency: 'local'` to skip it.
 * Nothing throws: every failure is a `StoreResult`.
 */
export function rabbitMqAdapter(
  options: RabbitMqAdapterOptions
): RabbitMqAdapter {
  const stream: string = options.stream ?? DEFAULT_STREAM;
  const toBuffer: (bytes: Uint8Array) => Uint8Array =
    options.toBuffer ?? ((bytes) => bytes);
  const timeoutMs: number = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs: number = options.retryMs ?? DEFAULT_RETRY_MS;
  const linearizable: boolean = options.readConsistency !== 'local';
  const where = `stream "${stream}"`;
  const streamIsUsable: boolean =
    stream !== '' &&
    utf8Length(stream) <= 255 &&
    ![...stream].some((char) => (char.codePointAt(0) ?? 0) < 0x20);

  const table = new Map<string, StoredValue>();
  const listeners = createChangeListeners();
  const pending = new Map<string, (settled: Settled) => void>();
  let lastOffset = -1;
  let channel: RabbitMqChannelLike | null = null;
  let consumerTag: string | null = null;
  let ready: Promise<string | null> | null = null;
  /** True once the first catch-up has finished; replayed history is not announced. */
  let caughtUp = false;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const report = (message: string): void => {
    try {
      options.onError?.(message);
    } catch {
      // A faulty error handler must not break the adapter.
    }
  };

  /** The offset of the newest set or remove applied, and of the newest snapshot's `at`. */
  let lastWriteOffset = -1;
  let snapshotCovered = -1;
  /** True while history is replayed from a snapshot; nobody is told about each step. */
  let quiet = false;
  /**
   * Set while the table is being built from a snapshot (the stream starts after offset
   * 0, because RabbitMQ deleted its beginning): the first offset received, and the
   * messages since, kept until a snapshot to build on turns up.
   */
  let seeking: {
    readonly first: number;
    readonly buffer: { offset: number; operation: Operation }[];
  } | null = null;
  /** What the table held when the consumer was restarted, until the rebuild has been announced. */
  let rebuildFrom: ReadonlyMap<string, StoredValue> | null = null;

  /** Applies one message in stream order. */
  const apply = (operation: Operation, offset: number): Outcome => {
    if (operation.op === 'sync') {
      return { applied: true, stored: null };
    }
    if (operation.op === 'snapshot') {
      snapshotCovered = Math.max(snapshotCovered, operation.at ?? -1);
      return { applied: true, stored: null };
    }
    const key: string = operation.key ?? '';
    const current: StoredValue | undefined = table.get(key);
    lastWriteOffset = offset;
    if (operation.op === 'remove') {
      table.delete(key);
      if (current !== undefined && caughtUp && !quiet) {
        listeners.notify(key, null);
      }
      return { applied: true, stored: null };
    }
    if (
      operation.expect !== undefined &&
      current !== undefined &&
      current.revision !== operation.expect
    ) {
      return { applied: false, current };
    }
    const stored: StoredValue = {
      value: operation.value ?? '',
      revision: String(offset),
    };
    table.set(key, stored);
    if (caughtUp && !quiet) {
      listeners.notify(key, stored);
    }
    return { applied: true, stored };
  };

  const process = (operation: Operation, offset: number): void => {
    const outcome: Outcome = apply(operation, offset);
    pending.get(operation.id)?.({ ok: true, outcome });
  };

  /** Starts building from a snapshot, because the stream no longer begins where we need. */
  const beginSeeking = (first: number): void => {
    seeking = { first, buffer: [] };
  };

  /** Takes a snapshot as the base of the table, then applies what came after it. */
  const adoptSnapshot = (operation: Operation): void => {
    const state = seeking;
    if (state === null) {
      return;
    }
    const at: number = operation.at ?? -1;
    if (state.first > at) {
      // The message it reflects is gone, so some after it may be too.
      return;
    }
    table.clear();
    for (const entry of operation.entries ?? []) {
      table.set(entry.key, { value: entry.value, revision: entry.revision });
    }
    lastWriteOffset = at;
    snapshotCovered = Math.max(snapshotCovered, at);
    const buffered = state.buffer;
    seeking = null;
    const wasQuiet: boolean = quiet;
    quiet = true;
    for (const item of buffered) {
      if (item.offset > at) {
        process(item.operation, item.offset);
      } else if (item.operation.op === 'sync') {
        pending.get(item.operation.id)?.({
          ok: true,
          outcome: { applied: true, stored: null },
        });
      }
    }
    quiet = wasQuiet;
  };

  const onMessage = (message: RabbitMqMessageLike | null): void => {
    if (message === null) {
      return; // The broker cancelled the consumer; the channel events handle it.
    }
    try {
      const offset: unknown = message.properties.headers?.[OFFSET_HEADER];
      if (typeof offset !== 'number' || offset <= lastOffset) {
        if (typeof offset !== 'number') {
          report(
            `${LABEL} received a message from ${where} without an offset, and skipped it`
          );
        }
        return;
      }
      if (lastOffset < 0 && offset > 0) {
        // The stream does not begin at offset 0: RabbitMQ deleted its beginning, so the
        // table has to be built from a snapshot. (Offsets are not contiguous, so a jump
        // later on proves nothing.)
        beginSeeking(offset);
      }
      lastOffset = offset;
      const operation: Operation | undefined = parseOperation(message.content);
      if (operation === undefined) {
        report(
          `${LABEL} skipped a message at offset ${String(offset)} of ${where} that is not an entry written by this adapter`
        );
        return;
      }
      if (seeking !== null) {
        if (operation.op === 'snapshot') {
          adoptSnapshot(operation);
          return;
        }
        seeking.buffer.push({ offset, operation });
        return;
      }
      process(operation, offset);
    } finally {
      try {
        channel?.ack(message);
      } catch (error: unknown) {
        report(
          `${LABEL} could not acknowledge a message of ${where} (${describeUnknownError(error)})`
        );
      }
    }
  };

  /** Sends one operation and waits for it to come back from the stream. */
  const send = (
    operation: Operation,
    on: RabbitMqChannelLike
  ): Promise<Settled> =>
    new Promise<Settled>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (settled: Settled): void => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        pending.delete(operation.id);
        resolve(settled);
      };
      pending.set(operation.id, finish);
      timer = setTimeout(() => {
        finish({
          ok: false,
          code: 'unavailable',
          detail: `did not come back from ${where} within ${String(timeoutMs)} ms (it may still be applied)`,
        });
      }, timeoutMs);
      try {
        on.sendToQueue(
          stream,
          toBuffer(encodeUtf8(JSON.stringify(operation))),
          { persistent: true },
          (error: unknown) => {
            if (error !== null && error !== undefined && error !== false) {
              finish({
                ok: false,
                code: codeOf(error),
                detail: `could not be published to ${where} (${describeUnknownError(error)})`,
              });
            }
          }
        );
      } catch (error: unknown) {
        finish({
          ok: false,
          code: codeOf(error),
          detail: `could not be published to ${where} (${describeUnknownError(error)})`,
        });
      }
    });

  const scheduleRetry = (): void => {
    if (closed || retryMs === 0 || retryTimer !== null || !hasSubscribers()) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect().then((problem) => {
        if (problem !== null) {
          report(`${LABEL} ${problem}`);
          scheduleRetry();
        }
      });
    }, retryMs);
    const timer = retryTimer as { unref?: () => void };
    timer.unref?.();
  };

  /** Anyone subscribed to anything. */
  let subscriberCount = 0;
  const hasSubscribers = (): boolean => subscriberCount > 0;

  const lost = (on: RabbitMqChannelLike, error: unknown): void => {
    if (channel !== on) {
      return;
    }
    channel = null;
    consumerTag = null;
    ready = null;
    report(
      `${LABEL} lost its channel to ${where}${error === undefined ? '' : ` (${describeUnknownError(error)})`}`
    );
    scheduleRetry();
  };

  /** Opens the channel, starts consuming from where it left off, and catches up. */
  const start = async (): Promise<string | null> => {
    let on: RabbitMqChannelLike;
    try {
      on =
        typeof options.channel === 'function'
          ? await options.channel()
          : options.channel;
    } catch (error: unknown) {
      return `could not open a channel (${describeUnknownError(error)})`;
    }
    if (caughtUp) {
      // Reconnecting: offsets are not contiguous, so we cannot tell what RabbitMQ
      // deleted while we were away. Read the stream again and announce what differs.
      rebuildFrom ??= new Map(table);
      table.clear();
      lastOffset = -1;
      lastWriteOffset = -1;
      seeking = null;
      quiet = true;
    }
    // A channel the broker closes (a bad declaration, say) emits 'error'; without a
    // listener from the start that would be thrown at the whole program.
    on.on('close', (error) => {
      lost(on, error);
    });
    on.on('error', (error) => {
      lost(on, error);
    });
    try {
      if (options.createStream !== false) {
        await on.assertQueue(stream, {
          durable: true,
          arguments: { ...options.streamArguments, 'x-queue-type': 'stream' },
        });
      }
      await on.prefetch(PREFETCH);
      channel = on;
      const consumer = await on.consume(stream, onMessage, {
        noAck: false,
        arguments: { 'x-stream-offset': 'first' },
      });
      consumerTag = consumer.consumerTag;
    } catch (error: unknown) {
      if (channel === on) {
        channel = null;
      }
      return `could not read ${where} (${describeUnknownError(error)}; it must be a stream, and RabbitMQ refuses a declaration that differs from the existing one, so every process needs the same streamArguments, or createStream: false once the stream exists)`;
    }
    // Everything written before this marker has been applied once it comes back.
    const synced: Settled = await send(
      { id: newOperationId(), op: 'sync' },
      on
    );
    if (!synced.ok) {
      if (seeking !== null) {
        return `${where} starts at offset ${String(seeking.first)}, not 0, and holds no snapshot to build the table from (RabbitMQ deleted the beginning; a snapshot must be published before it does, with compact or snapshotIntervalMs)`;
      }
      return `could not catch up with ${where} (${synced.detail})`;
    }
    caughtUp = true;
    if (rebuildFrom !== null) {
      const before = rebuildFrom;
      rebuildFrom = null;
      quiet = false;
      for (const key of new Set([...before.keys(), ...table.keys()])) {
        const was: StoredValue | undefined = before.get(key);
        const now: StoredValue | undefined = table.get(key);
        if (was?.revision !== now?.revision || was?.value !== now?.value) {
          listeners.notify(key, now ?? null);
        }
      }
    }
    startSnapshots();
    return null;
  };

  /** Makes sure the copy is following the stream; resolves to a problem, if any. */
  const connect = (): Promise<string | null> => {
    if (closed) {
      return Promise.resolve('is closed');
    }
    if (ready === null) {
      const attempt: Promise<string | null> = start();
      ready = attempt;
      void attempt.then((problem) => {
        if (problem !== null && ready === attempt) {
          ready = null;
        }
      });
    }
    return ready;
  };

  /** A marker through the stream, shared by the callers that arrive while one is out. */
  let running: Promise<Settled> | null = null;
  let waiting: Promise<Settled> | null = null;
  const sendMarker = async (): Promise<Settled> => {
    const on: RabbitMqChannelLike | null = channel;
    if (on === null) {
      return {
        ok: false,
        code: 'unavailable',
        detail: `has no channel to ${where}`,
      };
    }
    return send({ id: newOperationId(), op: 'sync' }, on);
  };
  const startMarker = (): Promise<Settled> => {
    const run: Promise<Settled> = sendMarker();
    running = run;
    void run.then(() => {
      if (running === run) {
        running = null;
      }
    });
    return run;
  };
  const marker = (): Promise<Settled> => {
    if (running === null) {
      return startMarker();
    }
    if (waiting === null) {
      waiting = running
        .then(
          () => undefined,
          () => undefined
        )
        .then(() => {
          waiting = null;
          return startMarker();
        });
    }
    return waiting;
  };

  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): StoreResult<T> | null => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    if (!streamIsUsable) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use ${where}: the name must not be empty or longer than 255 bytes`
      );
    }
    if (hasLoneSurrogate(key)) {
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
        `cannot use this key: it takes ${String(utf8Length(key))} bytes and the limit is ${String(MAX_KEY_BYTES)}`
      );
    }
    return null;
  };

  /** Connects, and for a current read waits for a marker to come back. */
  const upToDate = async (current: boolean): Promise<string | null> => {
    const problem: string | null = await connect();
    if (problem !== null) {
      return problem;
    }
    if (!current) {
      return null;
    }
    const settled: Settled = await marker();
    return settled.ok ? null : settled.detail;
  };

  /** Publishes a snapshot of the table as it stands now. */
  const compact = async (): Promise<StoreResult<RabbitMqSnapshot>> => {
    const failed = (
      code: StoreErrorCode,
      detail: string
    ): StoreResult<RabbitMqSnapshot> => ({
      ok: false,
      code,
      error: `${LABEL} snapshot of ${where} ${detail}`,
    });
    if (!streamIsUsable) {
      return failed(
        'invalid',
        'cannot be made: the stream name must not be empty or longer than 255 bytes'
      );
    }
    const problem: string | null = await upToDate(true);
    if (problem !== null || channel === null) {
      return failed(
        'unavailable',
        `could not be made (${problem ?? 'no channel'})`
      );
    }
    // No waiting from here to the publish, so `at` and the entries agree.
    const at: number = lastOffset;
    const entries: SnapshotEntry[] = [...table.entries()]
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, stored]) => ({
        key,
        value: stored.value,
        revision: stored.revision ?? '',
      }));
    const content: string = JSON.stringify({
      id: newOperationId(),
      op: 'snapshot',
      at,
      entries,
    });
    if (utf8Length(content) > MAX_SNAPSHOT_BYTES) {
      return failed(
        'invalid',
        `cannot be made: ${String(entries.length)} entries take ${String(utf8Length(content))} bytes and a snapshot must fit in one message of at most ${String(MAX_SNAPSHOT_BYTES)}`
      );
    }
    const settled: Settled = await send(
      JSON.parse(content) as Operation,
      channel
    );
    if (!settled.ok) {
      return failed(settled.code, `could not be published (${settled.detail})`);
    }
    return {
      ok: true,
      value: { through: String(at), entries: entries.length },
    };
  };

  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  const snapshotIntervalMs: number | undefined =
    options.snapshotIntervalMs === undefined
      ? undefined
      : Math.max(MIN_SNAPSHOT_INTERVAL_MS, options.snapshotIntervalMs);
  /** Starts the automatic snapshots, once the table is caught up. */
  const startSnapshots = (): void => {
    if (snapshotIntervalMs === undefined || snapshotTimer !== null || closed) {
      return;
    }
    const tick = (): void => {
      snapshotTimer = setTimeout(() => {
        snapshotTimer = null;
        const dirty: boolean =
          channel !== null &&
          seeking === null &&
          lastWriteOffset > snapshotCovered;
        const done: Promise<void> = dirty
          ? compact().then((result) => {
              if (!result.ok) {
                report(result.error);
              }
            })
          : Promise.resolve();
        void done.then(() => {
          if (!closed) {
            tick();
          }
        });
      }, snapshotIntervalMs);
      const timer = snapshotTimer as { unref?: () => void };
      timer.unref?.();
    };
    tick();
  };

  const adapter: RabbitMqAdapter = {
    async get(key, { signal }) {
      const refused = refusal<StoredValue | null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      const problem: string | null = await upToDate(linearizable);
      if (problem !== null) {
        return sqlFailure(
          LABEL,
          'unavailable',
          key,
          `could not be read (${problem})`
        );
      }
      return { ok: true, value: table.get(key) ?? null };
    },

    async set(key, value, { signal, ifRevision }) {
      const refused = refusal<StoredValue>(key, signal);
      if (refused !== null) {
        return refused;
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
      const problem: string | null = await connect();
      if (problem !== null || channel === null) {
        return sqlFailure(
          LABEL,
          'unavailable',
          key,
          `could not be written (${problem ?? 'no channel'})`
        );
      }
      const settled: Settled = await send(
        {
          id: newOperationId(),
          op: 'set',
          key,
          value,
          ...(ifRevision === undefined ? {} : { expect: ifRevision }),
        },
        channel
      );
      if (!settled.ok) {
        return sqlFailure(LABEL, settled.code, key, settled.detail);
      }
      if (!settled.outcome.applied) {
        return sqlFailure(
          LABEL,
          'conflict',
          key,
          `holds revision ${settled.outcome.current.revision}, but revision ${ifRevision ?? ''} was expected`
        );
      }
      return {
        ok: true,
        value: settled.outcome.stored ?? { value, revision: '' },
      };
    },

    async remove(key, { signal }) {
      const refused = refusal<null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      const problem: string | null = await connect();
      if (problem !== null || channel === null) {
        return sqlFailure(
          LABEL,
          'unavailable',
          key,
          `could not be removed (${problem ?? 'no channel'})`
        );
      }
      const settled: Settled = await send(
        { id: newOperationId(), op: 'remove', key },
        channel
      );
      if (!settled.ok) {
        return sqlFailure(LABEL, settled.code, key, settled.detail);
      }
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
      if (!streamIsUsable) {
        return prefixFailure(
          LABEL,
          'invalid',
          keyPrefix,
          `cannot use ${where}: the name must not be empty or longer than 255 bytes`
        );
      }
      const problem: string | null = await upToDate(linearizable);
      if (problem !== null) {
        return prefixFailure(
          LABEL,
          'unavailable',
          keyPrefix,
          `could not list keys (${problem})`
        );
      }
      const keys: string[] = [...table.keys()].filter((key) =>
        key.startsWith(keyPrefix)
      );
      return { ok: true, value: keys.sort(compareKeys) };
    },

    subscribe(key, onChange) {
      subscriberCount += 1;
      const stop: () => void = listeners.subscribe(key, onChange);
      void connect().then((problem) => {
        if (problem !== null) {
          report(`${LABEL} ${problem}`);
          scheduleRetry();
        }
      });
      let stopped = false;
      return () => {
        if (!stopped) {
          stopped = true;
          subscriberCount -= 1;
          stop();
        }
      };
    },

    compact,

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      if (snapshotTimer !== null) {
        clearTimeout(snapshotTimer);
        snapshotTimer = null;
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const on: RabbitMqChannelLike | null = channel;
      const tag: string | null = consumerTag;
      channel = null;
      consumerTag = null;
      ready = null;
      if (on !== null && tag !== null) {
        try {
          await on.cancel(tag);
        } catch (error: unknown) {
          report(
            `${LABEL} could not stop consuming ${where} (${describeUnknownError(error)})`
          );
        }
      }
    },
  };
  return adapter;
}
