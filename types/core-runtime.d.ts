/**
 * Minimal global declarations for the runtime-neutral core.
 *
 * The core compiles with `lib: ["ES2023"]` and `types: []` (no DOM, no Node
 * types) but needs `AbortSignal`, `AbortController` and timers, which every
 * supported runtime provides (Node 18+, Bun, browsers). Only the members the
 * core uses are declared. This file is included by `tsconfig.json` alone; the
 * React and test compilations load the real DOM and Node declarations, and
 * the emitted `.d.ts` files refer to the global `AbortSignal`, which a
 * consumer's DOM lib or `@types/node` supplies.
 */

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { once?: boolean }
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare const AbortController: {
  new (): AbortController;
};

declare function setTimeout(handler: () => void, timeoutMs?: number): unknown;
declare function clearTimeout(handle: unknown): void;
