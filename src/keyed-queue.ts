/**
 * Runs asynchronous work in turn for each key. Like the rest of `src/`, this does no I/O.
 *
 * Transactions that read and then write one record wait on each other's locks (or retry
 * with a back-off) in Firestore and the Realtime Database, so many at once on one key
 * can take seconds; run in turn, each takes one round trip. Work for different keys
 * still goes at the same time, and a failure does not hold up the next piece of work.
 */
export interface KeyedQueue {
  /** Runs `work` after the work already queued for `key`, and resolves with its result. */
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export function createKeyedQueue(): KeyedQueue {
  /** The last piece of work queued for each key, so work for one key runs in turn. */
  const tails = new Map<string, Promise<void>>();
  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const previous: Promise<void> = tails.get(key) ?? Promise.resolve();
      const result: Promise<T> = previous.then(work);
      const tail: Promise<void> = result.then(
        () => undefined,
        () => undefined
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      });
      return result;
    },
  };
}
