/**
 * A `StorageAdapter` over Redis (or Valkey, KeyDB, Dragonfly), for servers. Like
 * `/postgres`, this is an optional entry point that imports no client: you connect
 * with `ioredis`, `redis` (node-redis) or anything that can send a raw command, and
 * pass it in.
 */
import { describeUnknownError } from '../errors.js';
import {
  createChangeListeners,
  revisionText,
  sqlFailure,
} from '../sql-shared.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreErrorCode,
  StoreResult,
} from '../storage.js';

/**
 * The one thing this adapter needs from a client: send a command and resolve its
 * reply. `redisCommandsFromIoredis` and `redisCommandsFromNodeRedis` wrap the two
 * common clients. Replies must be strings (the default for both), not Buffers.
 */
export interface RedisClientLike {
  /** Sends one command, for example `['HMGET', key, 'r', 'v']`. */
  command(args: readonly string[]): Promise<unknown>;
}

/**
 * A connection in subscriber mode, used to hear about writes made by other
 * processes. Optional: without it `subscribe` reports only this adapter's writes.
 * `redisSubscriberFromIoredis` and `redisSubscriberFromNodeRedis` wrap the common
 * clients.
 */
export interface RedisSubscriberLike {
  /**
   * Starts listening to a Pub/Sub channel. Resolves a function that stops it.
   */
  subscribe(
    channel: string,
    onMessage: (message: string) => void
  ): Promise<() => void | Promise<void>>;
}

export interface RedisAdapterOptions {
  /** A connected client. The adapter never closes it. */
  readonly client: RedisClientLike;
  /** Put in front of every Redis key. Defaults to `storage:`; `''` for none. */
  readonly prefix?: string;
  /**
   * Seconds until a key expires after each write, for cache-style data. An expired
   * key reads as missing, and its revision counter starts again at 1. Defaults to
   * no expiry.
   */
  readonly ttlSeconds?: number;
  /**
   * A second connection for Pub/Sub, so `subscribe` also hears about writes made by
   * other processes through the same prefix. Redis does not allow a connection that
   * is subscribed to run other commands, so this cannot be `client`.
   */
  readonly subscriber?: RedisSubscriberLike;
  /** Called when the subscriber connection fails to start or stop listening. */
  readonly onSubscriberError?: (message: string) => void;
}

const LABEL = 'Redis';
const DEFAULT_PREFIX = 'storage:';
const CHANGES_CHANNEL = 'changes';

/*
 * Each key is one hash: `r` holds the revision (a counter from 1) and `v` the value.
 * A script does the revision check, the write, the expiry and the change notice in
 * one step, so `ifRevision` is atomic across processes.
 *
 * KEYS[1] hash key; ARGV: 1 value, 2 "1" if a revision is to be checked, 3 that
 * revision, 4 ttl seconds ("0" for none), 5 channel, 6 origin, 7 caller's key.
 * Replies {1, revision} when written and {0, revision} on a conflict.
 */
const SET_SCRIPT = `local current = redis.call('HGET', KEYS[1], 'r')
if ARGV[2] == '1' and current and current ~= ARGV[3] then
  return {0, current}
end
local revision = tostring(redis.call('HINCRBY', KEYS[1], 'r', 1))
redis.call('HSET', KEYS[1], 'v', ARGV[1])
if tonumber(ARGV[4]) > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
redis.call('PUBLISH', ARGV[5], cjson.encode({o = ARGV[6], k = ARGV[7], r = revision, v = ARGV[1]}))
return {1, revision}`;

/** KEYS[1] hash key; ARGV: 1 channel, 2 origin, 3 caller's key. */
const REMOVE_SCRIPT = `redis.call('DEL', KEYS[1])
redis.call('PUBLISH', ARGV[1], cjson.encode({o = ARGV[2], k = ARGV[3], v = cjson.null}))
return 1`;

/** Maps a Redis error reply (or a connection error) to a code. */
function classifyError(error: unknown): StoreErrorCode {
  const message: string = describeUnknownError(error);
  if (/^OOM\b|used memory|maxmemory/i.test(message)) {
    return 'quota';
  }
  if (
    /^(NOPERM|NOAUTH|WRONGPASS|READONLY)\b|no permissions|authentication required|invalid password/i.test(
      message
    )
  ) {
    return 'forbidden';
  }
  if (/^WRONGTYPE\b/.test(message)) {
    return 'corrupt';
  }
  return 'unavailable';
}

