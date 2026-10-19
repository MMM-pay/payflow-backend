import type { DatabaseSync } from "node:sqlite";
import { readCursor } from "./db.ts";
import {
  BUCKET_SQL,
  bucketLabel,
  bucketStart,
  nextBucketStart,
} from "./churn.ts";
import { SECONDS_PER_MONTH, SECONDS_PER_YEAR } from "../routes/helpers.ts";
import type {
  ChargeRow,
  ChurnBucket,
  ChurnBucketSize,
  DueMandateRow,
  ProtocolResponse,
  MandateRow,
  MerchantChurnResponse,
  MerchantSummary,
  PlanRow,
  StatsResponse,
  SubscriberSummary,
  TokenRevenue,
  VaultBalancePage,
  VaultEventPage,
} from "../routes/types.ts";

export interface ListPlansFilter {
  merchant?: string | undefined;
  limit: number;
}

export interface ListMandatesFilter {
  ids?: number[] | undefined;
  subscriber?: string | undefined;
  merchant?: string | undefined;
  status?: string | undefined;
  limit: number;
}

export interface ForecastMandateRow {
  amount: string;
  period: number;
  next_charge: number;
  charges_made: number;
  max_charges: number;
  fee_bps: number;
}

export interface UpcomingMandateRow {
  id: number;
  merchant: string;
  amount: string;
  period: number;
  next_charge: number;
  charges_made: number;
  max_charges: number;
}

/** List plans ordered newest-first, optionally filtered by merchant. */
export function listPlans(db: DatabaseSync, filter: ListPlansFilter): PlanRow[] {
  const rows = filter.merchant
    ? db
        .prepare("SELECT * FROM plans WHERE merchant = ? ORDER BY id DESC LIMIT ?")
        .all(filter.merchant, filter.limit)
    : db
        .prepare("SELECT * FROM plans ORDER BY id DESC LIMIT ?")
        .all(filter.limit);
  return rows as unknown as PlanRow[];
}

/** Look up a single plan by on-chain id. */
export function getPlanById(db: DatabaseSync, id: number): PlanRow | undefined {
  return db
    .prepare("SELECT * FROM plans WHERE id = ?")
    .get(id) as unknown as PlanRow | undefined;
}

/** A plan's statistics, grouped from its mandates and their settled charges. */
export interface PlanStatsAggregate {
  planId: number;
  activeMandates: number;
  totalMandates: number;
  cancellations: number;
  totalCollected: bigint;
  totalCharges: number;
}

/**
 * Per-plan statistics: active and total mandates, cancellations, gross amount
 * collected and the average number of settled charges per mandate.
 *
 * Starts from mandates so a plan with no settled charges still appears with a
 * total collected of `0`. The collected sum reads as bigint, so no amount
 * round-trips through a JavaScript number; replaying a ledger range is
 * idempotent because charges are keyed on (tx_hash, mandate_id).
 */
export function getPlanStats(
  db: DatabaseSync,
  planId: number,
): PlanStatsAggregate {
  const mandateCounts = db
    .prepare(
      `SELECT COUNT(*) AS total_mandates,
              SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) AS active_mandates,
              SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancellations
         FROM mandates
        WHERE plan_id = ?`,
    )
    .get(planId) as {
      total_mandates: number;
      active_mandates: number;
      cancellations: number;
    } | undefined;

  const revenueStmt = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(c.amount AS INTEGER)), 0) AS total_collected,
              COUNT(c.tx_hash) AS total_charges
         FROM charges c
         JOIN mandates m ON m.id = c.mandate_id
        WHERE m.plan_id = ?`,
    );
  // Read the sum as bigint so a large collected total never round-trips
  // through a JavaScript number at stroop scale.
  revenueStmt.setReadBigInts(true);
  const revenue = revenueStmt.get(planId) as {
    total_collected: bigint;
    // COUNT also reads as bigint under setReadBigInts; counts are small, so
    // coerce back to a number.
    total_charges: bigint;
  } | undefined;

  const total = mandateCounts?.total_mandates ?? 0;
  return {
    planId,
    activeMandates: mandateCounts?.active_mandates ?? 0,
    totalMandates: total,
    cancellations: mandateCounts?.cancellations ?? 0,
    totalCollected: revenue?.total_collected ?? 0n,
    // Charges settled is a count, never an amount; safe to coerce to a number.
    totalCharges: Number(revenue?.total_charges ?? 0n),
  };
}

/**
 * Batch the token contract id for a set of plan ids. A mandate carries no
 * token of its own — it inherits its plan's — so enriching a page of
 * mandates costs one read, not one per row. Ids are de-duped first; unknown
 * plan ids are simply absent from the map.
 */
export function planTokensByIds(db: DatabaseSync, planIds: number[]): Map<number, string> {
  const ids = [...new Set(planIds)];
  if (ids.length === 0) return new Map();
  const rows = db
    // The interpolation is `?` placeholders only, one per de-duped numeric id;
    // the ids themselves are bound parameters, never interpolated.
    // eslint-disable-next-line no-restricted-syntax
    .prepare(`SELECT id, token FROM plans WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...(ids as never[])) as unknown as { id: number; token: string }[];
  return new Map(rows.map((row) => [row.id, row.token]));
}

