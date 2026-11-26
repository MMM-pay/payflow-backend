/**
 * Centralised PostgreSQL schema and store-level SQL queries (#268).
 */

export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  ledger BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  event_index TEXT NOT NULL,
  topics TEXT NOT NULL,
  data TEXT NOT NULL,
  close_time BIGINT,
  projected INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE events ADD COLUMN IF NOT EXISTS projected INTEGER NOT NULL DEFAULT 0;
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
  ledger BIGINT NOT NULL,
  payout_address TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0,
  deleted_at BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS payout_address TEXT NOT NULL DEFAULT '';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS deleted_at BIGINT NOT NULL DEFAULT 0;
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
  ledger BIGINT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0,
  deleted_at BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS deleted_at BIGINT NOT NULL DEFAULT 0;
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
  token TEXT NOT NULL DEFAULT 'native',
  updated_at BIGINT NOT NULL DEFAULT 0,
  deleted_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tx_hash, mandate_id)
);
ALTER TABLE charges ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'native';
ALTER TABLE charges ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE charges ADD COLUMN IF NOT EXISTS deleted_at BIGINT NOT NULL DEFAULT 0;
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
CREATE TABLE IF NOT EXISTS plan_payout_addresses (
  plan_id BIGINT NOT NULL,
  payout_address TEXT NOT NULL,
  ledger BIGINT NOT NULL,
  changed_at BIGINT NOT NULL,
  PRIMARY KEY (plan_id, payout_address)
);
CREATE INDEX IF NOT EXISTS plan_payout_addresses_plan ON plan_payout_addresses(plan_id);
CREATE TABLE IF NOT EXISTS merchant_notification_preferences (
  merchant TEXT PRIMARY KEY,
  events TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS refresh_tokens_account ON refresh_tokens(account);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires ON refresh_tokens(expires_at);
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
  circuit_open_until BIGINT,
  circuit_half_open INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_merchant ON webhooks(merchant);
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS previous_secret TEXT;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS previous_secret_expires_at BIGINT;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS circuit_open_until BIGINT;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS circuit_half_open INTEGER NOT NULL DEFAULT 0;
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

-- listMandates merchant+status paging: (merchant, status, id) lets the planner
-- seek both equality predicates and the cursor (id < ?) without re-checking
-- status from the table on each row.
CREATE INDEX IF NOT EXISTS mandates_merchant_status_id ON mandates(merchant, status, id);

-- getProtocolStats COUNT(DISTINCT merchant) WHERE status = 'Active': covering
-- (status, merchant) index lets the planner read merchant from the index
-- without a table visit or a temp B-tree to deduplicate.
CREATE INDEX IF NOT EXISTS mandates_status_merchant ON mandates(status, merchant);

-- listMandateCharges ORDER BY ledger DESC: (mandate_id, ledger DESC, tx_hash)
-- serves the mandate_id equality and delivers rows in ledger+tx_hash order,
-- eliminating the temp B-tree the existing charges_mandate_created_at index
-- triggers for this sort.
CREATE INDEX IF NOT EXISTS charges_mandate_ledger ON charges(mandate_id, ledger DESC, tx_hash);

-- getSubscriberExport charges ORDER BY ledger ASC, tx_hash ASC: the existing
-- charges_subscriber_created_at index (subscriber, created_at) serves the
-- lookup but not the sort, so a temp B-tree is needed.  (subscriber, ledger,
-- tx_hash) covers both.
CREATE INDEX IF NOT EXISTS charges_subscriber_ledger ON charges(subscriber, ledger, tx_hash);
`;

export const POSTGRES_QUERIES = {
  createSchema: (schema: string): string => `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
  hasWebhookResponseRedactionMigration: "SELECT version FROM schema_migrations WHERE version = 1",
  redactWebhookResponses:
    "UPDATE webhook_deliveries SET response_body = NULL WHERE response_body IS NOT NULL",
  recordWebhookResponseRedactionMigration:
    "INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING",
  hasEventProjectionMigration: "SELECT version FROM schema_migrations WHERE version = 2",
  markEventsProjected: "UPDATE events SET projected = 1",
  recordEventProjectionMigration:
    "INSERT INTO schema_migrations (version) VALUES (2) ON CONFLICT DO NOTHING",
  backfillPlanActiveSubscribers: `
      INSERT INTO plan_active_subscribers (plan_id, subscriber, mandate_count)
      SELECT plan_id, subscriber, COUNT(*) FROM mandates
       WHERE status = 'Active' GROUP BY plan_id, subscriber
      ON CONFLICT (plan_id, subscriber) DO NOTHING
    `,
  backfillPlanSubscriberCounts: `
      INSERT INTO plan_subscriber_counts (plan_id, active_subscribers)
      SELECT plan_id, COUNT(*) FROM plan_active_subscribers GROUP BY plan_id
      ON CONFLICT (plan_id) DO NOTHING
    `,
  beginTransaction: "BEGIN",
  commitTransaction: "COMMIT",
  rollbackTransaction: "ROLLBACK",
} as const;
