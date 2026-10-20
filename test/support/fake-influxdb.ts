/**
 * An in-memory stand-in for an InfluxDB server's HTTP API, with the behaviour the adapter
 * relies on (checked against a real InfluxDB server through its 2.x-compatible API): a
 * write to the same series and timestamp replaces the point, a Flux query answers in
 * annotated CSV with CRLF line breaks and one table per series, an empty answer is a
 * single blank line, a query that fails while it runs answers 200 with an `error` table,
 * and a missing bucket is an error. Requests are recognised by their text.
 * test/influxdb-server.test.ts runs the adapter against a real server.
 */
import type { InfluxDbFetch } from '../../src/influxdb/index.js';

interface FakePoint {
  /** The value field exactly as it was written (already escaped by the adapter). */
  value: string | null;
  revision: string | null;
  updatedAt: string | null;
  /** Tags besides `key`, for points something else wrote. */
  extraTags: Record<string, string>;
}

/** A failure to answer with instead of the real answer. */
export type FakeFailure =
  | { readonly status: number; readonly body: string }
  | { readonly throws: Error };

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

/** Splits `text` at commas that are not escaped with a backslash. */
function splitUnescaped(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === '\\') {
      current += char + text.charAt(index + 1);
      index += 1;
    } else if (char === separator) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

const unescapeTag = (text: string): string => text.replace(/\\(.)/g, '$1');

/** Splits a line of line protocol into its tag part and its field part. */
function splitLine(line: string): { head: string; fieldText: string } {
  let cursor = 0;
  while (cursor < line.length && line.charAt(cursor) !== ' ') {
    cursor += line.charAt(cursor) === '\\' ? 2 : 1;
  }
  const head = line.slice(0, cursor);
  let quoted = false;
  let end = cursor + 1;
  while (end < line.length) {
    const char = line.charAt(end);
    if (char === '\\') {
      end += 2;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ' ' && !quoted) {
      break;
    }
    end += 1;
  }
  return { head, fieldText: line.slice(cursor + 1, end) };
}

/** The value of a Flux string literal at `index` (which is its opening quote). */
function readFluxString(
  text: string,
  index: number
): { value: string; end: number } {
  let value = '';
  let cursor = index + 1;
  while (cursor < text.length && text.charAt(cursor) !== '"') {
    if (text.charAt(cursor) === '\\') {
      cursor += 1;
      const escaped = text.charAt(cursor);
      value +=
        escaped === 'n'
          ? '\n'
          : escaped === 'r'
            ? '\r'
            : escaped === 't'
              ? '\t'
              : escaped;
    } else {
      value += text.charAt(cursor);
    }
    cursor += 1;
  }
  return { value, end: cursor + 1 };
}

