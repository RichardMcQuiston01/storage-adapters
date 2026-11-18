---
'@richardmcquiston01/storage-adapters': minor
---

Stop exporting helpers that were implementation details of key encoding and limits: `encodeInfluxKey`, `decodeInfluxKey`, `escapeInfluxValue` and `unescapeInfluxValue` from `/influxdb`, `encodeNatsKey` and `decodeNatsKey` from `/nats`, `encodeArangoKey` and `decodeArangoKey` from `/arangodb`, `prefixUpperBound` from `/rethinkdb`, and `MAX_VALUE_BYTES` from `/gcs`. None is documented. **Breaking** for code that imported one of them. The adapters behave as before.
