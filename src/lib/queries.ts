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
  DueMandateRecord,
  ProtocolResponse,
  MandateRow,
  MerchantChurnResponse,
  MerchantRevenueResponse,
  MerchantSummary,
  PlanRow,
  RevenueBucket,
  RevenueBucketSize,
  StatsResponse,
  SubscriberSummary,
  TokenRevenue,
  VaultBalancePage,
  VaultEventPage,
} from "../routes/types.ts";

/** A primary-key cursor names the last row of the previous page. */
export interface ListCursorFilter {
  /** The primary key to page after: rows with `id < cursor` are returned. */
  cursor?: number | undefined;
  limit: number;
}

export interface ListPlansFilter extends ListCursorFilter {
  merchant?: string | undefined;
}

export interface ListMandatesFilter extends ListCursorFilter {
  ids?: number[] | undefined;
  subscriber?: string | undefined;
  merchant?: string | undefined;
  status?: string | undefined;
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

/**
 * List plans ordered newest-first, optionally filtered by merchant, paginated
 * by a primary-key cursor. Fetch one extra row so the caller can tell whether
 * a further page exists.
 */
export function listPlans(
  db: DatabaseSync,
  filter: ListPlansFilter,
): { rows: PlanRow[]; nextCursorId: number | null } {
  return cursorPage(
    db,
    "FROM plans",
    filter.merchant ? "WHERE merchant = ?" : "",
    filter.merchant ? [filter.merchant] : [],
    filter,
  );
}

/**
 * Page by primary key: fetch `limit + 1` rows ordered by `id DESC`, starting
 * strictly below `cursor` when one is given. The extra row tells whether a
 * further page exists; the cursor names a primary key, never an offset, so
 * inserts or deletes between pages cannot skip or repeat rows.
 */
export function cursorPage<T extends { id: number }>(
  db: DatabaseSync,
  fromSql: string,
  whereSql: string,
  args: unknown[],
  filter: ListCursorFilter,
): { rows: T[]; nextCursorId: number | null } {
  let where = whereSql;
  if (filter.cursor !== undefined) {
    where += where.length ? ` AND id < ?` : ` WHERE id < ?`;
    args.push(filter.cursor);
  }
  args.push(filter.limit + 1);
  const separator = where.length ? " " : "";
  // `fromSql` ("FROM plans" / "FROM mandates") and `whereSql` ("WHERE ..." or
  // "") are built from fixed fragments; every value is a bound parameter, so
  // this interpolation is structural, not user data.
  // eslint-disable-next-line no-restricted-syntax
  const rows = db.prepare(`SELECT * ${fromSql}${separator}${where} ORDER BY id DESC LIMIT ?`).all(...(args as never[])) as unknown as T[];
  if (rows.length > filter.limit) {
    return { rows: rows.slice(0, filter.limit) as T[], nextCursorId: rows[filter.limit - 1]!.id };
  }
  return { rows, nextCursorId: null };
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

/**
 * List mandates ordered newest-first with optional id batch, subscriber,
 * merchant, and status filters, paginated by a primary-key cursor. Fetch one
 * extra row so the caller can tell whether a further page exists.
 */
export function listMandates(
  db: DatabaseSync,
  filter: ListMandatesFilter,
): { rows: MandateRow[]; nextCursorId: number | null } {
  if (filter.ids !== undefined && filter.ids.length === 0) {
    return { rows: [], nextCursorId: null };
  }
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.ids !== undefined) {
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
  return cursorPage(db, "FROM mandates", clause, args, filter);
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

/**
 * List active mandates currently eligible for settlement at `now`.
 *
 * `plan_id` comes along so the caller can find the mandate's token — the
 * vault balance is per (subscriber, token).
 */
export function listDueMandates(
  db: DatabaseSync,
  now: number,
  limit: number,
): DueMandateRecord[] {
  return db
    .prepare(
      `SELECT id, subscriber, merchant, next_charge, amount, plan_id
         FROM mandates
        WHERE status = 'Active' AND next_charge <= ?
          AND (max_charges = 0 OR charges_made < max_charges)
        ORDER BY next_charge ASC LIMIT ?`,
    )
    .all(now, limit) as unknown as DueMandateRecord[];
}

/**
 * How many active mandates are eligible for settlement right now.
 *
 * The same predicate `listDueMandates` uses, counted instead of listed: an
 * operator wants the number ("are any mandates waiting?") without pulling
 * every row of the due list into memory.
 */
export function countDueMandates(db: DatabaseSync, now: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM mandates
          WHERE status = 'Active' AND next_charge <= ?
            AND (max_charges = 0 OR charges_made < max_charges)`,
      )
      .get(now) as { n: number } | undefined
  )?.n ?? 0;
}

/**
 * The last known vault balance of every listed address, per token.
 *
 * `vault_events` records the balance after each deposit, withdrawal and
 * debit, so the newest event per (address, token) carries the balance the
 * vault held at that point. An address with no events holds nothing: the
 * vault starts empty, so its balance is zero.
 *
 * The balances stay the strings they are stored as — an amount is never read
 * as a number, so no precision is lost on the way out.
 */
export function listLatestVaultBalances(
  db: DatabaseSync,
  addresses: string[],
): Map<string, Map<string, string>> {
  const unique = [...new Set(addresses)];
  const balances = new Map<string, Map<string, string>>();
  if (unique.length === 0) return balances;
  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare(
      // The placeholders are one "?" per de-duped address; the addresses
      // themselves are bound parameters, so no request data reaches the SQL
      // text.
      // eslint-disable-next-line no-restricted-syntax
      `SELECT e.user AS user, e.token AS token, e.balance AS balance
         FROM vault_events e
        WHERE e.user IN (${placeholders})
          AND NOT EXISTS (
            SELECT 1 FROM vault_events newer
             WHERE newer.user = e.user
               AND newer.token = e.token
               AND (newer.ledger > e.ledger OR
                    (newer.ledger = e.ledger AND newer.rowid > e.rowid))
          )`,
    )
    .all(...(unique as never[])) as unknown as {
    user: string;
    token: string;
    balance: string;
  }[];
  for (const row of rows) {
    const perToken = balances.get(row.user) ?? new Map<string, string>();
    perToken.set(row.token, row.balance);
    balances.set(row.user, perToken);
  }
  return balances;
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

/**
 * A merchant's revenue over time: what came in, what the protocol took and
 * what the merchant kept, in calendar buckets.
 *
 * The buckets come from `charges.created_at`, which is the close time of the
 * ledger each charge was emitted in — the chain's clock, not the indexer's —
 * so the report describes the chain's own history and replaying a ledger
 * range leaves it unchanged.
 *
 * `gross` is what the subscribers paid (the charge amount plus the fee),
 * `fee` is the protocol's share of it and `net` is what the merchant kept,
 * so gross − fee = net. Every sum is read as a bigint, so no amount
 * round-trips through a JavaScript number.
 *
 * `from` and `to` bound the range in unix seconds; the range is half-open,
 * so a charge exactly at `to` is excluded. Without them the report covers
 * the merchant's whole history.
 */
export function getMerchantRevenue(
  db: DatabaseSync,
  merchant: string,
  bucket: RevenueBucketSize,
  from: number | undefined,
  to: number | undefined,
  limit: number,
): MerchantRevenueResponse {
  const where = ["merchant = ?"];
  const args: unknown[] = [merchant];
  if (from !== undefined) {
    // `created_at` is unix milliseconds; the range is in seconds.
    where.push("created_at >= ?");
    args.push(from * 1000);
  }
  if (to !== undefined) {
    where.push("created_at < ?");
    args.push(to * 1000);
  }

  const stmt = db.prepare(
    // The bucket expression is a vetted static fragment chosen by the
    // bucket size and the predicates are fixed; the address and the range
    // are bound parameters, so no request data reaches the SQL text.
    // eslint-disable-next-line no-restricted-syntax
    `SELECT ${BUCKET_SQL[bucket]} AS bucket,
            COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS gross,
            COALESCE(SUM(CAST(fee AS INTEGER)), 0) AS fee,
            COUNT(*) AS charges
       FROM (
         SELECT CAST(created_at / 1000 AS INTEGER) AS at, amount, fee
           FROM charges
          WHERE ${where.join(" AND ")}
       )
      GROUP BY bucket
      ORDER BY bucket`,
  );
  // Read the sums as bigint so a large collected total never round-trips
  // through a JavaScript number at stroop scale.
  stmt.setReadBigInts(true);
  const rows = stmt.all(...(args as never[])) as unknown as Array<{
    bucket: number;
    gross: bigint;
    fee: bigint;
    charges: bigint;
  }>;

  const perBucket = new Map<number, { gross: bigint; fee: bigint; charges: number }>();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    // The statement reads integers as bigint, so the bucket start is one too:
    // it is a timestamp, not an amount, and fits in a number.
    const start = Number(row.bucket);
    perBucket.set(start, {
      gross: row.gross,
      fee: row.fee,
      // A count, never an amount; safe to coerce back to a number.
      charges: Number(row.charges),
    });
    if (start < min) min = start;
    if (start > max) max = start;
  }

  // Every bucket between the first and the last one with data is present, so
  // a chart has no gaps in it. The limit keeps the most recent ones.
  const buckets: RevenueBucket[] = [];
  if (perBucket.size > 0) {
    const starts = bucketStarts(bucket, min, max);
    const window = starts.slice(Math.max(0, starts.length - limit));
    for (const start of window) {
      const entry = perBucket.get(Math.floor(start.getTime() / 1000));
      const gross = entry?.gross ?? 0n;
      const fee = entry?.fee ?? 0n;
      buckets.push({
        bucket: bucketLabel(bucket, start),
        gross: String(gross),
        fee: String(fee),
        net: String(gross - fee),
        charges: entry?.charges ?? 0,
      });
    }
  }

  const totals = buckets.reduce(
    (acc, b) => ({
      gross: acc.gross + BigInt(b.gross),
      fee: acc.fee + BigInt(b.fee),
      net: acc.net + BigInt(b.net),
      charges: acc.charges + b.charges,
    }),
    { gross: 0n, fee: 0n, net: 0n, charges: 0 },
  );

  return {
    merchant,
    bucket,
    from: from ?? null,
    to: to ?? null,
    buckets,
    totals: {
      gross: String(totals.gross),
      fee: String(totals.fee),
      net: String(totals.net),
      charges: totals.charges,
    },
  };
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

/** Raw event archive row, as stored by indexer issue #34. */
export interface RawContractEventRow {
  event_id: string;
  contract_id: string;
  ledger: number;
  tx_hash: string;
  event_index: string;
  topics: string;
  data: string;
  close_time: number | null;
}

/**
 * Read one bounded archive batch in ledger/event order. Separate static SQL
 * statements avoid dynamic SQL interpolation and preserve parameter binding.
 */
export function listRawContractEvents(
  db: DatabaseSync,
  ledger: number,
  eventId: string,
  contract: string | undefined,
  limit: number,
): RawContractEventRow[] {
  if (contract === undefined) {
    return db.prepare(
      "SELECT event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time FROM events WHERE (ledger, event_id) > (?, ?) ORDER BY ledger, event_id LIMIT ?",
    ).all(ledger, eventId, limit) as unknown as RawContractEventRow[];
  }
  return db.prepare(
    "SELECT event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time FROM events WHERE (ledger, event_id) > (?, ?) AND contract_id = ? ORDER BY ledger, event_id LIMIT ?",
  ).all(ledger, eventId, contract, limit) as unknown as RawContractEventRow[];
}

/** Full event history, independent of the aggregate mandate_events churn log. */
export interface MandateTimelineRow {
  mandate_id: number;
  tx_hash: string;
  kind: string;
  ledger: number;
  at: number | null;
  details: string;
}

export function listMandateTimeline(db: DatabaseSync, mandateId: number): MandateTimelineRow[] {
  return db.prepare(
    "SELECT mandate_id, tx_hash, kind, ledger, at, details FROM mandate_timeline WHERE mandate_id = ? ORDER BY ledger ASC, tx_hash ASC, kind ASC",
  ).all(mandateId) as unknown as MandateTimelineRow[];
}