function csvCell(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const START = '1970-01-01T00:00:00Z';

export class FakeInfluxDb {
  /** Points by measurement, then key tag. */
  readonly measurements = new Map<string, Map<string, FakePoint>>();
  readonly buckets = new Set<string>(['app']);
  readonly requests: FakeRequest[] = [];
  /** Answers to give to the next requests instead of the real ones, in order. */
  readonly failures: FakeFailure[] = [];
  /** Runs just before a write is applied, to simulate another writer. */
  beforeWrite: ((measurement: string, key: string) => void) | null = null;
  /** Milliseconds a write's answer takes to come back, so polls and writes can overlap. */
  writeLatencyMs = 0;
  /** When true, writes are refused as beyond the retention period. */
  retention = false;

  /** Writes behind the adapter's back, as another process would. */
  put(
    measurement: string,
    key: string,
    point: Partial<FakePoint> & { value: string | null }
  ): void {
    this.pointsFor(measurement).set(key, {
      revision: null,
      updatedAt: null,
      extraTags: {},
      ...point,
    });
  }

  /** Removes a point behind the adapter's back. */
  delete(measurement: string, key: string): void {
    this.measurements.get(measurement)?.delete(key);
  }

  private pointsFor(measurement: string): Map<string, FakePoint> {
    const points = this.measurements.get(measurement) ?? new Map();
    this.measurements.set(measurement, points);
    return points;
  }

  readonly fetch: InfluxDbFetch = async (url, init) => {
    const parsed = new URL(url);
    this.requests.push({
      method: init.method,
      path: `${parsed.pathname}${parsed.search}`,
      body: init.body ?? '',
      headers: init.headers,
    });
    const failure = this.failures.shift();
    if (failure !== undefined) {
      if ('throws' in failure) {
        throw failure.throws;
      }
      return this.reply(failure.status, failure.body);
    }
    const bucket = parsed.searchParams.get('bucket');
    if (parsed.pathname === '/api/v2/write') {
      if (bucket === null || !this.buckets.has(bucket)) {
        return this.reply(
          404,
          JSON.stringify({
            code: 'not found',
            message: `bucket "${bucket ?? ''}" not found`,
          })
        );
      }
      if (this.retention) {
        return this.reply(
          422,
          JSON.stringify({
            code: 'unprocessable entity',
            message:
              'failure writing points to database: partial write: points beyond retention policy dropped=1',
          })
        );
      }
      const answer = this.write(init.body ?? '');
      if (this.writeLatencyMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.writeLatencyMs)
        );
      }
      return answer;
    }
    if (parsed.pathname === '/api/v2/delete') {
      if (bucket === null || !this.buckets.has(bucket)) {
        return this.reply(
          404,
          JSON.stringify({
            code: 'not found',
            message: `bucket "${bucket ?? ''}" not found`,
          })
        );
      }
      return this.remove(init.body ?? '');
    }
    if (parsed.pathname === '/api/v2/query') {
      return this.query(init.body ?? '');
    }
    return this.reply(404, '404 page not found');
  };

  private reply(
    status: number,
    text: string
  ): Awaited<ReturnType<InfluxDbFetch>> {
    return {
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(text),
    };
  }

  private write(body: string): Awaited<ReturnType<InfluxDbFetch>> {
    for (const line of body.split('\n').filter((text) => text !== '')) {
      const { head, fieldText } = splitLine(line);
      const [measurement = '', ...tagParts] = splitUnescaped(head, ',');
      const tags = new Map<string, string>();
      for (const part of tagParts) {
        const [name = '', ...rest] = splitUnescaped(part, '=');
        tags.set(name, unescapeTag(rest.join('=')));
      }
      const key = tags.get('entry_key') ?? '';
      tags.delete('entry_key');
      const fields = new Map<string, string>();
      // Read `name="text"` and `name=123i` pairs by hand: a regex chokes on megabyte values.
      let cursor = 0;
      while (cursor < fieldText.length) {
        const equals = fieldText.indexOf('=', cursor);
        const name = fieldText.slice(cursor, equals);
        let text = '';
        if (fieldText.charAt(equals + 1) === '"') {
          cursor = equals + 2;
          while (fieldText.charAt(cursor) !== '"') {
            if (fieldText.charAt(cursor) === '\\') {
              cursor += 1;
            }
            text += fieldText.charAt(cursor);
            cursor += 1;
          }
          cursor += 1;
        } else {
          const end = fieldText.indexOf(',', equals);
          const stop = end < 0 ? fieldText.length : end;
          text = fieldText.slice(equals + 1, stop).replace(/i$/, '');
          cursor = stop;
        }
        fields.set(name, text);
        cursor += 1; // the comma
      }
      this.beforeWrite?.(measurement, key);
      const points = this.pointsFor(measurement);
      const existing = points.get(key);
      const same =
        existing !== undefined &&
        JSON.stringify(existing.extraTags) ===
          JSON.stringify(Object.fromEntries(tags));
      const point: FakePoint = same
        ? existing
        : {
            value: null,
            revision: null,
            updatedAt: null,
            extraTags: Object.fromEntries(tags),
          };
      if (fields.has('value')) point.value = fields.get('value') ?? '';
      if (fields.has('revision')) point.revision = fields.get('revision') ?? '';
      if (fields.has('updated_at'))
        point.updatedAt = fields.get('updated_at') ?? '';
      points.set(key, point);
    }
    return this.reply(204, '');
  }

  private remove(body: string): Awaited<ReturnType<InfluxDbFetch>> {
    const request = JSON.parse(body) as { predicate: string };
    const measurement = readFluxString(
      request.predicate,
      request.predicate.indexOf('"')
    );
    const keyStart = request.predicate.indexOf('"', measurement.end + 1);
    const key = readFluxString(request.predicate, keyStart);
    this.measurements.get(measurement.value)?.delete(key.value);
    return this.reply(204, '');
  }

  private query(script: string): Awaited<ReturnType<InfluxDbFetch>> {
    const bucketAt = script.indexOf('from(bucket: ');
    const bucket = readFluxString(script, bucketAt + 'from(bucket: '.length);
    if (!this.buckets.has(bucket.value)) {
      return this.reply(
        404,
        JSON.stringify({
          code: 'not found',
          message: `failed to initialize execute state: could not find bucket "${bucket.value}"`,
        })
      );
    }
    const measurementAt = script.indexOf('r._measurement == ');
    const measurement = readFluxString(
      script,
      measurementAt + 'r._measurement == '.length
    );
    const points =
      this.measurements.get(measurement.value) ?? new Map<string, FakePoint>();
    let selected: [string, FakePoint][];
    const exact = script.indexOf('r.entry_key == ');
    const contains = script.indexOf('contains(value: r.entry_key, set: [');
    if (exact >= 0) {
      const wanted = readFluxString(
        script,
        exact + 'r.entry_key == '.length
      ).value;
      selected = [...points].filter(([key]) => key === wanted);
    } else if (contains >= 0) {
      const wanted = new Set<string>();
      let cursor = contains + 'contains(value: r.entry_key, set: ['.length;
      while (script.charAt(cursor) === '"') {
        const part = readFluxString(script, cursor);
        wanted.add(part.value);
        cursor = part.end + 2;
      }
      selected = [...points].filter(([key]) => wanted.has(key));
    } else {
      const prefixAt = script.indexOf('prefix: ');
      const prefix =
        prefixAt >= 0
          ? readFluxString(script, prefixAt + 'prefix: '.length).value
          : '';
      const listed = [...points].filter(
        ([key, point]) => point.revision !== null && key.startsWith(prefix)
      );
      if (listed.length === 0) {
        return this.reply(200, '\r\n');
      }
      const lines = [
        '#datatype,string,long,string',
        '#group,false,false,false',
        '#default,_result,,',
        ',result,table,entry_key',
      ];
      for (const [key] of listed) {
        lines.push(`,,0,${csvCell(key)}`);
      }
      return this.reply(200, `${lines.join('\r\n')}\r\n\r\n`);
    }
    if (selected.length === 0) {
      return this.reply(200, '\r\n');
    }
    const tables: string[] = [];
    for (const [key, point] of selected) {
      const fields: [string, string][] = [];
      if (point.revision !== null) fields.push(['revision', point.revision]);
      if (point.updatedAt !== null)
        fields.push(['updated_at', point.updatedAt]);
      if (point.value !== null) fields.push(['value', point.value]);
      const tags = Object.entries(point.extraTags);
      tables.push(
        [
          '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,string,string',
          '#group,false,false,false,true,true,true,true',
          '#default,_result,,,,,,',
          [
            '',
            'result',
            'table',
            '_time',
            '_start',
            '_stop',
            '_measurement',
            'entry_key',
            ...tags.map(([name]) => name),
            ...fields.map(([name]) => name),
          ].join(','),
          [
            '',
            '',
            '0',
            START,
            START,
            '1970-01-01T00:00:01Z',
            measurement.value,
            csvCell(key),
            ...tags.map(([, value]) => csvCell(value)),
            ...fields.map(([, value]) => csvCell(value)),
          ].join(','),
        ].join('\r\n')
      );
    }
    return this.reply(200, `${tables.join('\r\n\r\n')}\r\n\r\n`);
  }
}
