import { Pool } from "pg";
import type { FieldDef, PoolClient, PoolConfig } from "pg";
import type { PoolSettings } from "../../config.ts";
import { POSTGRES_QUERIES, POSTGRES_SCHEMA } from "./postgres.queries.ts";
import type { SqlParameters, Storage } from "./types.ts";

/**
 * The size and timeouts applied to a network's pool (#263).
 *
 * `connectionTimeoutMillis` bounds the checkout itself, whether the pool has
 * to open a new connection or hand over an idle one and park the caller in
 * its queue, so a saturated pool fails a request instead of queueing it
 * forever. `statement_timeout` is sent in the startup packet, so PostgreSQL
 * cancels a runaway statement server-side rather than letting it pin a
 * connection until the client gives up.
 */
export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  max: 10,
  acquireTimeoutMs: 10_000,
  statementTimeoutMs: 30_000,
};

/** The `pg` pool options for one network's schema. */
export function poolConfigFor(
  connectionString: string,
  schema: string,
  settings: PoolSettings = DEFAULT_POOL_SETTINGS,
): PoolConfig {
  return {
    connectionString,
    max: settings.max,
    connectionTimeoutMillis: settings.acquireTimeoutMs,
    // Retire an idle connection after 30 s, so a restarted server or a
    // tightened max_connections does not leave dead sockets in the pool.
    idleTimeoutMillis: 30_000,
    statement_timeout: settings.statementTimeoutMs,
    options: `-c search_path=${schema}`,
  };
}

/** The `pg` message for a checkout that ran out of time; named in the config. */
const CHECKOUT_TIMEOUT = /timeout exceeded when trying to connect/;

/** Restate a pool checkout timeout in the terms the operator configured (#263). */
export function explainCheckoutTimeout(err: unknown, settings: PoolSettings): unknown {
  if (!(err instanceof Error) || !CHECKOUT_TIMEOUT.test(err.message)) return err;
  return new Error(
    `timed out after ${settings.acquireTimeoutMs} ms waiting for a database connection ` +
      `(DATABASE_ACQUIRE_TIMEOUT_MS); the pool holds at most ${settings.max} (DATABASE_POOL_MAX)`,
    { cause: err },
  );
}

const schemaName = /^[a-z_][a-z0-9_]*$/;

function normalizeRows<Row extends Record<string, unknown>>(
  rows: Row[],
  fields: readonly FieldDef[],
): Row[] {
  const integerColumns = fields.filter((field) => field.dataTypeID === 20).map((field) => field.name);
  return rows.map((row) => {
    const normalized: Record<string, unknown> = { ...row };
    for (const column of integerColumns) {
      const value = normalized[column];
      if (typeof value === "string") normalized[column] = Number(value);
    }
    return normalized as Row;
  });
}

function postgresSql(sql: string): string {
  const ignored = /^([\s\S]*?)\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.exec(sql);
  let result = ignored ? `${ignored[1]}INSERT INTO${sql.slice(ignored[0].length)}` : sql;
  let parameterIndex = 0;
  result = result.replace(/\?/g, () => `$${++parameterIndex}`);
  result = result.replace(/\bCAST\(([^()]*)\s+AS\s+INTEGER\)/gi, "CAST($1 AS BIGINT)");
  result = result.replace(/\bMAX\(0,\s*([^()]*)\)/gi, "GREATEST(0, $1)");
  if (ignored && !/\bON\s+CONFLICT\b/i.test(result)) result = `${result.trimEnd()} ON CONFLICT DO NOTHING`;
  return result;
}

function sqlFor(sql: string): string {
  return postgresSql(sql);
}

class PgExecutor implements Storage {
  readonly dialect = "postgres" as const;
  private readonly client: Pool | PoolClient;

  constructor(client: Pool | PoolClient) {
    this.client = client;
  }

  async all<Row>(sql: string, parameters: SqlParameters = []): Promise<Row[]> {
    const result = await this.client.query(sqlFor(sql), [...parameters]);
    return normalizeRows(result.rows, result.fields) as Row[];
  }

  async get<Row>(sql: string, parameters: SqlParameters = []): Promise<Row | undefined> {
    const result = await this.client.query(sqlFor(sql), [...parameters]);
    return normalizeRows(result.rows, result.fields)[0] as Row | undefined;
  }

