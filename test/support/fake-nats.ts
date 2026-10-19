/**
 * An in-memory stand-in for a NATS JetStream key-value bucket, with the behaviour
 * the adapter relies on: one sequence number across the whole bucket, soft
 * removals that stay as markers, `update` and `create` that fail with JetStream's
 * "wrong last sequence" error, and watches that deliver later writes.
 */
import type {
  NatsKvEntryLike,
  NatsKvIteratorLike,
  NatsKvLike,
} from '../../src/nats/index.js';

interface FakeEntry extends NatsKvEntryLike {
  readonly name: string;
  readonly text: string;
}

export class FakeJetStreamError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined = undefined
  ) {
    super(message);
  }
}

const KEY_PATTERN = /^[-/_=.a-zA-Z0-9]+$/;

class Queue<T> implements NatsKvIteratorLike<T> {
  private readonly items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) {
      return;
    }
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  stop(): void {
    this.done = true;
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item: T | undefined = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export class FakeNatsKv implements NatsKvLike {
  readonly latest = new Map<string, FakeEntry>();
  private sequence = 0;
  private readonly watchers = new Set<{
    name: string;
    queue: Queue<NatsKvEntryLike>;
  }>();
  /** Errors to throw from the next calls, in order. */
  readonly failures: Error[] = [];
  /** Names passed to `watch`, in order. */
  readonly watched: string[] = [];

  private check(name: string): void {
    const failure: Error | undefined = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    if (!KEY_PATTERN.test(name) || name.startsWith('.') || name.endsWith('.')) {
      throw new Error(`invalid key: ${name}`);
    }
  }

  private write(name: string, operation: string, text: string): FakeEntry {
    this.sequence += 1;
    const entry: FakeEntry = {
      name,
      text,
      revision: this.sequence,
      operation,
      string: () => text,
    };
    this.latest.set(name, entry);
    for (const watcher of this.watchers) {
      if (watcher.name === name) {
        watcher.queue.push(entry);
      }
    }
    return entry;
  }

  private wrongSequence(name: string): FakeJetStreamError {
    return new FakeJetStreamError(
      `wrong last sequence: ${String(this.latest.get(name)?.revision ?? 0)}`,
      10071
    );
  }

  get(name: string): Promise<NatsKvEntryLike | null> {
    return this.run(() => this.latest.get(name) ?? null, name);
  }

  put(name: string, value: string): Promise<number> {
    return this.run(() => this.write(name, 'PUT', value).revision, name);
  }

  create(name: string, value: string): Promise<number> {
    return this.run(() => {
      if (this.latest.get(name)?.operation === 'PUT') {
        throw this.wrongSequence(name);
      }
      return this.write(name, 'PUT', value).revision;
    }, name);
  }

  update(name: string, value: string, revision: number): Promise<number> {
    return this.run(() => {
      if ((this.latest.get(name)?.revision ?? 0) !== revision) {
        throw this.wrongSequence(name);
      }
      return this.write(name, 'PUT', value).revision;
    }, name);
  }

  purge(name: string): Promise<void> {
    return this.run(() => {
      this.write(name, 'PURGE', '');
    }, name);
  }

  keys(): Promise<NatsKvIteratorLike<string>> {
    return this.run(() => {
      const queue = new Queue<string>();
      for (const entry of this.latest.values()) {
        if (entry.operation === 'PUT') {
          queue.push(entry.name);
        }
      }
      queue.stop();
      return queue;
    }, 'a');
  }

  watch(options: {
    key: string;
    include: 'updates';
  }): Promise<NatsKvIteratorLike<NatsKvEntryLike>> {
    return this.run(() => {
      this.watched.push(options.key);
      const queue = new Queue<NatsKvEntryLike>();
      this.watchers.add({ name: options.key, queue });
      return queue;
    }, options.key);
  }

  /** How many watches are open. */
  get openWatches(): number {
    let open = 0;
    for (const watcher of this.watchers) {
      if (!(watcher.queue as unknown as { done: boolean }).done) {
        open += 1;
      }
    }
    return open;
  }

  /** Ends every open watch, as a lost connection would. */
  dropWatches(): void {
    for (const watcher of this.watchers) {
      watcher.queue.stop();
    }
    this.watchers.clear();
  }

  private run<T>(work: () => T, name: string): Promise<T> {
    try {
      this.check(name);
      return Promise.resolve(work());
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new Error('failed')
      );
    }
  }
}
