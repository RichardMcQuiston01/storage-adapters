import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPersistence,
  memoryAdapter,
  type PersistenceOptions,
  type StorageAdapter,
} from '../src/index.js';

interface Prefs {
  readonly theme: string;
  readonly tags: readonly string[];
}

const KEY = 'app:prefs';
const signal: AbortSignal = new AbortController().signal;

function parsePrefs(raw: unknown): Prefs {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('prefs must be an object');
  }
  const record = raw as Record<string, unknown>;
  const tags: unknown = record['tags'];
  return {
    theme: typeof record['theme'] === 'string' ? record['theme'] : 'light',
    tags: Array.isArray(tags)
      ? tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
  };
}

function prefsOf(theme: string, tags: string[] = []): Prefs {
  return { theme, tags };
}

function options(
  overrides: Partial<PersistenceOptions<Prefs>> = {}
): PersistenceOptions<Prefs> {
  return { parse: parsePrefs, label: 'preferences', ...overrides };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void describe('createPersistence', () => {
  void it('round trips a value and stamps savedAt', async () => {
    const store = createPersistence(memoryAdapter(), options());
    const saved = await store.save(KEY, prefsOf('dark', ['a']));
    assert.ok(saved.ok && saved.value.outcome === 'saved');
    const loaded = await store.load(KEY);
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.value.value, prefsOf('dark', ['a']));
    assert.ok(loaded.value.savedAt !== undefined);
    assert.ok(loaded.value.revision !== undefined);
  });

  void it('uses a custom field, version and serializer', async () => {
    const adapter = memoryAdapter();
    const store = createPersistence<Prefs>(adapter, {
      parse: parsePrefs,
      serialize: (value) => ({ theme: value.theme.toUpperCase() }),
      field: 'prefs',
      version: 3,
      now: () => 0,
    });
    await store.save(KEY, prefsOf('dark'));
    const raw = await adapter.get(KEY, { signal });
    assert.ok(raw.ok && raw.value !== null);
    assert.deepEqual(JSON.parse(raw.value.value), {
      v: 3,
      savedAt: '1970-01-01T00:00:00.000Z',
      prefs: { theme: 'DARK' },
    });
  });

  void it('returns null when nothing is stored', async () => {
    const store = createPersistence(memoryAdapter(), options());
    const loaded = await store.load(KEY);
    assert.ok(loaded.ok);
    assert.equal(loaded.value.value, null);
  });

  void it('reads a bare value saved without an envelope', async () => {
    const bare: string = JSON.stringify({ theme: 'dark' });
    const store = createPersistence(memoryAdapter({ [KEY]: bare }), options());
    const loaded = await store.load(KEY);
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.value.value, prefsOf('dark'));
    assert.equal(loaded.value.savedAt, undefined);
  });

  void it('repairs what parse repairs', async () => {
    const stored: string = JSON.stringify({
      v: 1,
      value: { theme: 7, tags: ['a', 3] },
    });
    const store = createPersistence(
      memoryAdapter({ [KEY]: stored }),
      options()
    );
    const loaded = await store.load(KEY);
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.value.value, prefsOf('light', ['a']));
  });

  void it('names the key for corrupt, unreadable and too-new values', async () => {
    const corrupt = createPersistence(
      memoryAdapter({ [KEY]: '{nope' }),
      options()
    );
    const first = await corrupt.load(KEY);
    assert.ok(!first.ok && first.code === 'corrupt');
    assert.match(
      first.error,
      /preferences stored at "app:prefs" is not valid JSON/
    );

    const unreadable = createPersistence(
      memoryAdapter({ [KEY]: JSON.stringify({ v: 1, value: 5 }) }),
      options()
    );
    const second = await unreadable.load(KEY);
    assert.ok(!second.ok && second.code === 'corrupt');
    assert.match(second.error, /could not be read: prefs must be an object/);

    const badVersion = createPersistence(
      memoryAdapter({ [KEY]: JSON.stringify({ v: 'x', value: {} }) }),
      options()
    );
    const third = await badVersion.load(KEY);
    assert.ok(!third.ok && third.code === 'corrupt');
    assert.match(third.error, /invalid version "x"/);

    const newer = createPersistence(
      memoryAdapter({ [KEY]: JSON.stringify({ v: 9, value: {} }) }),
      options()
    );
    const fourth = await newer.load(KEY);
    assert.ok(!fourth.ok && fourth.code === 'invalid');
    assert.match(fourth.error, /version 9, newer than this code reads \(1\)/);
  });

  void it('refuses a value over the size limit and says how big it was', async () => {
    const store = createPersistence(memoryAdapter(), options({ maxBytes: 80 }));
    const result = await store.save(KEY, prefsOf('x'.repeat(100)));
    assert.ok(!result.ok && result.code === 'invalid');
    assert.match(
      result.error,
      /"app:prefs": the preferences is \d+ bytes, over the 80 byte limit/
    );
  });

  void it('reports a value that cannot be serialized', async () => {
    const store = createPersistence<bigint>(memoryAdapter(), {
      parse: (raw) => BigInt(String(raw)),
    });
    const result = await store.save(KEY, 1n);
    assert.ok(!result.ok && result.code === 'invalid');
    assert.match(result.error, /can't be serialized/);
  });

  void it('collapses rapid saves into the newest and resolves every caller', async () => {
    const inner = memoryAdapter();
    const writes: string[] = [];
    const slow: StorageAdapter = {
      get: inner.get,
      set: async (key, value, o) => {
        await sleep(10);
        writes.push(value);
        return inner.set(key, value, o);
      },
    };
    const store = createPersistence(slow, options());
    const results = await Promise.all([
      store.save(KEY, prefsOf('a')),
      store.save(KEY, prefsOf('b')),
      store.save(KEY, prefsOf('c')),
    ]);
    assert.ok(results.every((r) => r.ok));
    assert.equal(writes.length, 2);
    const loaded = await store.load(KEY);
    assert.ok(loaded.ok);
    assert.equal(loaded.value.value?.theme, 'c');
  });

  void it('saves different keys independently', async () => {
    const store = createPersistence(memoryAdapter(), options());
    await Promise.all([
      store.save('one', prefsOf('a')),
      store.save('two', prefsOf('b')),
    ]);
    const one = await store.load('one');
    const two = await store.load('two');
    assert.ok(one.ok && two.ok);
    assert.equal(one.value.value?.theme, 'a');
    assert.equal(two.value.value?.theme, 'b');
  });

  void it('turns a throwing adapter into an error result', async () => {
    const broken: StorageAdapter = {
      get: () => Promise.reject(new Error('socket closed')),
      set: () => Promise.reject(new Error('socket closed')),
    };
    const store = createPersistence(broken, options());
    const loaded = await store.load(KEY);
    assert.ok(!loaded.ok && loaded.code === 'unavailable');
    assert.match(loaded.error, /Could not load .*socket closed/);
    const saved = await store.save(KEY, prefsOf('a'));
    assert.ok(!saved.ok);
    assert.match(saved.error, /Could not save/);
  });

  void it('removes a key, and a missing key is fine', async () => {
    const store = createPersistence(memoryAdapter(), options());
    await store.save(KEY, prefsOf('a'));
    assert.ok((await store.remove(KEY)).ok);
    const loaded = await store.load(KEY);
    assert.ok(loaded.ok && loaded.value.value === null);
    assert.ok((await store.remove(KEY)).ok);
  });

  void it('removing needs an adapter that can remove', async () => {
    const inner = memoryAdapter();
    const store = createPersistence(
      { get: inner.get, set: inner.set },
      options()
    );
    const result = await store.remove(KEY);
    assert.ok(!result.ok && result.code === 'invalid');
    assert.match(result.error, /"app:prefs".*no remove method/);
  });

  void it('track: false writes straight through, without revision checks', async () => {
    const adapter = memoryAdapter();
    const store = createPersistence(adapter, options());
    await store.save(KEY, prefsOf('a')); // revision 1, remembered
    await adapter.set(KEY, JSON.stringify({ v: 1, value: prefsOf('x') }), {
      signal,
    });
    const untracked = await store.save(KEY, prefsOf('b'), { track: false });
    assert.ok(untracked.ok && untracked.value.outcome === 'saved');
    const loaded = await store.load(KEY, { track: false });
    assert.ok(loaded.ok);
    assert.equal(loaded.value.value?.theme, 'b');
  });
});