  async run(sql: string, parameters: SqlParameters = []): Promise<void> {
    await this.client.query(sqlFor(sql), [...parameters]);
  }

  async transaction<Result>(work: (storage: Storage) => Promise<Result>): Promise<Result> {
    const releaseClient = this.client instanceof Pool;
    const client = releaseClient ? await this.client.connect() : this.client;
    try {
      await client.query("BEGIN");
      const result = await work(new PgExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Database transaction failed and rollback also failed",
          { cause: rollbackError },
        );
      }
      throw error;
    } finally {
      if (releaseClient) client.release();
    }
  }

  async close(): Promise<void> {}
}

/** PostgreSQL implementation of the shared async storage boundary. */
export class PostgresStorage extends PgExecutor implements Storage {
  private readonly pool: Pool;
  private readonly settings: PoolSettings;

  private constructor(pool: Pool, client: Pool | PoolClient = pool, settings: PoolSettings = DEFAULT_POOL_SETTINGS) {
    super(client);
    this.pool = pool;
    this.settings = settings;
  }

  static async open(
    connectionString: string,
    networkName: string,
    settings: PoolSettings = DEFAULT_POOL_SETTINGS,
  ): Promise<PostgresStorage> {
    const schema = `payflow_${networkName.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
    if (!schemaName.test(schema)) throw new Error("Invalid PostgreSQL schema name");

    // The bootstrap pool creates the schema and exits; one connection and the
    // same acquire timeout keep a server that is up but out of slots from
    // hanging startup instead of failing it.
    const bootstrap = new Pool(
      poolConfigFor(connectionString, schema, { ...settings, max: 1 }),
    );
    try {
      await bootstrap.query(POSTGRES_QUERIES.createSchema(schema));
    } finally {
      await bootstrap.end();
    }

    const pool = new Pool(poolConfigFor(connectionString, schema, settings));
    const storage = new PostgresStorage(pool, undefined, settings);
    await storage.run(POSTGRES_SCHEMA);
    const webhookResponseRedaction = await storage.get<{ version: number }>(
      POSTGRES_QUERIES.hasWebhookResponseRedactionMigration,
    );
    if (!webhookResponseRedaction) {
      await storage.run(POSTGRES_QUERIES.redactWebhookResponses);
      await storage.run(POSTGRES_QUERIES.recordWebhookResponseRedactionMigration);
    }
    const eventProjectionMigration = await storage.get<{ version: number }>(
      POSTGRES_QUERIES.hasEventProjectionMigration,
    );
    if (!eventProjectionMigration) {
      await storage.run(POSTGRES_QUERIES.markEventsProjected);
      await storage.run(POSTGRES_QUERIES.recordEventProjectionMigration);
    }
    await storage.run(POSTGRES_QUERIES.backfillPlanActiveSubscribers);
    await storage.run(POSTGRES_QUERIES.backfillPlanSubscriberCounts);
    return storage;
  }

  /**
   * Run `work`, naming the acquire timeout when the pool had no connection to
   * give. Queries check a connection out of the pool on their own, so every
   * entry point needs this, not just {@link transaction}.
   */
  private async checked<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (err) {
      throw explainCheckoutTimeout(err, this.settings);
    }
  }

  override all<Row>(sql: string, parameters: SqlParameters = []): Promise<Row[]> {
    return this.checked(() => super.all<Row>(sql, parameters));
  }

  override get<Row>(sql: string, parameters: SqlParameters = []): Promise<Row | undefined> {
    return this.checked(() => super.get<Row>(sql, parameters));
  }

  override run(sql: string, parameters: SqlParameters = []): Promise<void> {
    return this.checked(() => super.run(sql, parameters));
  }

  override async transaction<Result>(work: (storage: Storage) => Promise<Result>): Promise<Result> {
    const client = await this.checked(() => this.pool.connect());
    try {
      await client.query(POSTGRES_QUERIES.beginTransaction);
      const result = await work(new PgExecutor(client));
      await client.query(POSTGRES_QUERIES.commitTransaction);
      return result;
    } catch (err) {
      await client.query(POSTGRES_QUERIES.rollbackTransaction);
      throw err;
    } finally {
      client.release();
    }
  }

  override async close(): Promise<void> {
    await this.pool.end();
  }
}
