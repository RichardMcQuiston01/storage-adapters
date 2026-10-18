/**
 * A `StorageAdapter` over one YAML file that holds every key. No YAML parser is
 * bundled: you pass in the one you use, for example the `yaml` package.
 */
import type { FileSystemLike } from '../file/file.js';
import type { FileLockOptions } from '../file/lock.js';
import { documentFileAdapter } from '../document-file/document-file.js';
import { plainLayout } from '../document-file/plain-layout.js';
import type { StorageAdapter } from '../storage.js';

/** The parts of a parsed YAML document that keep comments, as the `yaml` package's `Document`. */
export interface YamlDocumentLike {
  readonly errors: readonly unknown[];
  has(key: unknown): boolean;
  get(key: unknown, keepScalar?: boolean): unknown;
  set(key: unknown, value: unknown): void;
  delete(key: unknown): boolean;
  toJS(): unknown;
  toString(): string;
}

/** The functions of a YAML library this adapter uses; `yaml`'s default export fits. */
export interface YamlLike {
  /** Throws when the text is not valid YAML. Use a parser that does not run code. */
  parse(text: string): unknown;
  stringify(value: unknown): string;
  /**
   * Optional. Parses text into a document that remembers its comments and layout.
   * With it, a write keeps the comments, order and spacing of the file; without it,
   * the file is written fresh.
   */
  parseDocument?(text: string): YamlDocumentLike;
}

export interface YamlFileAdapterOptions {
  /** The file to keep everything in. Its folder is created on first write. */
  readonly path: string;
  readonly fileSystem: FileSystemLike;
  /** Your YAML library, for example `import YAML from 'yaml'`. */
  readonly yaml: YamlLike;
  /**
   * Keep the comments, key order and spacing of the file when writing, if `yaml` has
   * `parseDocument`. Default `true`. Set `false` to write the file fresh, sorted by key.
   */
  readonly keepComments?: boolean;
  /**
   * Serve `get` from memory after the first read. Default `true`. Set `false` to
   * read the file on every `get`, so an edit made outside is seen at once.
   */
  readonly cache?: boolean;
  /**
   * Watch the file while something is subscribed, so an edit made outside is
   * noticed and reported. Default `true`. Needs a `FileSystemLike` with `watch`.
   */
  readonly watch?: boolean;
  /**
   * Take a lock file around each write, so several processes can share the file.
   * Needs a `FileSystemLike` with `writeNewFile`. Off by default.
   */
  readonly lock?: FileLockOptions;
}

/**
 * A `StorageAdapter` that keeps every key in one YAML file, as `key: value` lines
 * that are easy to read and edit. The revision is worked out from the value, so an
 * edit made by hand counts as a new revision. A value is text: a quoted or plain
 * string, `true` or `false`, or a whole number. A decimal, a list, a nested block or
 * an empty value is `corrupt` for that key; write it as a quoted string. A key or
 * value that YAML would not read back as the same text is refused with `invalid`.
 * Otherwise it behaves like `jsonFileAdapter`: cached reads, queued writes that
 * replace the file atomically, a broken file is never overwritten, and outside edits
 * are noticed when the file system can watch. When `yaml` has `parseDocument` (the
 * `yaml` package does), a write changes only the entry it is about: comments, key
 * order and spacing are kept, a new key is added at the end, and a removed key takes
 * its own comments with it. If keeping the layout would change any other entry (an
 * anchor and its alias share a value, for example), the file is written fresh instead,
 * without comments, so the stored values are always right. Nothing throws: every
 * failure is a `StoreResult`.
 */
/** Values are compared as the text they stand for: `8080` and `"8080"` are the same entry. */
function sameValue(left: unknown, right: unknown): boolean {
  const plain = (value: unknown): boolean =>
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean';
  if (plain(left) && plain(right)) {
    return String(left) === String(right);
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameDocument(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  const keys: string[] = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        sameValue(left[key], right[key])
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value of a parsed scalar node, or `undefined` for anything else. */
function scalarValueOf(node: unknown): unknown {
  return typeof node === 'object' && node !== null && 'value' in node
    ? (node as { value: unknown }).value
    : undefined;
}

/** Text that holds nothing but blank lines and comments: an empty document. */
function isCommentOnly(text: string): boolean {
  return text.split(/\r?\n/).every((line) => /^\s*(#.*)?$/.test(line));
}

/** Keeps a number or boolean a number or boolean when the new text still reads as one. */
function fitScalar(old: unknown, wanted: unknown): unknown {
  if (typeof wanted !== 'string') {
    return wanted;
  }
  if (typeof old === 'boolean' && (wanted === 'true' || wanted === 'false')) {
    return wanted === 'true';
  }
  if (
    typeof old === 'number' &&
    /^-?(0|[1-9][0-9]*)$/.test(wanted) &&
    Number.isSafeInteger(Number(wanted)) &&
    String(Number(wanted)) === wanted
  ) {
    return Number(wanted);
  }
  return wanted;
}

/**
 * Writes `document` into `previousText`, changing only the entries that differ, and
 * returns the new text, or `undefined` when that cannot be done safely. The result is
 * read back and must hold exactly `document`, so a shared anchor or an odd tag can
 * never leave another entry with the wrong value.
 */
function updateText(
  yaml: YamlLike,
  document: Record<string, unknown>,
  previousText: string
): string | undefined {
  if (yaml.parseDocument === undefined) {
    return undefined;
  }
  try {
    const parsed: YamlDocumentLike = yaml.parseDocument(previousText);
    // A file with only comments is an empty document, which `toJS` gives as `null`.
    const current: unknown = isCommentOnly(previousText) ? {} : parsed.toJS();
    if (parsed.errors.length > 0 || !isRecord(current)) {
      return undefined;
    }
    for (const key of Object.keys(current)) {
      if (!Object.prototype.hasOwnProperty.call(document, key)) {
        parsed.delete(key);
      }
    }
    for (const [key, wanted] of Object.entries(document)) {
      const present: boolean = Object.prototype.hasOwnProperty.call(
        current,
        key
      );
      if (present && sameValue(current[key], wanted)) {
        continue;
      }
      // Setting a plain value changes it in place, so its comments stay.
      const old: unknown = present
        ? scalarValueOf(parsed.get(key, true))
        : undefined;
      parsed.set(key, fitScalar(old, wanted));
    }
    const text: string = parsed.toString();
    const back: unknown = yaml.parse(text);
    return isRecord(back) && sameDocument(back, document) ? text : undefined;
  } catch {
    return undefined;
  }
}

export function yamlFileAdapter(
  options: YamlFileAdapterOptions
): StorageAdapter {
  const { yaml } = options;
  const codec = {
    // A file of only comments holds no entries yet; it is not a broken file.
    parse: (text: string): unknown =>
      isCommentOnly(text) ? {} : yaml.parse(text),
    stringify: (document: Record<string, unknown>): string =>
      yaml.stringify(document),
    ...(options.keepComments === false
      ? {}
      : {
          update: (
            document: Record<string, unknown>,
            previousText: string
          ): string | undefined => updateText(yaml, document, previousText),
        }),
  };
  return documentFileAdapter({
    label: 'YAML file',
    path: options.path,
    fileSystem: options.fileSystem,
    codec,
    layout: plainLayout(codec, 'YAML'),
    cache: options.cache ?? true,
    watch: options.watch ?? true,
    ...(options.lock === undefined ? {} : { lock: options.lock }),
  });
}
