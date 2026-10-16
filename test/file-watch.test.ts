/** `fileAdapter.subscribe` hearing about files that other processes change. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { fileAdapter } from '../src/file/index.js';
import { encodeKey } from '../src/file/file.js';
import { nodeFileSystem } from '../src/file/node.js';
import type { StorageAdapter, StoredValue } from '../src/storage.js';
import {
  fakeFileSystem,
  pause,
  waitFor,
  withDirectoryWatch,
} from './support/fake-file-system.js';

const signal: AbortSignal = new AbortController().signal;

function stemOf(key: string): string {
  const stem: string | undefined = encodeKey(key);
  assert.ok(stem !== undefined);
  return stem;
}

function fileOf(directory: string, key: string): string {
  return `${directory}/${stemOf(key)}.json`;
}

function listen(adapter: StorageAdapter, key: string) {
  const heard: (StoredValue | null)[] = [];
  assert.ok(adapter.subscribe);
  const stop = adapter.subscribe(key, (stored) => heard.push(stored));
  return { heard, stop };
}

const tick = (): Promise<void> => pause(15);

void describe('fileAdapter.subscribe with a watched directory', () => {
  void it('reports a file another process wrote, removed or replaced', async () => {
    const fileSystem = withDirectoryWatch(fakeFileSystem(false));
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    const { heard } = listen(adapter, 'Theme');
    await tick();
    const file = fileOf('/data', 'Theme');

    fileSystem.files.set(file, JSON.stringify({ r: '1', v: 'dark' }));
    fileSystem.fireDirectory('/data', `${stemOf('Theme')}.json`);
    await tick();
    fileSystem.files.set(file, JSON.stringify({ r: '2', v: 'light' }));
    fileSystem.fireDirectory('/data', `${stemOf('Theme')}.json`);
    await tick();
    fileSystem.files.delete(file);
    fileSystem.fireDirectory('/data', `${stemOf('Theme')}.json`);
    await tick();

    assert.deepEqual(heard, [
      { value: 'dark', revision: '1' },
      { value: 'light', revision: '2' },
      null,
    ]);
  });

  void it('tells the subscriber of its own writes once, even though the watcher sees them too', async () => {
    const fileSystem = withDirectoryWatch(fakeFileSystem(false));
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    const { heard } = listen(adapter, 'a');
    await tick();
    const written = await adapter.set('a', 'mine', { signal });
    assert.ok(written.ok);
    fileSystem.fireDirectory('/data', `${stemOf('a')}.json`);
    fileSystem.fireDirectory('/data', `${stemOf('a')}.json`);
    await tick();
    assert.deepEqual(heard, [{ value: 'mine', revision: '1' }]);
    await adapter.remove?.('a', { signal });
    fileSystem.fireDirectory('/data', `${stemOf('a')}.json`);
    await tick();
    assert.deepEqual(heard.at(-1), null);
    assert.equal(heard.length, 2);
  });

  void it('does not report a file that did not change, or temporary and other keys', async () => {
    const fileSystem = withDirectoryWatch(fakeFileSystem(false));
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    fileSystem.files.set(
      fileOf('/data', 'a'),
      JSON.stringify({ r: '1', v: 'same' })
    );
    const { heard } = listen(adapter, 'a');
    await tick();
    fileSystem.fireDirectory('/data', `${stemOf('a')}.json`); // Nothing changed.
    fileSystem.fireDirectory('/data', `${stemOf('a')}.json.abc123.tmp`);
    fileSystem.files.set(
      fileOf('/data', 'other'),
      JSON.stringify({ r: '1', v: 'x' })
    );
    fileSystem.fireDirectory('/data', `${stemOf('other')}.json`);
    fileSystem.fireDirectory('/data', 'notes.txt');
    await tick();
    assert.deepEqual(heard, []);
  });

  void it('rechecks every subscribed key when the system cannot say which file changed', async () => {
    const fileSystem = withDirectoryWatch(fakeFileSystem(false));
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    const first = listen(adapter, 'a');
    const second = listen(adapter, 'b');
    await tick();
    fileSystem.files.set(
      fileOf('/data', 'b'),
      JSON.stringify({ r: '1', v: 'new' })
    );
    fileSystem.fireDirectory('/data', null);
    await tick();
    assert.deepEqual(first.heard, []);
    assert.deepEqual(second.heard, [{ value: 'new', revision: '1' }]);
  });

  void it('ignores a file that is half written or not an entry, and reports the next good one', async () => {
    const fileSystem = withDirectoryWatch(fakeFileSystem(false));
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    const { heard } = listen(adapter, 'a');
    await tick();
    const file = fileOf('/data', 'a');
    fileSystem.files.set(file, '{"r":"1","v"');
    fileSystem.fireDirectory('/data', `${stemOf('a')}.json`);
    await tick();
    assert.deepEqual(heard, []);
    fileSystem.files.set(file, JSON.stringify({ r: '1', v: 'whole' }));
    fileSystem.fireDirectory('/data', `${stemOf('a')}.json`);
    await tick();
    assert.deepEqual(heard, [{ value: 'whole', revision: '1' }]);
  });

  void it('watches once for any number of subscriptions, and stops with the last', async () => {
    const fileSystem = withDirectoryWatch(fakeFileSystem(false));
    const adapter = fileAdapter({ directory: '/data/', fileSystem });
    assert.equal(
      fileSystem.directoryWatchers.size,
      0,
      'not before anyone listens'
    );
    const first = listen(adapter, 'a');
    const second = listen(adapter, 'b');
    await tick();
    assert.equal(fileSystem.directoryWatchers.size, 1);
    assert.ok(fileSystem.calls.includes('watchDirectory /data'));
    first.stop();
    first.stop();
    assert.equal(fileSystem.directoryWatchers.size, 1);
    second.stop();
    assert.equal(fileSystem.directoryWatchers.size, 0);
    const again = listen(adapter, 'a');
    await tick();
    assert.equal(fileSystem.directoryWatchers.size, 1);
    again.stop();
  });

  void it('does not start watching if everyone unsubscribed while the folder was being made', async () => {
    const fileSystem = withDirectoryWatch(fakeFileSystem(false));
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    listen(adapter, 'a').stop();
    await tick();
    assert.equal(fileSystem.directoryWatchers.size, 0);
  });

  void it('keeps working when the file system cannot watch a directory', async () => {
    const adapter = fileAdapter({
      directory: '/data',
      fileSystem: fakeFileSystem(false),
    });
    const { heard } = listen(adapter, 'a');
    assert.ok((await adapter.set('a', 'v', { signal })).ok);
    assert.deepEqual(heard, [{ value: 'v', revision: '1' }]);
  });

  void it('keeps working when watching fails to start', async () => {
    const fileSystem = withDirectoryWatch(fakeFileSystem(false));
    fileSystem.watchDirectory = () => {
      throw new Error('too many watchers');
    };
    const adapter = fileAdapter({ directory: '/data', fileSystem });
    const { heard } = listen(adapter, 'a');
    await tick();
    assert.ok((await adapter.set('a', 'v', { signal })).ok);
    assert.equal(heard.length, 1);
  });
});

void describe('fileAdapter.subscribe on a real directory', () => {
  void it('hears a write made by another adapter, as another process would make it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'file-watch-'));
    try {
      const listening = fileAdapter({
        directory,
        fileSystem: nodeFileSystem(),
      });
      const writing = fileAdapter({ directory, fileSystem: nodeFileSystem() });
      const { heard, stop } = listen(listening, 'Settings');
      await pause(100);
      assert.ok((await writing.set('Settings', 'one', { signal })).ok);
      await waitFor(() => heard.length >= 1, 'the first change');
      assert.deepEqual(heard[0], { value: 'one', revision: '1' });
      assert.ok((await writing.set('Settings', 'two', { signal })).ok);
      await waitFor(() => heard.length >= 2, 'the second change');
      assert.deepEqual(heard[1], { value: 'two', revision: '2' });
      // A file edited by hand, with no adapter involved.
      const file = join(directory, `${stemOf('Settings')}.json`);
      writeFileSync(file, JSON.stringify({ r: '9', v: 'by hand' }));
      await waitFor(() => heard.length >= 3, 'the hand edit');
      assert.deepEqual(heard[2], { value: 'by hand', revision: '9' });
      unlinkSync(file);
      await waitFor(() => heard.length >= 4, 'the removal');
      assert.equal(heard[3], null);
      stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
