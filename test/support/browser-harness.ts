/**
 * Runs the real browser adapters in a real Chromium, for `browser-chromium.test.ts`.
 *
 * A small HTTP server serves the built package (`dist/`) on `127.0.0.1`, because
 * `localStorage` and IndexedDB need a real origin. Each page loads `dist/browser.js`
 * and `dist/indexeddb.js` as ES modules. `remoteAdapter` then gives Node a
 * `StorageAdapter` whose calls run inside a page, so the shared conformance suite
 * (which is plain Node code) runs against the browser's own storage.
 */
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Browser, BrowserContext, Frame, Page } from 'playwright-core';

import type { StorageAdapter, StoredValue } from '../../src/storage.js';

const DIST = new URL('../../dist/', import.meta.url);

const SHELL = `<!doctype html>
<meta charset="utf-8">
<title>storage-adapters</title>
<script type="module">
  import * as browser from '/dist/browser.js';
  import * as indexeddb from '/dist/indexeddb.js';
  window.lib = { ...browser, ...indexeddb };
  window.addFrame = async (src) => {
    const frame = document.createElement('iframe');
    frame.src = src;
    document.body.append(frame);
    await new Promise((resolve) => frame.addEventListener('load', resolve));
  };
  window.libReady = true;
</script>
`;

/** A page that holds a frame with no way to reach its own origin's storage. */
const SANDBOX = `<!doctype html>
<meta charset="utf-8">
<title>sandboxed</title>
<script>
  addEventListener('message', (event) => { window.sandboxResult = event.data; });
</script>
<iframe id="inner" sandbox="allow-scripts" srcdoc='<script type="module">
  try {
    const lib = await import("__ORIGIN__/dist/browser.js");
    const adapter = lib.localStorageAdapter();
    const result = await adapter.get("k", { signal: new AbortController().signal });
    parent.postMessage({ done: true, result }, "*");
  } catch (error) {
    parent.postMessage({ done: true, failure: String(error) }, "*");
  }
</script>'></iframe>
`;

/**
 * Where a page's notifications go. The harness sets up `window.__notify` on every
 * page it opens (a binding Node can receive calls on), and `remoteAdapter` registers
 * its subscriptions here.
 */
const pageListeners = new WeakMap<
  Page,
  Map<number, (stored: StoredValue | null) => void>
>();
let nextId = 0;

export interface Harness {
  readonly origin: string;
  /** A fresh browser profile: its own storage, shared by the pages opened in it. */
  newContext(): Promise<BrowserContext>;
  /** Opens the shell page (the library loaded) in a context. */
  openPage(context: BrowserContext, path?: string): Promise<Page>;
  close(): Promise<void>;
}

