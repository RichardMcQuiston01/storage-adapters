/**
 * The shared change poller: a write made through the adapter is heard once, even when
 * a poll reads the new value while the write is still being finished.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createChangePoller } from '../src/change-poller.js';
import type { StoredValue } from '../src/storage.js';

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

void describe('createChangePoller', () => {
  void it('tells a subscriber about its own write once when a poll sees it first', async () => {
    let stored: StoredValue | null = null;
    const poller = createChangePoller({
      intervalMs: 50,
      readKeys: (keys) =>
        Promise.resolve(
          new Map(stored === null ? [] : keys.map((key) => [key, stored!]))
        ),
      onError: undefined,
      describeFailure: (cause) => `poll failed (${cause})`,
    });
    const heard: (StoredValue | null)[] = [];
    const stop = poller.subscribe('k', (value) => {
      heard.push(value);
    });
    await pause(120);
    // The write has reached the store but the adapter has not announced it yet.
    await poller.trackWrite('k', async () => {
      stored = { value: 'v', revision: '1' };
      await pause(200);
      poller.announce('k', stored);
    });
    await pause(200);
    stop();
    assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
  });

  void it('still hears a change another process makes after a local write', async () => {
    let stored: StoredValue | null = null;
    const poller = createChangePoller({
      intervalMs: 50,
      readKeys: (keys) =>
        Promise.resolve(
          new Map(stored === null ? [] : keys.map((key) => [key, stored!]))
        ),
      onError: undefined,
      describeFailure: (cause) => `poll failed (${cause})`,
    });
    const heard: (StoredValue | null)[] = [];
    const stop = poller.subscribe('k', (value) => {
      heard.push(value);
    });
    await pause(120);
    await poller.trackWrite('k', () => {
      stored = { value: 'mine', revision: '1' };
      poller.announce('k', stored);
      return Promise.resolve();
    });
    await pause(200);
    stored = { value: 'theirs', revision: '2' };
    await pause(250);
    stop();
    assert.deepEqual(heard, [
      { value: 'mine', revision: '1' },
      { value: 'theirs', revision: '2' },
    ]);
  });
});
