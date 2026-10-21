/**
 * UTF-8 without `TextEncoder`/`TextDecoder`, which the runtime-neutral `src/` cannot
 * assume. Shared by the adapters that turn keys into names.
 */

/** Strict UTF-8 decoding without `TextDecoder`; `undefined` for invalid bytes. */
export function decodeUtf8(bytes: readonly number[]): string | undefined {
  let text = '';
  for (let index = 0; index < bytes.length;) {
    const first: number = bytes[index] ?? 0;
    const length: number =
      first < 0x80
        ? 1
        : first >= 0xc2 && first < 0xe0
          ? 2
          : first >= 0xe0 && first < 0xf0
            ? 3
            : first >= 0xf0 && first < 0xf5
              ? 4
              : 0;
    if (length === 0 || index + length > bytes.length) {
      return undefined;
    }
    let codePoint: number =
      length === 1 ? first : first & (0xff >> (length + 1));
    for (let offset = 1; offset < length; offset += 1) {
      const next: number = bytes[index + offset] ?? 0;
      if ((next & 0xc0) !== 0x80) {
        return undefined;
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (
      (length === 3 && codePoint < 0x800) ||
      (length === 4 && (codePoint < 0x10000 || codePoint > 0x10ffff)) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return undefined;
    }
    text += String.fromCodePoint(codePoint);
    index += length;
  }
  return text;
}

/** The UTF-8 bytes of one code point. */
export function utf8Bytes(codePoint: number): number[] {
  if (codePoint < 0x80) {
    return [codePoint];
  }
  if (codePoint < 0x800) {
    return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)];
  }
  if (codePoint < 0x10000) {
    return [
      0xe0 | (codePoint >> 12),
      0x80 | ((codePoint >> 6) & 0x3f),
      0x80 | (codePoint & 0x3f),
    ];
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f),
  ];
}

/** The UTF-8 bytes of text; the text must be valid Unicode (no lone surrogates). */
export function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    bytes.push(...utf8Bytes(char.codePointAt(0) ?? 0));
  }
  return Uint8Array.from(bytes);
}
