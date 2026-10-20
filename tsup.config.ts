import { defineConfig } from 'tsup';

// One entry per public subpath. Add new entries here and in package.json
// "exports" and "typesVersions" together.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    browser: 'src/browser/index.ts',
    indexeddb: 'src/indexeddb/index.ts',
    sqlite: 'src/sqlite/index.ts',
    postgres: 'src/postgres/index.ts',
    mysql: 'src/mysql/index.ts',
    s3: 'src/s3/index.ts',
    influxdb: 'src/influxdb/index.ts',
    memcached: 'src/memcached/index.ts',
    nats: 'src/nats/index.ts',
    neo4j: 'src/neo4j/index.ts',
    redis: 'src/redis/index.ts',
    rethinkdb: 'src/rethinkdb/index.ts',
    rest: 'src/rest/index.ts',
    arangodb: 'src/arangodb/index.ts',
    cassandra: 'src/cassandra/index.ts',
    couchdb: 'src/couchdb/index.ts',
    firebase: 'src/firebase/index.ts',
    'firebase-realtime': 'src/firebase/realtime.ts',
    supabase: 'src/supabase/index.ts',
    file: 'src/file/index.ts',
    'file-node': 'src/file/node.ts',
    'json-file': 'src/json-file/index.ts',
    'yaml-file': 'src/yaml-file/index.ts',
    'ini-file': 'src/ini-file/index.ts',
    react: 'src/react/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: {
    // tsup's declaration build sets `baseUrl`, which TypeScript 6 deprecates.
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2022',
  platform: 'neutral',
  // Keep `node:` on built-in imports: Deno rejects the bare names.
  removeNodeProtocol: false,
  external: [/^node:/, 'react'],
});