/** List mandates ordered newest-first with optional id batch, subscriber, merchant, and status filters. */
export function listMandates(
  db: DatabaseSync,
  filter: ListMandatesFilter,
): MandateRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.ids !== undefined) {
    if (filter.ids.length === 0) return [];
    where.push(`id IN (${filter.ids.map(() => "?").join(",")})`);
    args.push(...filter.ids);
  }
  if (filter.subscriber) {
    where.push("subscriber = ?");
    args.push(filter.subscriber);
  }
  if (filter.merchant) {
    where.push("merchant = ?");
    args.push(filter.merchant);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  args.push(filter.limit);
  const rows = db
    // `clause` is assembled above from fixed predicates; every value is a
    // bound parameter, so this interpolation is structural, not user data.
    // eslint-disable-next-line no-restricted-syntax
    .prepare(`SELECT * FROM mandates ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...(args as never[]));
  return rows as unknown as MandateRow[];
}

/** Look up a single mandate by on-chain id. */
export function getMandateById(
  db: DatabaseSync,
  id: number,
): MandateRow | undefined {
  return db
    .prepare("SELECT * FROM mandates WHERE id = ?")
    .get(id) as unknown as MandateRow | undefined;
}

/** Resolve the merchant for a mandate when an event only includes its id. */
export function getMandateMerchant(db: DatabaseSync, id: number): string | undefined {
  return (
    db.prepare("SELECT merchant FROM mandates WHERE id = ?").get(id) as
      | { merchant: string }
      | undefined
  )?.merchant;
}

/** List charge events for a mandate ordered by ledger descending. */
export function listMandateCharges(
  db: DatabaseSync,
  mandateId: number,
  limit: number,
): ChargeRow[] {
  return db
    .prepare("SELECT * FROM charges WHERE mandate_id = ? ORDER BY ledger DESC LIMIT ?")
    .all(mandateId, limit) as unknown as ChargeRow[];
}

/** Latest indexed vault balance for each token owned by an address. */
export function getVaultBalances(
  db: DatabaseSync,
  address: string,
): VaultBalancePage["balances"] {
  return db
    .prepare(
      `SELECT e.token, e.balance, e.ledger
         FROM vault_events e
        WHERE e.user = ?
          AND NOT EXISTS (
            SELECT 1 FROM vault_events newer
             WHERE newer.user = e.user
               AND newer.token = e.token
               AND (newer.ledger > e.ledger OR
                    (newer.ledger = e.ledger AND newer.rowid > e.rowid))
          )
        ORDER BY e.token`,
    )
    .all(address) as unknown as VaultBalancePage["balances"];
}

/** Vault events for an address, newest ledger and insertion order first. */
export function listVaultEvents(
  db: DatabaseSync,
  address: string,
  limit: number,
): VaultEventPage["events"] {
  return db
    .prepare(
      `SELECT tx_hash, kind, user, token, counterparty, amount, balance, ledger
         FROM vault_events
        WHERE user = ?
        ORDER BY ledger DESC, rowid DESC
        LIMIT ?`,
    )
    .all(address, limit) as unknown as VaultEventPage["events"];
}

/** Current fee is the newest indexed fee change; null means no change is known. */
export function getProtocolFeeHistory(db: DatabaseSync): ProtocolResponse {
  const history = db
    .prepare(
      `SELECT tx_hash, old_fee_bps, new_fee_bps, ledger
         FROM fee_history
        ORDER BY ledger DESC, rowid DESC`,
    )
    .all() as unknown as ProtocolResponse["history"];
  return { fee_bps: history[0]?.new_fee_bps ?? null, history };
}

/** List active mandates currently eligible for settlement at `now`. */
export function listDueMandates(
  db: DatabaseSync,
  now: number,
  limit: number,
): DueMandateRow[] {
  return db
    .prepare(
      `SELECT id, subscriber, merchant, next_charge, amount
         FROM mandates
        WHERE status = 'Active' AND next_charge <= ?
          AND (max_charges = 0 OR charges_made < max_charges)
        ORDER BY next_charge ASC LIMIT ?`,
    )
    .all(now, limit) as unknown as DueMandateRow[];
}

/** Revenue per token: sums from charges and active mandates, joined via plans. */
export function listMerchantTokenRevenue(
  db: DatabaseSync,
  merchant: string,
): TokenRevenue[] {
  // A charge carries no token of its own; its mandate's plan does. Both
  // series read as bigint so no sum round-trips through a JS number.
  const collected = db.prepare(
    `SELECT p.token AS token, COALESCE(SUM(CAST(c.amount AS INTEGER)), 0) AS total
       FROM charges c
       JOIN mandates m ON m.id = c.mandate_id
       JOIN plans p ON p.id = m.plan_id
      WHERE c.merchant = ?
      GROUP BY p.token`,
  );
  collected.setReadBigInts(true);
  const recurring = db.prepare(
    // eslint-disable-next-line no-restricted-syntax
    `SELECT p.token AS token,
            COALESCE(SUM(CAST(m.amount AS INTEGER) * ${SECONDS_PER_MONTH} / m.period), 0) AS mrr
       FROM mandates m
       JOIN plans p ON p.id = m.plan_id
      WHERE m.merchant = ? AND m.status = 'Active' AND m.period > 0
      GROUP BY p.token`,
  );
  recurring.setReadBigInts(true);

  const tokens = new Map<string, { totalCollected: string; mrr: string }>();
  for (const row of collected.all(merchant) as { token: string; total: bigint }[]) {
    tokens.set(row.token, { totalCollected: String(row.total), mrr: "0" });
  }
  for (const row of recurring.all(merchant) as { token: string; mrr: bigint }[]) {
    const entry = tokens.get(row.token) ?? { totalCollected: "0", mrr: "0" };
    entry.mrr = String(row.mrr);
    tokens.set(row.token, entry);
  }
  return [...tokens]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([token, sums]) => ({ token, ...sums }));
}

/** Compute merchant revenue summary and per-token breakdown. */
export function getMerchantSummary(
  db: DatabaseSync,
  merchant: string,
  defaultToken?: string,
): MerchantSummary {
  const active = db
    .prepare(
      "SELECT COUNT(*) AS n FROM mandates WHERE merchant = ? AND status = 'Active'",
    )
    .get(merchant) as { n: number };
  const collected = db
    .prepare(
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total, COUNT(*) AS n FROM charges WHERE merchant = ?",
    )
    .get(merchant) as { total: number; n: number };
  // Recurring revenue, normalised from each mandate's own period: MRR over a
  // 30-day month and ARR over a 365-day year. Integer division truncates,
  // which is fine at base-unit (stroop) scale.
  const recurring = db
    .prepare(
      // Only module-level constants are interpolated here; the address is a
      // bound parameter, so no request data reaches the SQL text.
      // eslint-disable-next-line no-restricted-syntax
      `SELECT COALESCE(SUM(CAST(amount AS INTEGER) * ${SECONDS_PER_MONTH} / period), 0) AS mrr,
              COALESCE(SUM(CAST(amount AS INTEGER) * ${SECONDS_PER_YEAR} / period), 0) AS arr
         FROM mandates WHERE merchant = ? AND status = 'Active' AND period > 0`,
    )
    .get(merchant) as { mrr: number; arr: number };

  // The flat totals stop at one token only when a default exists. Without
  // TOKEN_ID they keep the previous all-token meaning.
  const tokens = listMerchantTokenRevenue(db, merchant);
  const scoped = defaultToken
    ? tokens.find((t) => t.token === defaultToken)
    : undefined;

  return {
    merchant,
    activeMandates: active.n,
    totalCollected: defaultToken
      ? (scoped?.totalCollected ?? "0")
      : String(collected.total),
    chargeCount: collected.n,
    mrr: defaultToken ? (scoped?.mrr ?? "0") : String(recurring.mrr),
    arr: String(recurring.arr),
    tokens,
  };
}

/** Active positive-period mandates for a merchant's revenue forecast. */
export function listMerchantForecastMandates(
  db: DatabaseSync,
  merchant: string,
): ForecastMandateRow[] {
  return db
    .prepare(
      `SELECT amount, period, next_charge, charges_made, max_charges, fee_bps
         FROM mandates WHERE merchant = ? AND status = 'Active' AND period > 0`,
    )
    .all(merchant) as unknown as ForecastMandateRow[];
}

/** Subscriber mandates and cumulative gross amount paid (amount + fee). */
export function getSubscriberSummary(
  db: DatabaseSync,
  subscriber: string,
): SubscriberSummary {
  const mandates = db
    .prepare("SELECT * FROM mandates WHERE subscriber = ? ORDER BY id DESC")
    .all(subscriber) as unknown as MandateRow[];
  const paid = db
    .prepare(
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges WHERE subscriber = ?",
    )
    .get(subscriber) as { total: number };
  return {
    subscriber,
    mandates,
    totalPaid: String(paid.total),
  };
}

/** The lifecycle events a churn report counts, in report order. */
export const CHURN_KINDS = ["started", "cancelled", "ended", "completed"] as const;

export type ChurnKind = (typeof CHURN_KINDS)[number];

/**
 * A merchant's churn report: how many mandates started and departed in each
 * time bucket.
 *
 * The counts come from `mandate_events`, the append-only log the indexer
 * writes one row per mandate per lifecycle event into. Each row is stamped
 * with the ledger close time of its event, so a bucket is a property of the
 * chain, not of when the indexer happened to run: replaying a ledger range
 * leaves the report unchanged.
 *
 * One indexed scan groups the events by bucket and kind, so the report costs
 * the same whether the merchant has ten mandates or ten thousand.
 */
export function getMerchantChurn(
  db: DatabaseSync,
  merchant: string,
  bucket: ChurnBucketSize,
  limit: number,
): MerchantChurnResponse {
  const rows = db
    .prepare(
      // The bucket expression is a vetted static fragment chosen by the
      // bucket size, never request data; the address is a bound parameter,
      // so no request data reaches the SQL text.
      // eslint-disable-next-line no-restricted-syntax
      `SELECT kind, ${BUCKET_SQL[bucket]} AS bucket, COUNT(*) AS n
         FROM mandate_events
        WHERE merchant = ?
        GROUP BY kind, bucket`,
    )
    .all(merchant) as unknown as Array<{
    kind: ChurnKind;
    bucket: number;
    n: number;
  }>;

  const counts = new Map<number, Record<ChurnKind, number>>();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    let entry = counts.get(row.bucket);
    if (!entry) {
      // Every kind starts at zero, so a bucket reports a kind it has no
      // events for as an explicit zero rather than as a missing field.
      entry = Object.fromEntries(CHURN_KINDS.map((k) => [k, 0])) as Record<ChurnKind, number>;
      counts.set(row.bucket, entry);
    }
    entry[row.kind] = row.n;
    if (row.bucket < min) min = row.bucket;
    if (row.bucket > max) max = row.bucket;
  }

  // Report the most recent buckets, oldest first within the window. The
  // limit bounds the work the caller can ask for; the query itself is a
  // single indexed scan either way.
  const buckets: ChurnBucket[] = [];
  if (counts.size > 0) {
    const starts = bucketStarts(bucket, min, max);
    const window = starts.slice(Math.max(0, starts.length - limit));
    for (const start of window) {
      const entry = counts.get(Math.floor(start.getTime() / 1000));
      const started = entry?.started ?? 0;
      const cancelled = entry?.cancelled ?? 0;
      const ended = entry?.ended ?? 0;
      const completed = entry?.completed ?? 0;
      buckets.push({
        bucket: bucketLabel(bucket, start),
        started,
        cancelled,
        ended,
        completed,
        net: started - cancelled - ended - completed,
      });
    }
  }

  const totals = buckets.reduce(
    (acc, b) => ({
      started: acc.started + b.started,
      cancelled: acc.cancelled + b.cancelled,
      ended: acc.ended + b.ended,
      completed: acc.completed + b.completed,
      net: acc.net + b.net,
    }),
    { started: 0, cancelled: 0, ended: 0, completed: 0, net: 0 },
  );

  return { merchant, bucket, buckets, totals };
}

/** Every bucket start between two instants, oldest first. */
function bucketStarts(
  bucket: ChurnBucketSize,
  from: number,
  to: number,
): Date[] {
  const starts: Date[] = [];
  let cursor = bucketStart(bucket, from);
  const end = bucketStart(bucket, to);
  // The guard bounds a pathological range; the caller already limits the
  // number of buckets it keeps.
  for (let i = 0; i < 10_000 && cursor.getTime() <= end.getTime(); i += 1) {
    starts.push(cursor);
    cursor = nextBucketStart(bucket, cursor);
  }
  return starts;
}

/** A merchant's distinct subscriber, grouped across that subscriber's mandates with the merchant. */
export interface MerchantSubscriberAggregate {
  subscriber: string;
  mandateCount: number;
  chargeCount: number;
  totalCollected: bigint;
}

/**
 * A merchant's distinct subscribers, ordered by lifetime value descending.
 *
 * Starts from mandates so a subscriber with mandates but no settled charges
 * still appears with a lifetime value of `0`. Every value is a bound
 * parameter and the sum reads as bigint, so no amount round-trips through a
 * JavaScript number.
 */
export function listMerchantSubscribers(
  db: DatabaseSync,
  merchant: string,
  limit: number,
): MerchantSubscriberAggregate[] {
  const stmt = db
    // The address is a bound parameter, so no request data reaches the SQL text.
    .prepare(
      `SELECT m.subscriber AS subscriber,
              COUNT(DISTINCT m.id) AS mandate_count,
              COUNT(c.tx_hash) AS charge_count,
              COALESCE(SUM(CAST(c.amount AS INTEGER)), 0) AS total_collected
         FROM mandates m
         LEFT JOIN charges c ON c.mandate_id = m.id AND c.merchant = m.merchant
        WHERE m.merchant = ?
        GROUP BY m.subscriber
        ORDER BY total_collected DESC, m.subscriber
        LIMIT ?`,
    );
  // Read the sum as bigint so lifetime value never round-trips through a
  // JavaScript number at stroop scale.
  stmt.setReadBigInts(true);
  const rows = stmt.all(merchant, limit) as unknown as {
    subscriber: string;
    mandate_count: number;
    charge_count: number;
    total_collected: bigint;
  }[];
  return rows.map((row) => ({
    // Counts came through as bigint because the statement reads integers as
    // bigint; coerce back to numbers — they are small counts, never amounts.
    subscriber: row.subscriber,
    mandateCount: Number(row.mandate_count),
    chargeCount: Number(row.charge_count),
    totalCollected: row.total_collected,
  }));
}

/** Active positive-period mandates for a subscriber's upcoming schedule. */
export function listSubscriberUpcomingMandates(
  db: DatabaseSync,
  subscriber: string,
): UpcomingMandateRow[] {
  return db
    .prepare(
      `SELECT id, merchant, amount, period, next_charge, charges_made, max_charges
         FROM mandates WHERE subscriber = ? AND status = 'Active' AND period > 0`,
    )
    .all(subscriber) as unknown as UpcomingMandateRow[];
}

/** Run an aggregate returning one `total` column; decimal string out. */
function sumOf(db: DatabaseSync, sql: string, ...args: unknown[]): string {
  const stmt = db.prepare(sql);
  // Read as bigint so a large sum never round-trips through a JS number.
  stmt.setReadBigInts(true);
  const row = stmt.get(...(args as never[])) as { total: bigint } | undefined;
  return String(row?.total ?? 0n);
}

/** Protocol-wide counts, gross volume (24h and all-time), fees, and indexer cursor. */
export function getProtocolStats(
  db: DatabaseSync,
  since: number,
): StatsResponse {
  const one = (sql: string): number =>
    (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
  return {
    plans: one("SELECT COUNT(*) AS n FROM plans"),
    mandates: one("SELECT COUNT(*) AS n FROM mandates"),
    activeMandates: one("SELECT COUNT(*) AS n FROM mandates WHERE status = 'Active'"),
    charges: one("SELECT COUNT(*) AS n FROM charges"),
    volume24h: sumOf(
      db,
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges WHERE created_at >= ?",
      since,
    ),
    volumeAllTime: sumOf(
      db,
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges",
    ),
    totalFees: sumOf(
      db,
      "SELECT COALESCE(SUM(CAST(fee AS INTEGER)), 0) AS total FROM charges",
    ),
    activeMerchants: one(
      "SELECT COUNT(DISTINCT merchant) AS n FROM mandates WHERE status = 'Active'",
    ),
    lastIndexedLedger: readCursor(db, 0),
  };
}
