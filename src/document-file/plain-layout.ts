/**
 * The entry layout for hand-edited formats such as YAML and INI: each key holds its
 * value as plain text (`key: value`, `key = value`), and nothing else is stored.
 * There is no counter to keep beside the value, so the revision is worked out from
 * the value itself. That means an edit made by hand is noticed as a new revision.
 */
import type { StoredValue } from '../storage.js';
import type { DocumentCodec, EntryLayout } from './document-file.js';

/**
 * A short fingerprint of text (cyrb53, 53 bits), as lowercase hex. The same text
 * always gives the same fingerprint, in every runtime.
 */
export function fingerprint(text: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const unit: number = text.charCodeAt(index);
    first = Math.imul(first ^ unit, 2654435761);
    second = Math.imul(second ^ unit, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507);
  first ^= Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507);
  second ^= Math.imul(first ^ (first >>> 13), 3266489909);
  return (4294967296 * (2097151 & second) + (first >>> 0)).toString(16);
}

/**
 * The text a parsed entry stands for, or `undefined` if it is not a plain value.
 * Strings are taken as they are. A boolean or a whole number is taken as its usual
 * text, which is exact. Anything else is refused rather than guessed at: a decimal
 * such as `1.10` is already `1.1` once parsed, and a list or a nested block is not
 * a single value.
 */
function textOf(parsed: unknown): string | undefined {
  if (typeof parsed === 'string') {
    return parsed;
  }
  if (typeof parsed === 'boolean') {
    return String(parsed);
  }
  if (typeof parsed === 'number' && Number.isSafeInteger(parsed)) {
    return String(parsed);
  }
  return undefined;
}

export function plainLayout(
  codec: DocumentCodec,
  formatName: string
): EntryLayout {
  return {
    check(key: string, value: string): string | undefined {
      // Write the entry out and read it back; refuse anything that comes back changed.
      try {
        const parsed: unknown = codec.parse(codec.stringify({ [key]: value }));
        if (typeof parsed === 'object' && parsed !== null) {
          const keys: string[] = Object.keys(parsed);
          const back: string | undefined = textOf(
            (parsed as Record<string, unknown>)[key]
          );
          if (keys.length === 1 && keys[0] === key && back === value) {
            return undefined;
          }
        }
      } catch {
        // Falls through to the refusal below.
      }
      return `cannot store this key and value in ${formatName} (it would not read back as the same text)`;
    },

    read(raw: unknown): StoredValue | undefined {
      const text: string | undefined = textOf(raw);
      return text === undefined
        ? undefined
        : { value: text, revision: fingerprint(text) };
    },

    write(value: string) {
      return {
        raw: value,
        stored: { value, revision: fingerprint(value) },
      };
    },
  };
}
