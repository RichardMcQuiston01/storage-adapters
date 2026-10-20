/**
 * An in-memory stand-in for a Neo4j driver, with the behaviour the adapter relies on
 * (checked against a real Neo4j 5.26 server): integers come back as objects that print
 * as digits, `CREATE` on a taken key fails on the uniqueness constraint, a `MATCH` that
 * finds nothing returns no rows, and an upsert of a node whose revision is not a whole
 * number returns no rows. Statements are recognised by their text.
 * test/neo4j-server.test.ts runs the adapter against a real server.
 */
import type {
  Neo4jDriverLike,
  Neo4jRecordLike,
  Neo4jResultLike,
  Neo4jSessionConfig,
  Neo4jSessionLike,
} from '../../src/neo4j/index.js';

/** Prints as digits, like the `Integer` the real driver returns. */
class FakeInteger {
  constructor(readonly value: number) {}
  toString(): string {
    return String(this.value);
  }
}

interface FakeNode {
  value: string | null;
  /** A number, or anything else a stranger might have stored. */
  revision: number | string | null;
}

/** An error shaped like the driver's `Neo4jError`. */
export class FakeNeo4jError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

export interface FakeSession {
  readonly config: Neo4jSessionConfig;
  closed: boolean;
}

export class FakeNeo4j implements Neo4jDriverLike {
  /** Nodes by label, then key. */
  readonly labels = new Map<string, Map<string, FakeNode>>();
  readonly constraints = new Set<string>();
  readonly statements: { query: string; mode: string }[] = [];
  readonly sessions: FakeSession[] = [];
  /** Errors to throw from the next statements, in order. */
  readonly failures: Error[] = [];
  /** Runs just before a write is applied, to simulate another writer. */
  beforeWrite: ((label: string, key: string) => void) | null = null;
  /** When false, revisions come back as plain numbers instead of `Integer`-like objects. */
  integerObjects = true;
  /** Milliseconds a write's answer takes to come back, so polls and writes can overlap. */
  writeLatencyMs = 0;

  constructor(labels: readonly string[] = []) {
    for (const name of labels) {
      this.labels.set(name, new Map());
    }
  }

  /** Writes behind the adapter's back, as another process would. */
  put(
    label: string,
    key: string,
    value: string | null,
    revision: number | string | null
  ): void {
    const nodes = this.labels.get(label) ?? new Map<string, FakeNode>();
    this.labels.set(label, nodes);
    nodes.set(key, { value, revision });
  }

  /** Removes a node behind the adapter's back. */
  delete(label: string, key: string): void {
    this.labels.get(label)?.delete(key);
  }

  session(config: Neo4jSessionConfig): Neo4jSessionLike {
    const record: FakeSession = { config, closed: false };
    this.sessions.push(record);
    return {
      run: (query, parameters) => this.execute(query, parameters ?? {}, config),
      close: () => {
        record.closed = true;
        return Promise.resolve();
      },
    };
  }

  private cell(revision: number | string | null): unknown {
    if (typeof revision === 'number' && this.integerObjects) {
      return new FakeInteger(revision);
    }
    return revision;
  }

  private nodesFor(label: string): Map<string, FakeNode> {
    const nodes = this.labels.get(label) ?? new Map<string, FakeNode>();
    this.labels.set(label, nodes);
    return nodes;
  }

  private async execute(
    query: string,
    params: Record<string, unknown>,
    config: Neo4jSessionConfig
  ): Promise<Neo4jResultLike> {
    this.statements.push({ query, mode: config.defaultAccessMode });
    const failure: Error | undefined = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    const database: unknown = config.database;
    if (typeof database === 'string' && database !== 'neo4j') {
      throw new FakeNeo4jError(
        `Graph not found: ${database}`,
        'Neo.ClientError.Database.DatabaseNotFound'
      );
    }
    const records = this.run(query, params);
    // The statement has taken effect; the answer takes a while to come back.
    if (this.writeLatencyMs > 0 && config.defaultAccessMode === 'WRITE') {
      await new Promise((resolve) => setTimeout(resolve, this.writeLatencyMs));
    }
    return { records };
  }

