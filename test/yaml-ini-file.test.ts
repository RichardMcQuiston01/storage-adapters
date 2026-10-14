import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import * as ini from 'ini';
import YAML from 'yaml';

import { fingerprint } from '../src/document-file/plain-layout.js';
import type { FileSystemLike } from '../src/file/index.js';
import { nodeFileSystem } from '../src/file/node.js';
import { iniFileAdapter } from '../src/ini-file/index.js';
import type {
  StorageAdapter,
  StoredValue,
  StoreResult,
} from '../src/storage.js';
import { yamlFileAdapter } from '../src/yaml-file/index.js';
import { fakeFileSystem, pause, waitFor } from './support/fake-file-system.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

function expectFailure<T>(
  result: StoreResult<T>,
  code: string,
  key: string
): void {
  if (result.ok) {
    assert.fail(`expected a ${code} failure, got ${JSON.stringify(result)}`);
  }
  assert.equal(result.code, code);
  assert.ok(
    result.error.includes(`"${key}"`),
    `error should name the key: ${result.error}`
  );
}

async function withDirectory(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory: string = mkdtempSync(join(tmpdir(), 'plain-file-adapter-'));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface Flavor {
  readonly name: string;
  readonly label: string;
  readonly file: string;
  readonly create: (
    path: string,
    fileSystem: FileSystemLike,
    extra?: { cache?: boolean; watch?: boolean }
  ) => StorageAdapter;
  readonly parse: (text: string) => unknown;
  readonly stringify: (value: Record<string, unknown>) => string;
  /** The same file with comments and spacing changed but every value untouched. */
  readonly reformat: (key: string, value: string) => string;
  /** A file written by a person, with comments and mixed value types. */
  readonly handWritten: string;
  /** What each readable key in `handWritten` is worth as text. */
  readonly handValues: Record<string, string>;
  /** Keys in `handWritten` that are not a single plain value. */
  readonly handUnusable: readonly string[];
  /** Files that are not usable documents at all. */
  readonly brokenDocuments: readonly string[];
  /** Keys that must be stored and read back unchanged. */
  readonly awkwardKeys: readonly string[];
  /** Values that must be stored and read back unchanged. */
  readonly awkwardValues: readonly string[];
  /** Pairs the format cannot hold, which must be refused with `invalid`. */
  readonly refused: readonly (readonly [key: string, value: string])[];
}

const AWKWARD_VALUES: readonly string[] = [
  'hello',
  '',
  ' leading',
  'trailing ',
  'two\nlines',
  'tab\there',
  'quote"s',
  "it's",
  'a: b',
  '# not a comment',
  '; semi',
  'true',
  'false',
  '8080',
  '1.5',
  '1.10',
  '007',
  '2024-01-01',
  '~',
  'yes',
  'no',
  '=equals',
  '[bracket]',
  '{"json":1}',
  '- item',
  'back\\slash',
  'ünï 日本 😀',
  'x'.repeat(5000),
];

const flavors: readonly Flavor[] = [
  {
    name: 'YAML',
    label: 'YAML file',
    file: 'settings.yaml',
    create: (path, fileSystem, extra = {}) =>
      yamlFileAdapter({ path, fileSystem, yaml: YAML, ...extra }),
    parse: (text) => YAML.parse(text) as unknown,
    stringify: (value) => YAML.stringify(value),
    reformat: (key, value) =>
      `# reformatted by hand\n${key}:     ${JSON.stringify(value)}   # a note\n`,
    handWritten: [
      '# Settings for the app',
      'name: dark # an inline comment',
      'port: 8080',
      'debug: true',
      'version: "1.10"',
      'multi: |',
      '  line one',
      '  line two',
      'ratio: 1.10',
      'empty:',
      'list: [1, 2]',
      'nested:',
      '  a: 1',
      '',
    ].join('\n'),
    handValues: {
      name: 'dark',
      port: '8080',
      debug: 'true',
      version: '1.10',
      multi: 'line one\nline two\n',
    },
    handUnusable: ['ratio', 'empty', 'list', 'nested'],
    brokenDocuments: [
      'a: [unclosed',
      '- a\n- b\n',
      'just text',
      'a: 1\na: 2\n',
    ],
    awkwardKeys: [
      'a',
      'with space',
      'a.b',
      'é',
      'key:colon',
      '#hash',
      '- dash',
      '__proto__',
      'constructor',
      '',
    ],
    awkwardValues: AWKWARD_VALUES,
    refused: [],
  },
  {
    name: 'INI',
    label: 'INI file',
    file: 'settings.ini',
    create: (path, fileSystem, extra = {}) =>
      iniFileAdapter({ path, fileSystem, ini, ...extra }),
    // `ini` returns objects with no prototype; normalise so deepEqual compares them.
    parse: (text) => JSON.parse(JSON.stringify(ini.parse(text))) as unknown,
    stringify: (value) => ini.stringify(value),
    reformat: (key, value) =>
      `; reformatted by hand\n${key}   =   ${value}   ; a note\n`,
    handWritten: [
      '; Settings for the app',
      'name = dark ; an inline comment',
      'port = 8080',
      'debug = true',
      'version = 1.10',
      'bare',
      'quoted = "a b"',
      'empty =',
      'nulled = null',
      'list[] = 1',
      'list[] = 2',
      '',
      '[section]',
      'x = 1',
      '',
    ].join('\n'),
    handValues: {
      name: 'dark',
      port: '8080',
      debug: 'true',
      version: '1.10',
      bare: 'true',
      quoted: 'a b',
      empty: '',
    },
    handUnusable: ['nulled', 'list', 'section'],
    brokenDocuments: [],
    awkwardKeys: ['a', 'with space', 'a.b', 'é', 'key:colon', '#hash', ';semi'],
    awkwardValues: AWKWARD_VALUES,
    refused: [
      ['a', 'null'],
      ['a=b', 'x'],
      ['a[]', 'x'],
      ['__proto__', 'x'],
      ['', 'x'],
    ],
  },
];

for (const flavor of flavors) {
  const make = (
    directory: string,
    extra?: { cache?: boolean; watch?: boolean }
  ): { adapter: StorageAdapter; path: string } => {
    const path = join(directory, 'conf', flavor.file);
    return { adapter: flavor.create(path, nodeFileSystem(), extra), path };
  };

  void describe(`${flavor.name} file adapter`, () => {
    void it('stores a value and reads it back, with a revision worked out from the value', () =>
      withDirectory(async (directory) => {
        const { adapter } = make(directory);
        assert.deepEqual(await adapter.get('a', { signal }), {
          ok: true,
          value: null,
        });
        assert.deepEqual(expectOk(await adapter.set('a', 'one', { signal })), {
          value: 'one',
          revision: fingerprint('one'),
        });
        assert.deepEqual(expectOk(await adapter.get('a', { signal })), {
          value: 'one',
          revision: fingerprint('one'),
        });
        // The same text is the same revision; different text is a different one.
        assert.equal(
          expectOk(await adapter.set('a', 'one', { signal })).revision,
          fingerprint('one')
        );
        assert.notEqual(
          expectOk(await adapter.set('a', 'two', { signal })).revision,
          fingerprint('one')
        );
      }));

    void it('keeps plain entries in the file, sorted, with no revision beside them', () =>
      withDirectory(async (directory) => {
        const { adapter, path } = make(directory);
        expectOk(await adapter.set('zebra', 'last', { signal }));
        expectOk(await adapter.set('apple', 'first', { signal }));
        const parsed = flavor.parse(readFileSync(path, 'utf8')) as Record<
          string,
          unknown
        >;
        assert.deepEqual(parsed, { apple: 'first', zebra: 'last' });
        assert.deepEqual(Object.keys(parsed), ['apple', 'zebra']);
        assert.deepEqual(readdirSync(join(directory, 'conf')), [flavor.file]);
      }));

    void it('reads a file written by hand: strings, booleans and whole numbers', () =>
      withDirectory(async (directory) => {
        const path = join(directory, flavor.file);
        writeFileSync(path, flavor.handWritten);
        const adapter = flavor.create(path, nodeFileSystem());
        for (const [key, value] of Object.entries(flavor.handValues)) {
          assert.deepEqual(
            expectOk(await adapter.get(key, { signal })),
            { value, revision: fingerprint(value) },
            key
          );
        }
        assert.deepEqual(await adapter.get('absent', { signal }), {
          ok: true,
          value: null,
        });
      }));

    void it('calls an entry that is not one plain value corrupt, for that key only', () =>
      withDirectory(async (directory) => {
        const path = join(directory, flavor.file);
        writeFileSync(path, flavor.handWritten);
        const adapter = flavor.create(path, nodeFileSystem());
        for (const key of flavor.handUnusable) {
          expectFailure(await adapter.get(key, { signal }), 'corrupt', key);
        }
        assert.equal(
          expectOk(await adapter.get('name', { signal }))?.value,
          'dark'
        );
      }));

    void it('keeps entries it cannot read when it writes another one, and can replace them', () =>
      withDirectory(async (directory) => {
        const path = join(directory, flavor.file);
        writeFileSync(path, flavor.handWritten);
        const before = flavor.parse(flavor.handWritten) as Record<
          string,
          unknown
        >;
        const adapter = flavor.create(path, nodeFileSystem());
        expectOk(await adapter.set('name', 'light', { signal }));
        const after = flavor.parse(readFileSync(path, 'utf8')) as Record<
          string,
          unknown
        >;
        assert.deepEqual(after, { ...before, name: 'light' });
        // Replacing an unreadable entry replaces only that one.
        const unusable = flavor.handUnusable[0] as string;
        expectOk(await adapter.set(unusable, 'now plain', { signal }));
        const replaced = flavor.parse(readFileSync(path, 'utf8')) as Record<
          string,
          unknown
        >;
        assert.deepEqual(replaced, { ...after, [unusable]: 'now plain' });
      }));

    void it('does not keep comments or layout when it writes the file', () =>
      withDirectory(async (directory) => {
        const path = join(directory, flavor.file);
        writeFileSync(path, flavor.handWritten);
        const adapter = flavor.create(path, nodeFileSystem());
        expectOk(await adapter.set('name', 'light', { signal }));
        const text = readFileSync(path, 'utf8');
        assert.ok(!text.includes('Settings for the app'));
        assert.ok(!text.includes('inline comment'));
      }));

    void it('treats a hand edit as a new revision, and a reformat as no change', () =>
      withDirectory(async (directory) => {
        const { adapter, path } = make(directory);
        const first = expectOk(await adapter.set('a', 'one', { signal }));
        // A person changes the value.
        writeFileSync(path, flavor.stringify({ a: 'edited' }));
        expectFailure(
          await adapter.set('a', 'mine', {
            signal,
            ifRevision: first.revision ?? '',
          }),
          'conflict',
          'a'
        );
        const reread = expectOk(await adapter.get('a', { signal }));
        assert.deepEqual(reread, {
          value: 'edited',
          revision: fingerprint('edited'),
        });
        // A person only retypes the layout and comments; the value is the same.
        writeFileSync(path, flavor.reformat('a', 'edited'));
        assert.deepEqual(
          expectOk(
            await adapter.set('a', 'next', {
              signal,
              ifRevision: reread?.revision ?? '',
            })
          ),
          { value: 'next', revision: fingerprint('next') }
        );
      }));

    void it('stores awkward values and keys exactly, or refuses them, never changing them', () =>
      withDirectory(async (directory) => {
        const { adapter, path } = make(directory);
        const fresh = (): StorageAdapter =>
          flavor.create(path, nodeFileSystem());
        for (const key of flavor.awkwardKeys) {
          for (const value of flavor.awkwardValues) {
            const result = await adapter.set(key, value, { signal });
            const refused = flavor.refused.some(
              ([badKey, badValue]) => badKey === key && badValue === value
            );
            if (!result.ok) {
              assert.equal(
                result.code,
                'invalid',
                `${JSON.stringify([key, value])}`
              );
              assert.ok(
                refused,
                `unexpectedly refused ${JSON.stringify([key, value])}`
              );
              continue;
            }
            const stored = expectOk(await fresh().get(key, { signal }));
            assert.equal(
              stored?.value,
              value,
              `${flavor.name} changed ${JSON.stringify([key, value])}`
            );
            assert.equal(stored?.revision, fingerprint(value));
          }
        }
        assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
        // Everything stored is still readable after all those rewrites.
        for (const key of flavor.awkwardKeys) {
          assert.equal(
            expectOk(await fresh().get(key, { signal }))?.value,
            flavor.awkwardValues.at(-1)
          );
        }
      }));

    void it('refuses what the format cannot hold, naming the key, and writes nothing', () =>
      withDirectory(async (directory) => {
        const { adapter } = make(directory);
        for (const [key, value] of flavor.refused) {
          const result = await adapter.set(key, value, { signal });
          expectFailure(result, 'invalid', key);
          assert.ok(
            !result.ok &&
              result.error.startsWith(`${flavor.label} cannot store`),
            !result.ok ? result.error : ''
          );
        }
        assert.deepEqual(readdirSync(directory), []);
      }));

    void it('never overwrites a file that is not a usable document', () =>
      withDirectory(async (directory) => {
        for (const content of flavor.brokenDocuments) {
          const path = join(directory, flavor.file);
          writeFileSync(path, content);
          const adapter = flavor.create(path, nodeFileSystem());
          expectFailure(await adapter.get('a', { signal }), 'corrupt', 'a');
          expectFailure(
            await adapter.set('a', 'v', { signal }),
            'corrupt',
            'a'
          );
          expectFailure(
            (await adapter.remove?.('a', { signal })) as StoreResult<null>,
            'corrupt',
            'a'
          );
          assert.equal(readFileSync(path, 'utf8'), content);
        }
      }));

    void it('treats an empty file as an empty document', () =>
      withDirectory(async (directory) => {
        const path = join(directory, flavor.file);
        writeFileSync(path, '\n');
        const adapter = flavor.create(path, nodeFileSystem());
        assert.deepEqual(await adapter.get('a', { signal }), {
          ok: true,
          value: null,
        });
        expectOk(await adapter.set('a', 'v', { signal }));
        assert.deepEqual(flavor.parse(readFileSync(path, 'utf8')), { a: 'v' });
      }));

    void it('removes a key and keeps the others', () =>
      withDirectory(async (directory) => {
        const { adapter, path } = make(directory);
        expectOk(await adapter.set('a', 'one', { signal }));
        expectOk(await adapter.set('b', 'two', { signal }));
        await adapter.remove?.('a', { signal });
        assert.deepEqual(flavor.parse(readFileSync(path, 'utf8')), {
          b: 'two',
        });
        assert.deepEqual(await adapter.get('a', { signal }), {
          ok: true,
          value: null,
        });
      }));

    void it('keeps every key when many are written at the same time', () =>
      withDirectory(async (directory) => {
        const { adapter, path } = make(directory);
        const keys = Array.from({ length: 30 }, (_, index) => `key-${index}`);
        await Promise.all(
          keys.map((key) => adapter.set(key, `value of ${key}`, { signal }))
        );
        assert.equal(
          Object.keys(flavor.parse(readFileSync(path, 'utf8')) as object)
            .length,
          30
        );
      }));

    void it('lets exactly one racing writer with the same ifRevision win', () =>
      withDirectory(async (directory) => {
        const { adapter } = make(directory);
        const start = expectOk(await adapter.set('a', 'start', { signal }));
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            adapter.set('a', `writer ${index}`, {
              signal,
              ifRevision: start.revision ?? '',
            })
          )
        );
        assert.equal(results.filter((result) => result.ok).length, 1);
      }));

    void it('does not touch the file system for a key or value it will refuse', async () => {
      const fileSystem = fakeFileSystem(false);
      for (const [key, value] of flavor.refused) {
        const adapter = flavor.create(`/data/${flavor.file}`, fileSystem);
        expectFailure(
          await adapter.set(key, value, { signal }),
          'invalid',
          key
        );
      }
      assert.deepEqual(fileSystem.calls, []);
    });

    void it('reports an edit made by hand, but not one that only changes layout', async () => {
      const fileSystem = fakeFileSystem();
      const path = `/data/${flavor.file}`;
      fileSystem.files.set(path, flavor.stringify({ a: 'one', b: 'other' }));
      const adapter = flavor.create(path, fileSystem);
      const seen: (StoredValue | null)[] = [];
      adapter.subscribe?.('a', (stored) => seen.push(stored));
      await waitFor(
        () => fileSystem.watchers.size === 1,
        'the watcher to start'
      );

      // Only comments and spacing change: nothing to report.
      fileSystem.files.set(
        path,
        flavor.reformat('a', 'one') + flavor.stringify({ b: 'other' })
      );
      fileSystem.fire(path);
      await pause(40);
      assert.equal(seen.length, 0);

      // The value changes.
      fileSystem.files.set(path, flavor.stringify({ a: 'edited', b: 'other' }));
      fileSystem.fire(path);
      await waitFor(() => seen.length === 1, 'the edit to be reported');
      assert.deepEqual(seen, [
        { value: 'edited', revision: fingerprint('edited') },
      ]);

      // The key is deleted.
      fileSystem.files.set(path, flavor.stringify({ b: 'other' }));
      fileSystem.fire(path);
      await waitFor(() => seen.length === 2, 'the removal to be reported');
      assert.equal(seen[1], null);
    });

    void it('sees a real edit made by hand through fs.watch', () =>
      withDirectory(async (directory) => {
        const { adapter, path } = make(directory);
        expectOk(await adapter.set('theme', 'dark', { signal }));
        const seen: (StoredValue | null)[] = [];
        const unsubscribe: () => void =
          adapter.subscribe?.('theme', (stored) => seen.push(stored)) ??
          (() => {});
        await pause(150);
        writeFileSync(path, flavor.stringify({ theme: 'light (hand edit)' }));
        await waitFor(
          () => seen.some((stored) => stored?.value === 'light (hand edit)'),
          'the hand edit'
        );
        assert.equal(seen.at(-1)?.revision, fingerprint('light (hand edit)'));
        unsubscribe();
      }));

    void it('reads the file on every get when cache is false, and sees a hand edit at once', () =>
      withDirectory(async (directory) => {
        const { adapter, path } = make(directory, { cache: false });
        expectOk(await adapter.set('a', 'one', { signal }));
        writeFileSync(path, flavor.stringify({ a: 'two' }));
        assert.equal(
          expectOk(await adapter.get('a', { signal }))?.value,
          'two'
        );
      }));

    void it('maps a full disk to quota and keeps the old file', async () => {
      const fileSystem = fakeFileSystem(false);
      const path = `/data/${flavor.file}`;
      const adapter = flavor.create(path, fileSystem);
      expectOk(await adapter.set('a', 'one', { signal }));
      const before = fileSystem.files.get(path);
      fileSystem.failures.writeFile = Object.assign(new Error('ENOSPC'), {
        code: 'ENOSPC',
      });
      expectFailure(await adapter.set('a', 'two', { signal }), 'quota', 'a');
      assert.equal(fileSystem.files.get(path), before);
      assert.deepEqual([...fileSystem.files.keys()], [path]);
    });

    void it('starts every error message with its own name', async () => {
      const fileSystem = fakeFileSystem(false);
      const path = `/data/${flavor.file}`;
      fileSystem.failures.readFile = Object.assign(
        new Error('EIO: i/o error'),
        {
          code: 'EIO',
        }
      );
      const adapter = flavor.create(path, fileSystem);
      const read = await adapter.get('k', { signal });
      assert.ok(
        !read.ok && read.error.startsWith(`${flavor.label} `),
        String(read)
      );
      const written = await adapter.set('k', 'v', { signal });
      assert.ok(!written.ok && written.error.startsWith(`${flavor.label} `));
    });
  });
}