void describe('conflict policies', () => {
  async function conflicted(
    overrides: Partial<PersistenceOptions<Prefs>>
  ): Promise<ReturnType<typeof createPersistence<Prefs>>> {
    const adapter = memoryAdapter();
    const store = createPersistence(adapter, options(overrides));
    await store.save(KEY, prefsOf('a')); // revision 1, remembered
    // Another device writes behind our back.
    const other = createPersistence(adapter, options());
    await other.load(KEY);
    await other.save(KEY, prefsOf('theirs', ['t']), { force: true });
    return store;
  }

  void it("'ask' (default) stores nothing and returns theirs", async () => {
    const store = await conflicted({});
    const result = await store.save(KEY, prefsOf('mine'));
    assert.ok(result.ok && result.value.outcome === 'conflict');
    assert.equal(result.value.value.theme, 'theirs');
    const forced = await store.save(KEY, prefsOf('mine'), { force: true });
    assert.ok(forced.ok && forced.value.outcome === 'saved');
  });

  void it("'overwrite' saves anyway", async () => {
    const store = await conflicted({ onConflict: 'overwrite' });
    const result = await store.save(KEY, prefsOf('mine'));
    assert.ok(result.ok && result.value.outcome === 'saved');
    const loaded = await store.load(KEY);
    assert.ok(loaded.ok);
    assert.equal(loaded.value.value?.theme, 'mine');
  });

  void it("'keep-theirs' drops the local save", async () => {
    const store = await conflicted({ onConflict: 'keep-theirs' });
    const result = await store.save(KEY, prefsOf('mine'));
    assert.ok(result.ok && result.value.outcome === 'kept-theirs');
    assert.equal(result.value.value.theme, 'theirs');
  });

  void it('a merge function decides what is saved', async () => {
    const store = await conflicted({
      onConflict: (mine, theirs) => ({ ...theirs, theme: mine.theme }),
    });
    const result = await store.save(KEY, prefsOf('mine'));
    assert.ok(result.ok && result.value.outcome === 'saved');
    assert.deepEqual(result.value.value, prefsOf('mine', ['t']));
  });

  void it('reports a throwing merge function', async () => {
    const store = await conflicted({
      onConflict: () => {
        throw new Error('cannot merge');
      },
    });
    const result = await store.save(KEY, prefsOf('mine'));
    assert.ok(!result.ok);
    assert.match(result.error, /merge function threw cannot merge/);
  });
});

void describe('watch', () => {
  void it('reports changes made elsewhere but not our own saves', async () => {
    const adapter = memoryAdapter();
    const mine = createPersistence(adapter, options());
    const theirs = createPersistence(adapter, options());
    const seen: (string | null)[] = [];
    const stop = mine.watch(KEY, (loaded) =>
      seen.push(loaded.value?.theme ?? null)
    );
    await mine.save(KEY, prefsOf('a'));
    assert.deepEqual(seen, []);
    await theirs.save(KEY, prefsOf('b'), { force: true });
    assert.deepEqual(seen, ['b']);
    await theirs.remove(KEY);
    assert.deepEqual(seen, ['b', null]);
    stop();
    await theirs.save(KEY, prefsOf('c'), { force: true });
    assert.equal(seen.length, 2);
  });

  void it('does nothing without adapter.subscribe', () => {
    const inner = memoryAdapter();
    const store = createPersistence(
      { get: inner.get, set: inner.set },
      options()
    );
    const stop = store.watch(KEY, () => undefined);
    assert.doesNotThrow(stop);
  });
});
