import { Pool } from "pg";
import type { FieldDef, PoolClient, PoolConfig } from "pg";
import type { PoolSettings } from "../../config.ts";
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  ledger BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  event_index TEXT NOT NULL,
  topics TEXT NOT NULL,
  data TEXT NOT NULL,
  close_time BIGINT
);
CREATE INDEX IF NOT EXISTS events_ledger ON events(ledger, event_id);
CREATE INDEX IF NOT EXISTS events_contract_ledger ON events(contract_id, ledger, event_id);
CREATE TABLE IF NOT EXISTS cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_ledger BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id BIGINT PRIMARY KEY,
  merchant TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  period BIGINT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  ledger BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_merchant ON plans(merchant);
CREATE TABLE IF NOT EXISTS mandates (
  id BIGINT PRIMARY KEY,
  subscriber TEXT NOT NULL,
  merchant TEXT NOT NULL,
  plan_id BIGINT NOT NULL,
  amount TEXT NOT NULL,
  period BIGINT NOT NULL,
  next_charge BIGINT NOT NULL,
  last_charge BIGINT NOT NULL DEFAULT 0,
  charges_made BIGINT NOT NULL DEFAULT 0,
  max_charges BIGINT NOT NULL DEFAULT 0,
  fee_bps INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Active',
  ended_by TEXT,
  ledger BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mandates_subscriber ON mandates(subscriber);
CREATE INDEX IF NOT EXISTS mandates_merchant ON mandates(merchant);
CREATE INDEX IF NOT EXISTS mandates_due ON mandates(status, next_charge);
CREATE INDEX IF NOT EXISTS mandates_merchant_status_period_amount
  ON mandates(merchant, status, period, amount);
CREATE TABLE IF NOT EXISTS plan_active_subscribers (
  plan_id BIGINT NOT NULL,
  subscriber TEXT NOT NULL,
  mandate_count BIGINT NOT NULL,
  PRIMARY KEY (plan_id, subscriber)
);
CREATE TABLE IF NOT EXISTS plan_subscriber_counts (
  plan_id BIGINT PRIMARY KEY,
  active_subscribers BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS charges (
  tx_hash TEXT NOT NULL,
  mandate_id BIGINT NOT NULL,
  subscriber TEXT NOT NULL,
  merchant TEXT NOT NULL,
  amount TEXT NOT NULL,
  fee TEXT NOT NULL,
  charges_made BIGINT NOT NULL,
  next_charge BIGINT NOT NULL,
  ledger BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tx_hash, mandate_id)
);
CREATE INDEX IF NOT EXISTS charges_merchant ON charges(merchant);
CREATE INDEX IF NOT EXISTS charges_merchant_created_at ON charges(merchant, created_at);
CREATE INDEX IF NOT EXISTS charges_subscriber ON charges(subscriber);
CREATE INDEX IF NOT EXISTS charges_mandate ON charges(mandate_id);
CREATE INDEX IF NOT EXISTS charges_merchant_amount ON charges(merchant, amount);
CREATE INDEX IF NOT EXISTS charges_subscriber_amount_fee ON charges(subscriber, amount, fee);
CREATE TABLE IF NOT EXISTS vault_events (
  tx_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  "user" TEXT NOT NULL,
  token TEXT NOT NULL,
  counterparty TEXT,
  amount TEXT NOT NULL,
  balance TEXT NOT NULL,
  ledger BIGINT NOT NULL,
  PRIMARY KEY (tx_hash, kind, "user", amount)
);
CREATE INDEX IF NOT EXISTS vault_events_user ON vault_events("user");
CREATE INDEX IF NOT EXISTS vault_events_user_token_ledger ON vault_events("user", token, ledger DESC);
CREATE INDEX IF NOT EXISTS vault_events_user_ledger ON vault_events("user", ledger DESC);
CREATE TABLE IF NOT EXISTS fee_history (
  tx_hash TEXT PRIMARY KEY,
  old_fee_bps INTEGER NOT NULL,
  new_fee_bps INTEGER NOT NULL,
  ledger BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS fee_history_ledger ON fee_history(ledger DESC);
CREATE TABLE IF NOT EXISTS mandate_events (
  mandate_id BIGINT NOT NULL,
  slot TEXT NOT NULL,
  merchant TEXT NOT NULL,
  kind TEXT NOT NULL,
  at BIGINT NOT NULL,
  ledger BIGINT NOT NULL,
  PRIMARY KEY (mandate_id, slot)
);
CREATE INDEX IF NOT EXISTS mandate_events_merchant ON mandate_events(merchant, kind, at);
CREATE TABLE IF NOT EXISTS mandate_timeline (
  mandate_id BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  ledger BIGINT NOT NULL,
  at BIGINT,
  details TEXT NOT NULL,
  PRIMARY KEY (mandate_id, tx_hash, kind)
);
CREATE INDEX IF NOT EXISTS mandate_timeline_order ON mandate_timeline(mandate_id, ledger, tx_hash, kind);
CREATE TABLE IF NOT EXISTS merchant_profiles (
  merchant TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  ledger BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS merchant_notification_preferences (
  merchant TEXT PRIMARY KEY,
  events TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS contract_upgrades (
  contract_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  ledger BIGINT NOT NULL,
  close_time BIGINT NOT NULL,
  new_hash TEXT NOT NULL,
  old_hash TEXT,
  PRIMARY KEY (contract_id, tx_hash)
);
CREATE INDEX IF NOT EXISTS contract_upgrades_contract ON contract_upgrades(contract_id, ledger DESC);
CREATE INDEX IF NOT EXISTS contract_upgrades_ledger ON contract_upgrades(ledger DESC);
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  merchant TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  previous_secret TEXT,
  previous_secret_expires_at BIGINT,
  active INTEGER NOT NULL DEFAULT 1,
  failed INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  last_attempt BIGINT,
  last_status INTEGER,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_merchant ON webhooks(merchant);
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS previous_secret TEXT;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS previous_secret_expires_at BIGINT;
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  webhook_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  response_body TEXT,
  error TEXT,
  payload TEXT NOT NULL,
  retry_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, retry_at);
CREATE TABLE IF NOT EXISTS webhook_event_receipts (
  webhook_id INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  PRIMARY KEY (webhook_id, event_key)
);
INSERT INTO webhook_event_receipts (webhook_id, event_key)
  SELECT webhook_id,
         CASE WHEN payload::jsonb ->> 'event' = 'charged'
              THEN event_id || ':' || (payload::jsonb ->> 'mandate_id')
              ELSE event_id END
    FROM webhook_deliveries
   WHERE NOT EXISTS (SELECT 1 FROM webhook_event_receipts)
  ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS webhook_attempts (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  webhook_id INTEGER NOT NULL,
  delivery_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  error TEXT,
  next_retry_at BIGINT,
  attempted_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_attempts_webhook ON webhook_attempts(webhook_id, id);

-- One row per keeper charge attempt (#144): when it ran, how it ended
-- ('settled', 'failed', or 'skipped' when the vault could not cover the
-- charge), the error code and the transaction hash.
CREATE TABLE IF NOT EXISTS charge_attempts (
  id           INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  mandate_id   BIGINT NOT NULL,
  attempted_at BIGINT NOT NULL,   -- unix seconds
  result       TEXT    NOT NULL,   -- 'settled' | 'failed' | 'skipped'
  error_code   TEXT,
  tx_hash      TEXT,
  -- What the vault was missing, for a 'skipped' attempt: a decimal string in
  -- the token's smallest unit.
  shortfall    TEXT,
  failures     INTEGER NOT NULL,
  retry_at     BIGINT
);
CREATE INDEX IF NOT EXISTS charge_attempts_mandate ON charge_attempts(mandate_id, id);
CREATE INDEX IF NOT EXISTS charge_attempts_attempted_at ON charge_attempts(attempted_at);

-- Settlement claims (#249): one row per due charge a keeper instance is
-- settling, taken with a single atomic upsert so two keepers never settle
-- the same charge. See the SQLite schema in src/lib/db.ts.
CREATE TABLE IF NOT EXISTS keeper_claims (
  mandate_id BIGINT NOT NULL,
  due_at     BIGINT NOT NULL,
  owner      TEXT   NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (mandate_id, due_at)
);
CREATE INDEX IF NOT EXISTS keeper_claims_expires_at ON keeper_claims(expires_at);
`;

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
    return work(this);
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
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    } finally {
      await bootstrap.end();
    }

    const pool = new Pool(poolConfigFor(connectionString, schema, settings));
    const storage = new PostgresStorage(pool, undefined, settings);
    await storage.run(SCHEMA);
    await storage.run(`
      INSERT INTO plan_active_subscribers (plan_id, subscriber, mandate_count)
      SELECT plan_id, subscriber, COUNT(*) FROM mandates
       WHERE status = 'Active' GROUP BY plan_id, subscriber
      ON CONFLICT (plan_id, subscriber) DO NOTHING
    `);
    await storage.run(`
      INSERT INTO plan_subscriber_counts (plan_id, active_subscribers)
      SELECT plan_id, COUNT(*) FROM plan_active_subscribers GROUP BY plan_id
      ON CONFLICT (plan_id) DO NOTHING
    `);
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
      await client.query("BEGIN");
      const result = await work(new PgExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  override async close(): Promise<void> {
    await this.pool.end();
  }
}