function serve(
  request: IncomingMessage,
  response: ServerResponse,
  origin: () => string
): void {
  const path: string = (request.url ?? '/').split('?')[0] ?? '/';
  const headers = {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  };
  if (path.startsWith('/dist/') && /^\/dist\/[\w.-]+$/.test(path)) {
    try {
      const body = readFileSync(new URL(path.slice('/dist/'.length), DIST));
      response.writeHead(200, {
        ...headers,
        'content-type': 'text/javascript; charset=utf-8',
      });
      response.end(body);
    } catch {
      response.writeHead(404, headers).end('not built: run `bun run build`');
    }
    return;
  }
  response.writeHead(200, {
    ...headers,
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(
    path === '/sandbox' ? SANDBOX.replace('__ORIGIN__', origin()) : SHELL
  );
}

/** Starts the server and Chromium. `executablePath` is for a browser Playwright did not install. */
export async function startHarness(executablePath?: string): Promise<Harness> {
  const { chromium } = await import('playwright-core');
  let origin = '';
  const server: Server = createServer((request, response) => {
    serve(request, response, () => origin);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser: Browser = await chromium.launch(
    executablePath === undefined ? {} : { executablePath }
  );

  return {
    origin,
    newContext: () => browser.newContext(),
    openPage: async (context, path = '/') => {
      const page: Page = await context.newPage();
      const listeners = new Map<number, (stored: StoredValue | null) => void>();
      pageListeners.set(page, listeners);
      await page.exposeFunction(
        '__notify',
        (subscription: number, stored: StoredValue | null) => {
          listeners.get(subscription)?.(stored);
        }
      );
      await page.goto(`${origin}${path}`);
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { libReady?: boolean }).libReady === true
      );
      return page;
    },
    close: async () => {
      await browser.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** Which adapter to make inside the page. */
export type AdapterSpec =
  | { readonly kind: 'local' }
  | { readonly kind: 'session' }
  | {
      readonly kind: 'idb';
      readonly database: string;
      readonly channel?: boolean;
    };

/** What the proxy needs: a page, or a frame inside one. */
export type Target = Page | Frame;

function pageOf(target: Target): Page {
  return 'page' in target && typeof target.page === 'function'
    ? target.page()
    : (target as Page);
}

/**
 * A `StorageAdapter` whose real implementation runs inside `target`. Every call is
 * sent to the page; results come back as JSON (a `StoreResult` always is). `subscribe`
 * is synchronous, as the contract says, so the work it needs is queued and every call
 * waits for the queue first.
 */
export function remoteAdapter(
  target: Target,
  spec: AdapterSpec
): StorageAdapter & { dispose(): Promise<void> } {
  const id = ++nextId;
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };
  const listeners = pageListeners.get(pageOf(target));
  if (listeners === undefined) {
    throw new Error(
      'open the page with harness.openPage so it can send notifications'
    );
  }

  void enqueue(() =>
    target.evaluate(
      ({ id, spec }) => {
        const w = globalThis as unknown as {
          lib: Record<string, (options?: unknown) => unknown>;
          __remote?: {
            adapters: Map<number, unknown>;
            unsubs: Map<number, () => void>;
          };
        };
        w.__remote ??= { adapters: new Map(), unsubs: new Map() };
        const make = {
          local: () => w.lib.localStorageAdapter?.(),
          session: () => w.lib.sessionStorageAdapter?.(),
          idb: () =>
            w.lib.indexedDbAdapter?.({
              databaseName: (spec as { database: string }).database,
            }),
        }[spec.kind];
        w.__remote.adapters.set(id, make());
      },
      { id, spec }
    )
  );

  const call = (
    method: 'get' | 'set' | 'remove' | 'list',
    args: unknown[],
    aborted: boolean
  ): Promise<never> =>
    enqueue(() =>
      target.evaluate(
        async ({ id, method, args, aborted }) => {
          const w = globalThis as unknown as {
            __remote: {
              adapters: Map<
                number,
                Record<string, (...a: unknown[]) => Promise<unknown>>
              >;
            };
          };
          const adapter = w.__remote.adapters.get(id);
          if (adapter === undefined) {
            throw new Error('adapter was not created');
          }
          const signal = aborted
            ? AbortSignal.abort()
            : new AbortController().signal;
          if (method === 'set') {
            const [key, value, ifRevision] = args as [string, string, string?];
            return adapter.set?.(key, value, {
              signal,
              ...(ifRevision === undefined ? {} : { ifRevision }),
            });
          }
          return adapter[method]?.(args[0], { signal });
        },
        { id, method, args, aborted }
      )
    ) as Promise<never>;

  return {
    get: (key, { signal }) => call('get', [key], signal.aborted),
    set: (key, value, { signal, ifRevision }) =>
      call('set', [key, value, ifRevision], signal.aborted),
    remove: (key, { signal }) => call('remove', [key], signal.aborted),
    list: (prefix, { signal }) => call('list', [prefix], signal.aborted),
    subscribe: (key, onChange) => {
      const subscription = ++nextId;
      listeners.set(subscription, onChange);
      void enqueue(() =>
        target.evaluate(
          ({ id, key, subscription }) => {
            const w = globalThis as unknown as {
              __notify: (subscription: number, stored: unknown) => void;
              __remote: {
                adapters: Map<
                  number,
                  {
                    subscribe?: (
                      key: string,
                      onChange: (stored: unknown) => void
                    ) => () => void;
                  }
                >;
                unsubs: Map<number, () => void>;
              };
            };
            const adapter = w.__remote.adapters.get(id);
            const stop = adapter?.subscribe?.(key, (stored) => {
              w.__notify(subscription, stored);
            });
            if (stop !== undefined) {
              w.__remote.unsubs.set(subscription, stop);
            }
          },
          { id, key, subscription }
        )
      );
      return () => {
        void enqueue(async () => {
          await target.evaluate(
            ({ subscription }) => {
              const w = globalThis as unknown as {
                __remote: { unsubs: Map<number, () => void> };
              };
              w.__remote.unsubs.get(subscription)?.();
              w.__remote.unsubs.delete(subscription);
            },
            { subscription }
          );
          listeners.delete(subscription);
        });
      };
    },
    dispose: async () => {
      await queue;
    },
  };
}
