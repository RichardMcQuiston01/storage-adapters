/**
 * An in-memory stand-in for an `amqplib` confirm channel over RabbitMQ streams, with the
 * behaviour the adapter relies on (checked against a real RabbitMQ 3.12 broker): a stream
 * is declared with `x-queue-type=stream`, every message gets a growing offset that
 * consumers read from the `x-stream-offset` header, a consumer starts at `'first'` or at
 * a numeric offset and then keeps receiving new messages, a publish is confirmed through
 * a callback, a redeclaration as a different kind of queue closes the channel with a 406
 * error, and a client that is not given a `Buffer` is refused only by `amqplib` itself.
 * test/rabbitmq-server.test.ts runs the adapter against a real broker.
 */
import type {
  RabbitMqChannelLike,
  RabbitMqMessageLike,
} from '../../src/rabbitmq/index.js';

interface Consumer {
  readonly tag: string;
  readonly stream: string;
  readonly onMessage: (message: RabbitMqMessageLike | null) => void;
  /** The offset of the next message to deliver. */
  next: number;
}

/** The broker: streams live here, and outlive any channel. */
export class FakeRabbitMq {
  readonly streams = new Map<string, Uint8Array[]>();
  /** The offset of the first message still held, per stream (RabbitMQ deletes from the front). */
  readonly bases = new Map<string, number>();
  readonly plainQueues = new Set<string>();
  /** Errors to hand to the callback of the next publishes, in order. */
  readonly publishFailures: unknown[] = [];
  readonly channels: FakeChannel[] = [];
  /** The `x-stream-offset` each consumer asked to start from, in order. */
  readonly consumerStarts: unknown[] = [];
  /** When true, publishes are accepted but never confirmed. */
  holdConfirms = false;
  /** When true, messages are stored but not delivered to consumers. */
  holdDelivery = false;
  private readonly consumers = new Set<Consumer>();

  openChannel = (): Promise<RabbitMqChannelLike> => {
    const channel = new FakeChannel(this);
    this.channels.push(channel);
    return Promise.resolve(channel);
  };

  /** Appends a message as another publisher would, and returns its offset. */
  append(stream: string, content: Uint8Array): number {
    const messages = this.streams.get(stream) ?? [];
    this.streams.set(stream, messages);
    messages.push(content);
    this.deliver();
    return (this.bases.get(stream) ?? 0) + messages.length - 1;
  }

  /** Deletes the messages before this offset, as stream retention does. */
  truncate(stream: string, upTo: number): void {
    const messages = this.streams.get(stream) ?? [];
    const base = this.bases.get(stream) ?? 0;
    const drop = Math.max(0, Math.min(upTo - base, messages.length));
    messages.splice(0, drop);
    this.bases.set(stream, base + drop);
  }

  /** Delivers a message to the consumers again, as a broker may after a failure. */
  redeliver(stream: string, offset: number): void {
    const content =
      this.streams.get(stream)?.[offset - (this.bases.get(stream) ?? 0)];
    if (content === undefined) {
      return;
    }
    for (const consumer of this.consumers) {
      if (consumer.stream === stream) {
        consumer.onMessage({
          content,
          properties: { headers: { 'x-stream-offset': offset } },
        });
      }
    }
  }

  /** Lets consumers receive what they have not yet. */
  resume(): void {
    this.holdDelivery = false;
    this.deliver();
  }

  addConsumer(consumer: Consumer): void {
    this.consumers.add(consumer);
    this.deliver();
  }

  removeConsumer(tag: string): void {
    for (const consumer of this.consumers) {
      if (consumer.tag === tag) {
        this.consumers.delete(consumer);
      }
    }
  }

  removeChannelConsumers(channel: FakeChannel): void {
    for (const tag of channel.tags) {
      this.removeConsumer(tag);
    }
  }