function failedWith<T>(
  error: unknown,
  key: string,
  verb: string
): StoreResult<T> {
  const code: StoreErrorCode = classifyError(error);
  const detail: string =
    code === 'corrupt'
      ? `holds something that is not a stored entry (${describeUnknownError(error)})`
      : `could not be ${verb} (${describeUnknownError(error)})`;
  return sqlFailure(LABEL, code, key, detail);
}

/** A random label for this adapter, so it can ignore its own change notices. */
function newOrigin(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** What a change notice from another process holds, or null if it is not one. */
function parseChange(
  message: string
): { key: string; stored: StoredValue | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const change = parsed as Record<string, unknown>;
  if (typeof change.k !== 'string') {
    return null;
  }
  if (change.v === null) {
    return { key: change.k, stored: null };
  }
  if (typeof change.v === 'string' && typeof change.r === 'string') {
    return { key: change.k, stored: { value: change.v, revision: change.r } };
  }
  return null;
}

/**
 * A `StorageAdapter` over Redis. Each key is a hash holding a counter revision and
 * the value. `set` with `ifRevision` runs as one Lua script, so it reports
 * `conflict` when another connection or process wrote first, and a key with
 * nothing stored is created. `subscribe` reports changes made through this adapter,
 * and, given a `subscriber` connection, changes other processes make through the
 * same prefix. Nothing throws: every failure is a `StoreResult`.
 */
export function redisAdapter(options: RedisAdapterOptions): StorageAdapter {
  const { client, subscriber, onSubscriberError } = options;
  const prefix: string = options.prefix ?? DEFAULT_PREFIX;
  const ttlSeconds: number = options.ttlSeconds ?? 0;
  const ttlIsValid: boolean =
    Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 0;
  const channel = `${prefix}${CHANGES_CHANNEL}`;
  const origin: string = newOrigin();
  const listeners = createChangeListeners();
  let listenerCount = 0;
  let stopListening: Promise<() => void | Promise<void>> | null = null;

  const redisKey = (key: string): string => `${prefix}${key}`;

  const refusal = <T>(
    key: string,
    signal: AbortSignal
  ): StoreResult<T> | null => {
    if (signal.aborted) {
      return sqlFailure(LABEL, 'unavailable', key, 'request was aborted');
    }
    if (!ttlIsValid) {
      return sqlFailure(
        LABEL,
        'invalid',
        key,
        `cannot use ttlSeconds ${String(ttlSeconds)}: use a whole number of seconds, or leave it out`
      );
    }
    return null;
  };

  const reportSubscriberError = (action: string, error: unknown): void => {
    try {
      onSubscriberError?.(
        `${LABEL} subscriber could not ${action} ${channel} (${describeUnknownError(error)})`
      );
    } catch {
      // A faulty error handler must not break the adapter.
    }
  };

  const startListening = (): void => {
    if (subscriber === undefined || stopListening !== null) {
      return;
    }
    const started: Promise<() => void | Promise<void>> = subscriber.subscribe(
      channel,
      (message) => {
        const change = parseChange(message);
        // Our own writes were already announced when they finished.
        if (change === null || isOwn(message)) {
          return;
        }
        listeners.notify(change.key, change.stored);
      }
    );
    stopListening = started;
    started.catch((error: unknown) => {
      stopListening = null;
      reportSubscriberError('listen to', error);
    });
  };

  const isOwn = (message: string): boolean => {
    try {
      const parsed: unknown = JSON.parse(message);
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { o?: unknown }).o === origin
      );
    } catch {
      return false;
    }
  };

  const stopListeningIfIdle = (): void => {
    if (listenerCount > 0 || stopListening === null) {
      return;
    }
    const stopping: Promise<() => void | Promise<void>> = stopListening;
    stopListening = null;
    stopping
      .then((stop) => stop())
      .catch((error: unknown) => {
        reportSubscriberError('stop listening to', error);
      });
  };

  return {
    async get(key, { signal }) {
      const refused = refusal<StoredValue | null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      try {
        const reply: unknown = await client.command([
          'HMGET',
          redisKey(key),
          'r',
          'v',
        ]);
        const [revisionField, valueField]: unknown[] = Array.isArray(reply)
          ? (reply as unknown[])
          : [];
        if (revisionField === null && valueField === null) {
          return { ok: true, value: null };
        }
        const revision: string | undefined = revisionText(revisionField);
        if (typeof valueField !== 'string' || revision === undefined) {
          return sqlFailure(
            LABEL,
            'corrupt',
            key,
            'holds a hash that is not a stored entry'
          );
        }
        return { ok: true, value: { value: valueField, revision } };
      } catch (error: unknown) {
        return failedWith(error, key, 'read');
      }
    },

    async set(key, value, { signal, ifRevision }) {
      const refused = refusal<StoredValue>(key, signal);
      if (refused !== null) {
        return refused;
      }
      try {
        const reply: unknown = await client.command([
          'EVAL',
          SET_SCRIPT,
          '1',
          redisKey(key),
          value,
          ifRevision === undefined ? '0' : '1',
          ifRevision ?? '',
          String(ttlSeconds),
          channel,
          origin,
          key,
        ]);
        const [status, revisionField]: unknown[] = Array.isArray(reply)
          ? (reply as unknown[])
          : [];
        const revision: string | undefined = revisionText(revisionField);
        if (revision === undefined) {
          return sqlFailure(
            LABEL,
            'corrupt',
            key,
            'answered a write with something that is not a revision'
          );
        }
        if (Number(status) !== 1) {
          return sqlFailure(
            LABEL,
            'conflict',
            key,
            `holds revision ${revision}, but revision ${ifRevision ?? ''} was expected`
          );
        }
        const stored: StoredValue = { value, revision };
        listeners.notify(key, stored);
        return { ok: true, value: stored };
      } catch (error: unknown) {
        return failedWith(error, key, 'written');
      }
    },

    async remove(key, { signal }) {
      const refused = refusal<null>(key, signal);
      if (refused !== null) {
        return refused;
      }
      try {
        await client.command([
          'EVAL',
          REMOVE_SCRIPT,
          '1',
          redisKey(key),
          channel,
          origin,
          key,
        ]);
      } catch (error: unknown) {
        return failedWith(error, key, 'removed');
      }
      listeners.notify(key, null);
      return { ok: true, value: null };
    },

    subscribe(key, onChange) {
      const unsubscribe: () => void = listeners.subscribe(key, onChange);
      listenerCount += 1;
      startListening();
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        unsubscribe();
        listenerCount -= 1;
        stopListeningIfIdle();
      };
    },
  };
}

