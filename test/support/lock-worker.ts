/**
 * Run as its own process by `test/file-lock.test.ts`: adds 1 to a shared counter
 * `count` times through compare-and-set, over a file adapter or a JSON file adapter
 * that other worker processes are using at the same moment.
 *
 *   bun lock-worker.ts <kind: file|json> <path> <count>
 */
import { fileAdapter } from '../../src/file/file.js';
import { nodeFileSystem } from '../../src/file/node.js';
import { jsonFileAdapter } from '../../src/json-file/index.js';

const [kind, path, countText] = process.argv.slice(2);
const count = Number(countText);
const lock = {
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  retryMs: 2,
  timeoutMs: 30_000,
};
const adapter =
  kind === 'json'
    ? jsonFileAdapter({
        path: `${path}/settings.json`,
        fileSystem: nodeFileSystem(),
        lock,
        watch: false,
        cache: false,
      })
    : fileAdapter({
        directory: path ?? '',
        fileSystem: nodeFileSystem(),
        lock,
      });
const signal = new AbortController().signal;

let done = 0;
let conflicts = 0;
while (done < count) {
  const read = await adapter.get('counter', { signal });
  if (!read.ok) {
    console.error(`read failed: ${read.error}`);
    process.exit(2);
  }
  const written = await adapter.set(
    'counter',
    String(Number(read.value?.value ?? '0') + 1),
    {
      signal,
      ...(read.value?.revision === undefined
        ? {}
        : { ifRevision: read.value.revision }),
    }
  );
  if (written.ok) {
    done += 1;
  } else if (written.code === 'conflict') {
    conflicts += 1; // Someone else's write got in between: read and try again.
  } else {
    console.error(`write failed: ${written.error}`);
    process.exit(3);
  }
}
console.log(JSON.stringify({ done, conflicts }));
