import type { StorageAdapter } from '../storage.js';
import {
  webStorageAdapter,
  type WebStorageAdapterOptions,
} from './web-storage.js';

export type SessionStorageAdapterOptions = WebStorageAdapterOptions;

/**
 * A `StorageAdapter` over `sessionStorage` (or any Web Storage object): data that
 * lasts as long as the tab. It stores the same revisioned envelope as
 * `localStorageAdapter`, so `set` with `ifRevision` reports `conflict` when another
 * document sharing this storage wrote first. Each tab has its own `sessionStorage`,
 * so `subscribe` only hears about writes from other documents in the same tab, such
 * as same-origin iframes. Nothing throws: every failure is a `StoreResult`.
 */
export function sessionStorageAdapter(
  options: SessionStorageAdapterOptions = {}
): StorageAdapter {
  return webStorageAdapter('sessionStorage', options);
}