  private run(
    query: string,
    params: Record<string, unknown>
  ): Neo4jRecordLike[] {
    const text = query.replace(/\s+/g, ' ').trim();
    const row = (values: Record<string, unknown>): Neo4jRecordLike => ({
      get: (name) => values[name] ?? null,
    });
    const key = String(params.key);
    const constraint =
      /^CREATE CONSTRAINT (\S+) IF NOT EXISTS FOR \(n:(\S+)\)/.exec(text);
    if (constraint !== null) {
      this.constraints.add(constraint[1] ?? '');
      this.nodesFor(constraint[2] ?? '');
      return [];
    }
    const select =
      /^MATCH \(n:(\S+) \{key: \$key\}\) RETURN n\.value AS value, n\.revision AS revision$/.exec(
        text
      );
    if (select !== null) {
      const node = this.nodesFor(select[1] ?? '').get(key);
      return node === undefined
        ? []
        : [row({ value: node.value, revision: this.cell(node.revision) })];
    }
    const create = /^CREATE \(n:(\S+) \{key: \$key, value: \$value/.exec(text);
    if (create !== null) {
      const label = create[1] ?? '';
      const nodes = this.nodesFor(label);
      this.beforeWrite?.(label, key);
      if (nodes.has(key)) {
        throw new FakeNeo4jError(
          `Node(1) already exists with label \`${label}\` and property \`key\` = '${key}'`,
          'Neo.ClientError.Schema.ConstraintValidationFailed'
        );
      }
      nodes.set(key, { value: String(params.value), revision: 1 });
      return [row({ revision: this.cell(1) })];
    }
    const upsert = /^MERGE \(n:(\S+) \{key: \$key\}\)/.exec(text);
    if (upsert !== null) {
      const label = upsert[1] ?? '';
      const nodes = this.nodesFor(label);
      this.beforeWrite?.(label, key);
      const node = nodes.get(key);
      if (node === undefined) {
        nodes.set(key, { value: String(params.value), revision: 1 });
        return [row({ revision: this.cell(1) })];
      }
      if (typeof node.revision !== 'number') {
        return [];
      }
      node.value = String(params.value);
      node.revision += 1;
      return [row({ revision: this.cell(node.revision) })];
    }
    const compare =
      /^MATCH \(n:(\S+) \{key: \$key\}\) SET n\.lock_ = true/.exec(text);
    if (compare !== null) {
      const label = compare[1] ?? '';
      const nodes = this.nodesFor(label);
      this.beforeWrite?.(label, key);
      const node = nodes.get(key);
      if (node === undefined) {
        return [];
      }
      const matched: boolean =
        typeof node.revision === 'number' &&
        node.revision === Number(String(params.expected));
      const found = this.cell(node.revision);
      if (matched && typeof node.revision === 'number') {
        node.value = String(params.value);
        node.revision += 1;
      }
      return [row({ revision: found, applied: matched })];
    }
    const remove = /^MATCH \(n:(\S+) \{key: \$key\}\) DETACH DELETE n$/.exec(
      text
    );
    if (remove !== null) {
      this.nodesFor(remove[1] ?? '').delete(key);
      return [];
    }
    const list =
      /^MATCH \(n:(\S+)\) WHERE n\.key STARTS WITH \$prefix RETURN n\.key AS key$/.exec(
        text
      );
    if (list !== null) {
      const prefix = String(params.prefix);
      return [...this.nodesFor(list[1] ?? '').keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => row({ key: name }));
    }
    const many =
      /^MATCH \(n:(\S+)\) WHERE n\.key IN \$keys RETURN n\.key AS key, n\.value AS value, n\.revision AS revision$/.exec(
        text
      );
    if (many !== null) {
      const wanted = new Set(params.keys as string[]);
      return [...this.nodesFor(many[1] ?? '').entries()]
        .filter(([name]) => wanted.has(name))
        .map(([name, node]) =>
          row({
            key: name,
            value: node.value,
            revision: this.cell(node.revision),
          })
        );
    }
    throw new FakeNeo4jError(
      `the fake does not understand: ${text}`,
      'Neo.ClientError.Statement.SyntaxError'
    );
  }
}
