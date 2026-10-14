# @richardmcquiston01/storage-adapters

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [Buy Me a Coffee](#buy-me-a-coffee) | [License](#license) | [Copyright](#copyright) |

## Overview

Tiny, runtime-neutral storage adapter layer for TypeScript: an async key-value contract with typed errors and revisions, composable wrappers (prefix, fallback, retry, cache, encoding), and a generic persistence helper with conflict handling. No I/O in the core.

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

Node 18+ or Bun 1.3+. TypeScript is optional but recommended; the package
ships declarations for ESM and CommonJS.

### Installation

```bash
bun add @richardmcquiston01/storage-adapters
# or: npm install @richardmcquiston01/storage-adapters
```

### Usage

An adapter is an async key-value store with typed errors and optional
revisions for conflict detection. Results are values you check, never
thrown errors.

```ts
import {
  memoryAdapter,
  withFallback,
  withPrefix,
  type StorageAdapter,
} from '@richardmcquiston01/storage-adapters';

const adapter: StorageAdapter = withPrefix(
  withFallback(myBrowserAdapter, memoryAdapter()),
  'my-app:'
);

const signal: AbortSignal = new AbortController().signal;
const saved = await adapter.set('theme', 'dark', { signal });
if (!saved.ok) {
  console.error(saved.code, saved.error); // names the key and the cause
}
```

Wrappers: `withPrefix`, `withFallback`, `withReadCache`, `readOnly`,
`withRetry` (you pass `sleep`, so there are no timers), `withEncoding`
(compression or encryption, with your own functions) and `withLogging`
(keys and outcomes, never values). Implement `get`, `set` and optionally
`remove` and `subscribe` for localStorage, IndexedDB, REST or a database.

### Examples

See `test/adapters.test.ts` for each wrapper in use.

[Back to Top](#table-of-contents)

## Buy Me a Coffee

If this app, code, or repository has helped you or someone you know, please consider donating. I appreciate any help to offset the costs of development and/or AI Credits.

[**Donate via Stripe**](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800), or scan:

[![Donate via Stripe](./donate.svg)](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800)

[Back to Top](#table-of-contents)

## License

Apache 2

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
