import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DocumentCodec } from '../src/document-file/document-file.js';
import { fingerprint, plainLayout } from '../src/document-file/plain-layout.js';

/** A codec that writes `key=value` lines and reads them back, for exercising the layout. */
const lineCodec: DocumentCodec = {
  parse: (text) =>
    Object.fromEntries(
      text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        })
    ),
  stringify: (document) =>
    Object.entries(document)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('\n'),
};

void describe('fingerprint', () => {
  void it('gives the same text the same fingerprint every time', () => {
    assert.equal(fingerprint('dark'), fingerprint('dark'));
    assert.equal(fingerprint(''), fingerprint(''));
  });

  void it('gives lowercase hex text', () => {
    for (const text of ['', 'a', 'dark', 'ünï 日本 😀', 'x'.repeat(10000)]) {
      assert.match(fingerprint(text), /^[0-9a-f]{1,14}$/);
    }
  });

  void it('has fixed known values, so a revision means the same in every release', () => {
    // cyrb53("a") is documented as 7929297801672961 by its author.
    assert.equal(fingerprint('a'), (7929297801672961).toString(16));
    assert.equal(fingerprint(''), 'bdcb81aee8d83');
    assert.equal(fingerprint('dark'), '17be05d277e48a');
    assert.notEqual(fingerprint('dark'), fingerprint('light'));
  });

  void it('tells apart texts that differ by one character, case or order', () => {
    const texts = [
      'dark',
      'Dark',
      'dar',
      'darkk',
      'drak',
      ' dark',
      'dark ',
      'dark\n',
    ];
    assert.equal(new Set(texts.map(fingerprint)).size, texts.length);
  });

  void it('does not repeat across a large set of different texts', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 100000; index += 1) {
      seen.add(fingerprint(`value-${index}`));
    }
    assert.equal(seen.size, 100000);
  });
});

void describe('plainLayout', () => {
  const layout = plainLayout(lineCodec, 'LINES');

  void it('reads a string as itself, with a revision worked out from it', () => {
    assert.deepEqual(layout.read('dark'), {
      value: 'dark',
      revision: fingerprint('dark'),
    });
    assert.deepEqual(layout.read(''), { value: '', revision: fingerprint('') });
  });

  void it('reads a boolean or a whole number as its usual text', () => {
    assert.equal(layout.read(true)?.value, 'true');
    assert.equal(layout.read(false)?.value, 'false');
    assert.equal(layout.read(8080)?.value, '8080');
    assert.equal(layout.read(-3)?.value, '-3');
    assert.equal(layout.read(0)?.value, '0');
  });

  void it('refuses anything that is not plain text rather than guessing', () => {
    for (const raw of [
      1.5, // already changed from "1.50" by the time it is parsed
      Number.MAX_SAFE_INTEGER + 2,
      NaN,
      Infinity,
      null,
      undefined,
      [],
      ['a'],
      {},
      { a: 1 },
      new Date(0),
      Symbol('s'),
      10n,
    ]) {
      assert.equal(layout.read(raw), undefined, String(raw?.toString?.()));
    }
  });

  void it('writes the value as it is, and returns the same revision a read would', () => {
    const written = layout.write('dark', null);
    assert.equal(written.raw, 'dark');
    assert.deepEqual(written.stored, {
      value: 'dark',
      revision: fingerprint('dark'),
    });
    assert.deepEqual(layout.read(written.raw), written.stored);
  });

  void it('does not use the old revision: the same text always has the same one', () => {
    assert.deepEqual(
      layout.write('same', null).stored,
      layout.write('same', null).stored
    );
  });

  void it('accepts a key and value the format reads back unchanged', () => {
    assert.equal(layout.check?.('theme', 'dark'), undefined);
    assert.equal(layout.check?.('theme', ''), undefined);
    assert.equal(layout.check?.('t', '8080'), undefined);
  });

  void it('refuses a key or value the format would change, naming the format', () => {
    const problem = layout.check?.('key', 'line one\nline two');
    assert.ok(problem?.includes('LINES'), String(problem));
    assert.ok(problem?.includes('would not read back as the same text'));
    assert.ok(layout.check?.('a=b', 'x') !== undefined); // the key is split at the first =
  });

  void it('refuses when the format cannot write or read at all', () => {
    const broken = plainLayout(
      {
        parse: () => {
          throw new Error('cannot parse');
        },
        stringify: () => {
          throw new Error('cannot write');
        },
      },
      'BROKEN'
    );
    assert.ok(broken.check?.('a', 'b')?.includes('BROKEN'));
  });

  void it('refuses when the format hands back something that is not an object', () => {
    const odd = plainLayout(
      { parse: () => 'text', stringify: () => 'text' },
      'ODD'
    );
    assert.ok(odd.check?.('a', 'b') !== undefined);
    const empty = plainLayout(
      { parse: () => null, stringify: () => '' },
      'NULLS'
    );
    assert.ok(empty.check?.('a', 'b') !== undefined);
  });
});