  private deliver(): void {
    if (this.holdDelivery) {
      return;
    }
    queueMicrotask(() => {
      for (const consumer of [...this.consumers]) {
        const messages = this.streams.get(consumer.stream) ?? [];
        const base = this.bases.get(consumer.stream) ?? 0;
        consumer.next = Math.max(consumer.next, base);
        while (
          consumer.next - base < messages.length &&
          this.consumers.has(consumer)
        ) {
          const offset = consumer.next;
          consumer.next += 1;
          consumer.onMessage({
            content: messages[offset - base] as Uint8Array,
            properties: { headers: { 'x-stream-offset': offset } },
          });
        }
      }
    });
  }
}

export class FakeChannel implements RabbitMqChannelLike {
  readonly tags: string[] = [];
  closed = false;
  readonly acked: RabbitMqMessageLike[] = [];
  prefetched = 0;
  private readonly handlers = new Map<string, ((error?: unknown) => void)[]>();
  private counter = 0;

  constructor(private readonly broker: FakeRabbitMq) {}

  assertQueue(
    queue: string,
    options: { durable: boolean; arguments: Record<string, unknown> }
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('Channel closed'));
    }
    const isStream = options.arguments['x-queue-type'] === 'stream';
    if (
      this.broker.plainQueues.has(queue) === isStream &&
      this.broker.plainQueues.has(queue)
    ) {
      return this.fail(
        `Channel closed by server: 406 (PRECONDITION-FAILED) with message "inequivalent arg 'x-queue-type' for queue '${queue}'"`
      );
    }
    if (isStream && !this.broker.streams.has(queue)) {
      this.broker.streams.set(queue, []);
    }
    return Promise.resolve({ queue, messageCount: 0, consumerCount: 0 });
  }

  private fail(message: string): Promise<never> {
    const error = Object.assign(new Error(message), { code: 406 });
    this.emit('error', error);
    this.close();
    return Promise.reject(error);
  }

  prefetch(count: number): Promise<unknown> {
    this.prefetched = count;
    return Promise.resolve();
  }

  sendToQueue(
    queue: string,
    content: Uint8Array,
    _options: { persistent: boolean },
    callback: (error: unknown) => void
  ): unknown {
    if (this.closed) {
      throw new Error('Channel closed');
    }
    if (this.broker.holdConfirms) {
      return true;
    }
    const failure: unknown = this.broker.publishFailures.shift();
    if (failure !== undefined) {
      callback(failure);
      return true;
    }
    this.broker.append(queue, content);
    callback(null);
    return true;
  }

  consume(
    queue: string,
    onMessage: (message: RabbitMqMessageLike | null) => void,
    options: { noAck: boolean; arguments: Record<string, unknown> }
  ): Promise<{ consumerTag: string }> {
    if (this.closed) {
      return Promise.reject(new Error('Channel closed'));
    }
    const at: unknown = options.arguments['x-stream-offset'];
    this.broker.consumerStarts.push(at);
    const messages = this.broker.streams.get(queue);
    if (messages === undefined) {
      return this.fail(
        `Channel closed by server: 404 (NOT-FOUND) with message "NOT_FOUND - no queue '${queue}'"`
      );
    }
    this.counter += 1;
    const tag = `ctag-${String(this.counter)}-${String(Math.random())}`;
    this.tags.push(tag);
    this.broker.addConsumer({
      tag,
      stream: queue,
      onMessage,
      next:
        typeof at === 'number'
          ? at
          : at === 'next'
            ? (this.broker.bases.get(queue) ?? 0) + messages.length
            : 0,
    });
    return Promise.resolve({ consumerTag: tag });
  }

  ack(message: RabbitMqMessageLike): void {
    this.acked.push(message);
  }

  cancel(consumerTag: string): Promise<unknown> {
    this.broker.removeConsumer(consumerTag);
    return Promise.resolve();
  }

  on(event: string, listener: (error?: unknown) => void): unknown {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  private emit(event: string, error?: unknown): void {
    for (const listener of this.handlers.get(event) ?? []) {
      listener(error);
    }
  }

  /** Closes the channel, as a dropped connection would. */
  close(error?: unknown): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.broker.removeChannelConsumers(this);
    this.emit('close', error);
  }
}
