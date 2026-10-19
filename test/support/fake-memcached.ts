/**
 * An in-memory stand-in for a Memcached client, with the behaviour the adapter relies
 * on: every store gets a new CAS unique, `add` refuses a key that is there, `cas`
 * refuses a changed or missing key, and keys follow Memcached's rules (1 to 250
 * characters, no spaces or control characters). test/memcached-server.test.ts runs the
 * adapter against a real server.
 */
import type {
  MemcachedClientLike,
  MemcachedEntryLike,
  MemcachedStoreOutcome,
} from '../../src/memcached/index.js';

export class FakeMemcached implements MemcachedClientLike {
  readonly items = new Map<string, { value: string; casUniq: number }>();
  /** Errors to throw from the next calls, in order. */
  readonly failures: Error[] = [];
  /** `METHOD key` for each call, in order. */
  readonly calls: string[] = [];
  /** Runs just before each `add` and `cas` is applied, to simulate another writer. */
  beforeStore: ((key: string) => void) | null = null;
  readonly ttls: number[] = [];
  private counter = 0;

  private check(method: string, key: string): void {
    this.calls.push(`${method} ${key}`);
    const failure: Error | undefined = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    if (!/^[\x21-\x7e]{1,250}$/.test(key)) {
      throw new Error('CLIENT_ERROR bad command line format');
    }
  }

  private put(key: string, value: string): void {
    this.counter += 1;
    this.items.set(key, { value, casUniq: this.counter });
  }

  gets(key: string): Promise<MemcachedEntryLike | null> {
    try {
      this.check('gets', key);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new Error('failed')
      );
    }
    const item = this.items.get(key);
    return Promise.resolve(
      item === undefined
        ? null
        : { value: item.value, casUniq: String(item.casUniq) }
    );
  }

  add(
    key: string,
    value: string,
    options: { readonly ttlSeconds: number }
  ): Promise<MemcachedStoreOutcome> {
    try {
      this.check('add', key);
      this.beforeStore?.(key);
      this.ttls.push(options.ttlSeconds);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new Error('failed')
      );
    }
    if (this.items.has(key)) {
      return Promise.resolve('not_stored');
    }
    this.put(key, value);
    return Promise.resolve('stored');
  }

  cas(
    key: string,
    value: string,
    casUniq: string,
    options: { readonly ttlSeconds: number }
  ): Promise<MemcachedStoreOutcome> {
    try {
      this.check('cas', key);
      this.beforeStore?.(key);
      this.ttls.push(options.ttlSeconds);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new Error('failed')
      );
    }
    const item = this.items.get(key);
    if (item === undefined) {
      return Promise.resolve('not_found');
    }
    if (String(item.casUniq) !== casUniq) {
      return Promise.resolve('exists');
    }
    this.put(key, value);
    return Promise.resolve('stored');
  }

  delete(key: string): Promise<void> {
    try {
      this.check('delete', key);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new Error('failed')
      );
    }
    this.items.delete(key);
    return Promise.resolve();
  }

  /** Writes behind the adapter's back, as another process would. */
  overwrite(key: string, value: string): void {
    this.put(key, value);
  }

  /** Makes a key vanish, as expiry or eviction would. */
  evict(key: string): void {
    this.items.delete(key);
  }
}
