import type { StorageAdapter } from '../storage.js';
import {
  webStorageAdapter,
  type WebStorageAdapterOptions,
} from './web-storage.js';

export type LocalStorageAdapterOptions = WebStorageAdapterOptions;

/**
 * A `StorageAdapter` over `localStorage` (or any Web Storage object). Each value is
 * stored with a counter revision, so `set` with `ifRevision` reports `conflict` when
 * another tab wrote first, and `subscribe` reports changes made in other tabs.
 * Nothing throws: every failure is a `StoreResult`.
 */
export function localStorageAdapter(
  options: LocalStorageAdapterOptions = {}
): StorageAdapter {
  return webStorageAdapter('localStorage', options);
}