/** The part of an ioredis client this module calls. */
export interface IoredisLike {
  call(command: string, ...args: string[]): Promise<unknown>;
}

/** The part of a node-redis client this module calls. */
export interface NodeRedisLike {
  sendCommand(args: string[]): Promise<unknown>;
}

/** Wraps an `ioredis` client. */
export function redisCommandsFromIoredis(client: IoredisLike): RedisClientLike {
  return {
    command: (args) => {
      const [name, ...rest]: readonly string[] = args;
      return client.call(name ?? '', ...rest);
    },
  };
}

/** Wraps a node-redis (`redis` package) client. */
export function redisCommandsFromNodeRedis(
  client: NodeRedisLike
): RedisClientLike {
  return { command: (args) => client.sendCommand([...args]) };
}

/** The part of an ioredis connection used for Pub/Sub. */
export interface IoredisSubscriberLike {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(
    event: 'message',
    listener: (channel: string, message: string) => void
  ): unknown;
  off(
    event: 'message',
    listener: (channel: string, message: string) => void
  ): unknown;
}

/** The part of a node-redis connection used for Pub/Sub. */
export interface NodeRedisSubscriberLike {
  subscribe(
    channel: string,
    listener: (message: string) => void
  ): Promise<unknown>;
  unsubscribe(
    channel: string,
    listener: (message: string) => void
  ): Promise<unknown>;
}

/**
 * Wraps a dedicated `ioredis` connection (a separate `new Redis(...)`; one that has
 * subscribed cannot run other commands).
 */
export function redisSubscriberFromIoredis(
  connection: IoredisSubscriberLike
): RedisSubscriberLike {
  return {
    async subscribe(channel, onMessage) {
      const listener = (from: string, message: string): void => {
        if (from === channel) {
          onMessage(message);
        }
      };
      connection.on('message', listener);
      try {
        await connection.subscribe(channel);
      } catch (error: unknown) {
        connection.off('message', listener);
        throw error;
      }
      return async () => {
        connection.off('message', listener);
        await connection.unsubscribe(channel);
      };
    },
  };
}

/**
 * Wraps a dedicated node-redis connection, for example `client.duplicate()` once
 * connected.
 */
export function redisSubscriberFromNodeRedis(
  connection: NodeRedisSubscriberLike
): RedisSubscriberLike {
  return {
    async subscribe(channel, onMessage) {
      await connection.subscribe(channel, onMessage);
      return async () => {
        await connection.unsubscribe(channel, onMessage);
      };
    },
  };
}
