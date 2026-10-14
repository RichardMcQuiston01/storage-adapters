import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STORAGE_ADAPTERS_READY } from '../src/index.js';

test('package entry loads', () => {
  assert.equal(STORAGE_ADAPTERS_READY, true);
});
