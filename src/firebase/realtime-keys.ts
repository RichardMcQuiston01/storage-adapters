/**
 * How a storage key becomes the name of a Realtime Database child node, and back. Internal:
 * not exported from the package.
 */
import { utf8Length } from '../storage.js';

/** A node name is at most 768 bytes of UTF-8. */
const MAX_NODE_KEY_BYTES = 768;

/** A lone surrogate is not valid text, and the database refuses it. */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * The name of the child node that holds a key: `k`, then the key with every character the
 * database refuses in a name (`. $ # [ ] /`, control characters) and `%` itself written as
 * `%XX`. The `k` is there because the database treats a name that looks like an integer
 * specially (it sorts first, and a parent whose children are `0`, `1`, `2`... is read
 * back as an array); nothing here ever looks like one. Returns null for a key the
 * database cannot hold (a lone surrogate, or a name over 768 bytes).
 */
export function realtimeNodeKey(key: string): string | null {
  if (LONE_SURROGATE.test(key)) {
    return null;
  }
  const escaped: string = key.replace(
    // eslint-disable-next-line no-control-regex
    /[%.$#[\]/\u0000-\u001f\u007f]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  );
  const nodeKey = `k${escaped}`;
  return utf8Length(nodeKey) > MAX_NODE_KEY_BYTES ? null : nodeKey;
}

/** The key a node name stands for, or null if the name was not made by `realtimeNodeKey`. */
export function keyFromRealtimeNodeKey(nodeKey: string): string | null {
  if (!nodeKey.startsWith('k')) {
    return null;
  }
  return nodeKey
    .slice(1)
    .replace(/%([0-9A-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
}
