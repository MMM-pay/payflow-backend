import type { Storage } from "./store/types.ts";
import {
  BUCKET_SQL,
  bucketLabel,
  bucketStart,
  nextBucketStart,
} from "./churn.ts";
import { MAX_CHURN_BUCKETS, SECONDS_PER_MONTH, SECONDS_PER_YEAR } from "../routes/helpers.ts";
import type {
  ChargeAttemptRow,
  ChargeRow,
  ChurnBucket,
  ChurnBucketSize,
  CohortRetention,
  DueMandateRecord,
  ProtocolResponse,
  MandateRow,
  MerchantChurnResponse,
  MerchantCohortsResponse,
  MerchantProfile,
  MerchantRevenueResponse,
  MerchantSummary,
  PlanRow,
  ProtocolFeeBucket,
  ProtocolFeesResponse,
  RevenueBucket,
  RevenueBucketSize,
  StatsResponse,
  SubscriberSummary,
  TokenRevenue,
  UnpaidMandateRow,
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
  q?: string | undefined;
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
export async function listPlans(
  db: Storage,
  filter: ListPlansFilter,
): Promise<{ rows: PlanRow[]; nextCursorId: number | null }> {
  const { where, args } = planFilter(filter);
  return cursorPage<PlanRow>(
    db,
    "FROM plans",
    where,
    args,
    filter,
  );
}

/** The WHERE clause and bound values of the merchant and name filters a plan listing takes. */
function planFilter(filter: Omit<ListPlansFilter, "cursor" | "limit">): {
  where: string;
  args: unknown[];
} {
  const conditions: string[] = [];
  const args: unknown[] = [];

  if (filter.merchant) {
    conditions.push("merchant = ?");
    args.push(filter.merchant);
  }
  if (filter.q) {
    const escaped = filter.q
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    conditions.push("LOWER(name) LIKE LOWER(?) ESCAPE '\\'");
    args.push(`%${escaped}%`);
  }

  return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", args };
}

/**
 * The `limit` most popular plans: the most active mandates first, ties broken
 * by plan id ascending so the order is total and stable. A plan without an
 * active mandate still ranks, last, with a count of zero.
 *
 * Each plan's count is one covering range lookup on `mandates_plan_status`
 * (plan_id, status), so the cost is O(P log M + A) for the P plans the
 * filters keep, M mandates and A of them active; SQLite keeps only the top
 * `limit` rows while it sorts, so memory is O(limit).
 */
export async function listPlansBySubscribers(
  db: Storage,
  filter: Omit<ListPlansFilter, "cursor">,
): Promise<PlanRow[]> {
  const { where, args } = planFilter(filter);
  return db.all<PlanRow>(
      `SELECT * FROM plans ${where}
        ORDER BY (SELECT COUNT(*) FROM mandates m
                   WHERE m.plan_id = plans.id AND m.status = 'Active') DESC,
                 id ASC
        LIMIT ?`,
    [...args, filter.limit],
  );
}

/**
 * Page by primary key: fetch `limit + 1` rows ordered by `id DESC`, starting
 * strictly below `cursor` when one is given. The extra row tells whether a
 * further page exists; the cursor names a primary key, never an offset, so
 * inserts or deletes between pages cannot skip or repeat rows.
 */
export async function cursorPage<T extends { id: number }>(
  db: Storage,
  fromSql: string,
  whereSql: string,
  args: unknown[],
  filter: ListCursorFilter,
): Promise<{ rows: T[]; nextCursorId: number | null }> {
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
  const rows = await db.all<T>(`SELECT * ${fromSql}${separator}${where} ORDER BY id DESC LIMIT ?`, args);
  if (rows.length > filter.limit) {
    return { rows: rows.slice(0, filter.limit) as T[], nextCursorId: rows[filter.limit - 1]!.id };
  }
  return { rows, nextCursorId: null };
}

/** Look up a single plan by on-chain id. */
export async function getPlanById(db: Storage, id: number): Promise<PlanRow | undefined> {
  return db.get<PlanRow>("SELECT * FROM plans WHERE id = ?", [id]);
}

/** A merchant's self-declared profile, or undefined when it never set one. */
export async function getMerchantProfile(
  db: Storage,
  merchant: string,
): Promise<MerchantProfile | undefined> {
  return db.get<MerchantProfile>(
    "SELECT merchant, name, url, ledger FROM merchant_profiles WHERE merchant = ?",
    [merchant],
  );
}

/**
 * Batch the self-declared display name for a set of merchants, so naming a
 * page of plans costs one primary-key read rather than one per row. Addresses
 * are de-duped first; a merchant without a profile is absent from the map.
 */
export async function merchantNamesByAddress(
  db: Storage,
  merchants: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(merchants)];
  if (unique.length === 0) return new Map();
  const rows = await db.all<{ merchant: string; name: string }>(
    `SELECT merchant, name FROM merchant_profiles WHERE merchant IN (${unique.map(() => "?").join(",")})`,
    unique,
  );
  return new Map(rows.map((row) => [row.merchant, row.name]));
}

/** A plan's statistics, grouped from its mandates and their settled charges. */
export interface PlanStatsAggregate {
  planId: number;
  activeMandates: number;
  totalMandates: number;
  cancellations: number;
  totalCollected: bigint;
  totalCharges: number;
  /** Mean lifetime value (net of fee) per subscriber of the plan; floored. */
  averageLtv: bigint;
  /** Median lifetime value per subscriber; the floored mean of the middle two when even. */
  medianLtv: bigint;
}

/**
 * Per-plan statistics: active and total mandates, cancellations, gross amount
 * collected and the average number of settled charges per mandate.
 *
 * Lifetime value (#143) is what one subscriber has paid the merchant through
 * the plan, net of the protocol fee — the sum of their charges' `amount`,
 * across every mandate they hold on it. Every subscriber with a mandate
 * counts, one who was never charged at zero, so the figures describe the
 * subscribers the plan acquired rather than only the ones that paid.
 *
 * Starts from mandates so a plan with no settled charges still appears with a
 * total collected of `0`. The collected sum reads as bigint, so no amount
 * round-trips through a JavaScript number; replaying a ledger range is
 * idempotent because charges are keyed on (tx_hash, mandate_id).
 */
export async function getPlanStats(
  db: Storage,
  planId: number,
): Promise<PlanStatsAggregate> {
  const [mandateCounts, revenue] = await Promise.all([
    db.get<{
      total_mandates: number;
      active_mandates: number;
      cancellations: number;
    }>(
      `SELECT COUNT(*) AS total_mandates,
              SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) AS active_mandates,
              SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancellations
         FROM mandates
        WHERE plan_id = ?`,
      [planId],
    ),
    db.get<{ total_collected: bigint; total_charges: bigint }>(
      `SELECT COALESCE(SUM(CAST(c.amount AS INTEGER)), 0) AS total_collected,
              COUNT(c.tx_hash) AS total_charges
         FROM charges c
         JOIN mandates m ON m.id = c.mandate_id
        WHERE m.plan_id = ?`,
      [planId],
    ),
  ]);

  // One value per subscriber, ranked once so the median is read in the same
  // statement: `(n + 1) / 2` and `n / 2 + 1` name the same row when n is odd
  // and the middle two when it is even. Mandates come from the
  // (plan_id, status) index and charges from the mandate_id index; the rank
  // sorts S subscribers, O(S log S), and only one row reaches JavaScript.
  const ltv = await db.get<{
    subscribers: number | bigint;
    middle_sum: number | bigint;
    middle_count: number | bigint;
  }>(
    `WITH ltv AS (
       SELECT COALESCE(SUM(CAST(c.amount AS INTEGER)), 0) AS value
         FROM mandates m
         LEFT JOIN charges c ON c.mandate_id = m.id
        WHERE m.plan_id = ?
        GROUP BY m.subscriber
     ),
     ranked AS (
       SELECT value, ROW_NUMBER() OVER (ORDER BY value) AS rn, COUNT(*) OVER () AS n
         FROM ltv
     )
     SELECT COUNT(*) AS subscribers,
            COALESCE(SUM(CASE WHEN rn IN ((n + 1) / 2, n / 2 + 1) THEN value END), 0) AS middle_sum,
            COUNT(CASE WHEN rn IN ((n + 1) / 2, n / 2 + 1) THEN 1 END) AS middle_count
       FROM ranked`,
    [planId],
  );

  const total = Number(mandateCounts?.total_mandates ?? 0);
  const totalCollected = BigInt(revenue?.total_collected ?? 0);
  const subscribers = BigInt(ltv?.subscribers ?? 0);
  const middleSum = BigInt(ltv?.middle_sum ?? 0);
  const middleCount = BigInt(ltv?.middle_count ?? 0);
  return {
    planId,
    activeMandates: Number(mandateCounts?.active_mandates ?? 0),
    totalMandates: total,
    cancellations: Number(mandateCounts?.cancellations ?? 0),
    totalCollected,
    // Charges settled is a count, never an amount; safe to coerce to a number.
    totalCharges: Number(revenue?.total_charges ?? 0),
    // The subscribers' values sum to the plan's net collected total, so the
    // mean divides that instead of summing the same charges again.
    averageLtv: subscribers === 0n ? 0n : totalCollected / subscribers,
    medianLtv: middleCount === 0n ? 0n : middleSum / middleCount,
  };
}

/**
 * Batch the token contract id for a set of plan ids. A mandate carries no
 * token of its own — it inherits its plan's — so enriching a page of
 * mandates costs one read, not one per row. Ids are de-duped first; unknown
 * plan ids are simply absent from the map.
 */
export async function planTokensByIds(db: Storage, planIds: number[]): Promise<Map<number, string>> {
  const ids = [...new Set(planIds)];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db.all<{ id: number; token: string }>(
    `SELECT id, token FROM plans WHERE id IN (${placeholders})`,
    ids,
  );
  return new Map(rows.map((row) => [row.id, row.token]));
}

/**
 * List mandates ordered newest-first with optional id batch, subscriber,
 * merchant, and status filters, paginated by a primary-key cursor. Fetch one
 * extra row so the caller can tell whether a further page exists.
 */
export async function listMandates(
  db: Storage,
  filter: ListMandatesFilter,
): Promise<{ rows: MandateRow[]; nextCursorId: number | null }> {
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
  return cursorPage<MandateRow>(db, "FROM mandates", clause, args, filter);
}

/** Look up a single mandate by on-chain id. */
export async function getMandateById(
  db: Storage,
  id: number,
): Promise<MandateRow | undefined> {
  return db.get<MandateRow>("SELECT * FROM mandates WHERE id = ?", [id]);
}

/** Resolve the merchant for a mandate when an event only includes its id. */
export async function getMandateMerchant(db: Storage, id: number): Promise<string | undefined> {
  return (await db.get<{ merchant: string }>("SELECT merchant FROM mandates WHERE id = ?", [id]))?.merchant;
}

/**
 * List charge events for a mandate ordered by ledger descending.
 *
 * `from` and `to` bound the charge's ledger close time in unix seconds and
 * are both inclusive: `to` covers the whole second, so a charge stored at
 * `to * 1000 + 1` milliseconds is inside the range. Without them the whole
 * history is returned.
 */
export async function listMandateCharges(
  db: Storage,
  mandateId: number,
  limit: number,
  from?: number,
  to?: number,
): Promise<ChargeRow[]> {
  const where = ["mandate_id = ?"];
  const args: unknown[] = [mandateId];
  if (from !== undefined) {
    // `created_at` is unix milliseconds; the range is in seconds.
    where.push("created_at >= ?");
    args.push(from * 1000);
  }
  if (to !== undefined) {
    where.push("created_at < ?");
    args.push((to + 1) * 1000);
  }
  args.push(limit);
  // The predicates are fixed fragments and the values are bound parameters,
  // so no request data reaches the SQL text.
  return db.all<ChargeRow>(
    `SELECT * FROM charges WHERE ${where.join(" AND ")} ORDER BY ledger DESC LIMIT ?`,
    args,
  );
}

/**
 * A mandate's keeper charge attempts, newest first (#144). One range read on
 * the (mandate_id, id) index, O(log A + limit) however long the log is.
 */
export async function listChargeAttempts(
  db: Storage,
  mandateId: number,
  limit: number,
): Promise<ChargeAttemptRow[]> {
  const rows = await db.all<{
    id: number;
    mandate_id: number;
    attempted_at: number;
    result: ChargeAttemptRow["result"];
    error_code: string | null;
    tx_hash: string | null;
    shortfall: string | null;
    failures: number;
    retry_at: number | null;
  }>(
    `SELECT id, mandate_id, attempted_at, result, error_code, tx_hash, shortfall, failures, retry_at
       FROM charge_attempts
      WHERE mandate_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [mandateId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    mandateId: row.mandate_id,
    attemptedAt: row.attempted_at,
    result: row.result,
    errorCode: row.error_code,
    txHash: row.tx_hash,
    ...(row.shortfall === null ? {} : { shortfall: row.shortfall }),
    failures: row.failures,
    retryAt: row.retry_at,
  }));
}

/** One settled charge, as the merchant CSV export reads it. */
export interface MerchantChargeRow {
  tx_hash: string;
  mandate_id: number;
  subscriber: string;
  amount: string;
  fee: string;
  created_at: number;
}

/** Where a page of `listMerchantChargesAfter` resumes: the last row's sort key. */
export interface ChargeKey {
  created_at: number;
  tx_hash: string;
  mandate_id: number;
}

/**
 * One page of a merchant's charges, oldest first, after `after` in
 * (created_at, tx_hash, mandate_id) order. Keyset pages over the
 * `charges_merchant_created_at` index keep every query short, so a long
 * export never holds the synchronous SQLite for its whole length.
 * `from`/`to` bound `created_at` in unix milliseconds, half-open.
 */
export async function listMerchantChargesAfter(
  db: Storage,
  merchant: string,
  after: ChargeKey | null,
  limit: number,
  from = 0,
  to = Number.MAX_SAFE_INTEGER,
): Promise<MerchantChargeRow[]> {
  const key = after ?? { created_at: -1, tx_hash: "", mandate_id: -1 };
  return db.all<MerchantChargeRow>(
      `SELECT tx_hash, mandate_id, subscriber, amount, fee, created_at
         FROM charges
        WHERE merchant = ?
          AND created_at >= ? AND created_at < ?
          AND (created_at, tx_hash, mandate_id) > (?, ?, ?)
        ORDER BY created_at, tx_hash, mandate_id
        LIMIT ?`,
    [merchant, from, to, key.created_at, key.tx_hash, key.mandate_id, limit],
  );
}

/** One settled charge, as the subscriber CSV export reads it. */
export interface SubscriberChargeRow {
  tx_hash: string;
  mandate_id: number;
  merchant: string;
  plan_id: number | null;
  amount: string;
  fee: string;
  created_at: number;
}

/**
 * One page of a subscriber's charges, oldest first, after `after` in
 * (created_at, tx_hash, mandate_id) order. Keyset pages over the
 * `charges_subscriber_created_at` index keep every query short, so a long
 * export never holds the connection for its whole length. `plan_id`
 * comes from the mandate; it is null only if a charge arrived before its
 * mandate was projected. `from`/`to` bound `created_at` in unix milliseconds,
 * half-open.
 */
export async function listSubscriberChargesAfter(
  db: Storage,
  subscriber: string,
  after: ChargeKey | null,
  limit: number,
  from = 0,
  to = Number.MAX_SAFE_INTEGER,
): Promise<SubscriberChargeRow[]> {
  const key = after ?? { created_at: -1, tx_hash: "", mandate_id: -1 };
  return db.all<SubscriberChargeRow>(
    `SELECT c.tx_hash, c.mandate_id, c.merchant, m.plan_id, c.amount, c.fee, c.created_at
       FROM charges c
       LEFT JOIN mandates m ON m.id = c.mandate_id
      WHERE c.subscriber = ?
        AND c.created_at >= ? AND c.created_at < ?
        AND (c.created_at, c.tx_hash, c.mandate_id) > (?, ?, ?)
      ORDER BY c.created_at, c.tx_hash, c.mandate_id
      LIMIT ?`,
    [subscriber, from, to, key.created_at, key.tx_hash, key.mandate_id, limit],
  );
}

/** Latest indexed vault balance for each token owned by an address. */
export async function getVaultBalances(
  db: Storage,
  address: string,
): Promise<VaultBalancePage["balances"]> {
  return db.all<VaultBalancePage["balances"][number]>(
      `SELECT e.token, e.balance, e.ledger
         FROM vault_events e
        WHERE e."user" = ?
          AND NOT EXISTS (
            SELECT 1 FROM vault_events newer
             WHERE newer."user" = e."user"
               AND newer.token = e.token
               AND (newer.ledger > e.ledger OR
                    (newer.ledger = e.ledger AND newer.tx_hash > e.tx_hash))
          )
        ORDER BY e.token`,
    [address],
  );
}

/** Vault events for an address, newest ledger and insertion order first. */
export async function listVaultEvents(
  db: Storage,
  address: string,
  limit: number,
): Promise<VaultEventPage["events"]> {
  return db.all<VaultEventPage["events"][number]>(
      `SELECT tx_hash, kind, "user", token, counterparty, amount, balance, ledger
         FROM vault_events
          WHERE "user" = ?
          ORDER BY ledger DESC, tx_hash DESC
        LIMIT ?`,
    [address, limit],
  );
}

/** Current fee is the newest indexed fee change; null means no change is known. */
export async function getProtocolFeeHistory(db: Storage): Promise<ProtocolResponse> {
  const history = await db.all<ProtocolResponse["history"][number]>(
      `SELECT tx_hash, old_fee_bps, new_fee_bps, ledger
         FROM fee_history
        ORDER BY ledger DESC, tx_hash DESC`,
  );
  // The newest upgrade per contract; empty until a contract has been upgraded.
  const contract_versions = await db.all<ProtocolResponse["contract_versions"][number]>(
      `SELECT u.contract_id, u.new_hash AS wasm_hash, u.ledger
         FROM contract_upgrades u
        WHERE u.ledger = (SELECT MAX(ledger) FROM contract_upgrades WHERE contract_id = u.contract_id)
        ORDER BY contract_id`,
  );
  return { fee_bps: history[0]?.new_fee_bps ?? null, history, contract_versions };
}

/**
 * The protocol's fee income over time: the sum of every charge's fee, in
 * calendar buckets of the ledger close time the charge was emitted in.
 *
 * `charges` is keyed on (tx_hash, mandate_id), so a replayed ledger cannot
 * count a fee twice, and `created_at` is the chain's clock, so the report is
 * the same whether a charge was indexed live or on a backfill. Every sum reads
 * as bigint, so no amount round-trips through a JavaScript number.
 *
 * The report covers the newest `limit` buckets, ending with the one the most
 * recent charge falls in, and every bucket between the first and the last one
 * with fees is present, so a chart has no gaps. Only the charges inside that
 * window are read: the newest and the oldest charge are one index seek each
 * and the window is one covering range scan of `charges_created_at_fee`, so
 * the cost is O(log C + W) for C charges and W of them in the window, and
 * memory is O(limit) buckets.
 */
export async function getProtocolFees(
  db: Storage,
  bucket: RevenueBucketSize,
  limit: number,
): Promise<ProtocolFeesResponse> {
  const newest = (await db.get<{ at: number | null }>("SELECT MAX(created_at) AS at FROM charges"))?.at ?? null;
  const oldest = (await db.get<{ at: number | null }>("SELECT MIN(created_at) AS at FROM charges"))?.at ?? null;
  if (newest === null || oldest === null) {
    return { bucket, buckets: [], totals: { fee: "0", charges: 0 } };
  }

  // `created_at` is unix milliseconds; the bucket arithmetic is in seconds.
  const last = Math.floor(newest / 1000);
  const first = windowStart(bucket, last, limit);
  const rows = await db.all<{ created_at: number; fee: string }>(
    "SELECT created_at, fee FROM charges WHERE created_at >= ?",
    [first * 1000],
  );
  const perBucket = new Map<number, { fee: bigint; charges: number }>();
  for (const row of rows) {
    const key = Math.floor(bucketStart(bucket, Math.floor(row.created_at / 1000)).getTime() / 1000);
    const current = perBucket.get(key) ?? { fee: 0n, charges: 0 };
    current.fee += BigInt(row.fee);
    current.charges += 1;
    perBucket.set(key, current);
  }

  // The window ends at the newest charge's bucket and starts `limit` buckets
  // earlier, or at the oldest charge's bucket when the history is shorter, so
  // the gap-filled range never exceeds the limit.
  const from = Math.max(first, Math.floor(oldest / 1000));
  const buckets: ProtocolFeeBucket[] = bucketStarts(bucket, from, last).map((start) => {
    const entry = perBucket.get(Math.floor(start.getTime() / 1000));
    return {
      bucket: bucketLabel(bucket, start),
      fee: String(entry?.fee ?? 0n),
      charges: entry?.charges ?? 0,
    };
  });

  let fee = 0n;
  let charges = 0;
  for (const b of buckets) {
    fee += BigInt(b.fee);
    charges += b.charges;
  }
  return { bucket, buckets, totals: { fee: String(fee), charges } };
}

/**
 * The start, in unix seconds, of the oldest of the `count` buckets that end
 * with the one `at` (unix seconds) falls in. Months step on the calendar, so
 * a window of months always starts on the first of a month.
 */
function windowStart(bucket: RevenueBucketSize, at: number, count: number): number {
  const last = bucketStart(bucket, at);
  const back = count - 1;
  if (bucket === "month") {
    return Math.floor(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - back, 1) / 1000);
  }
  const step = bucket === "day" ? 86_400 : 604_800;
  return Math.floor(last.getTime() / 1000) - back * step;
}

/** List active mandates currently eligible for settlement at `now`. */
export async function listDueMandates(
  db: Storage,
  now: number,
  limit: number,
): Promise<DueMandateRecord[]> {
  return db.all<DueMandateRecord>(
      `SELECT id, subscriber, merchant, plan_id, next_charge, amount
         FROM mandates
        WHERE status = 'Active' AND next_charge <= ?
          AND (max_charges = 0 OR charges_made < max_charges)
        ORDER BY next_charge ASC LIMIT ?`,
    [now, limit],
  );
}

/**
 * How many active mandates are eligible for settlement right now.
 *
 * The same predicate `listDueMandates` uses, counted instead of listed: an
 * operator wants the number ("are any mandates waiting?") without pulling
 * every row of the due list into memory.
 */
export async function countDueMandates(db: Storage, now: number): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM mandates
      WHERE status = 'Active' AND next_charge <= ?
        AND (max_charges = 0 OR charges_made < max_charges)`,
    [now],
  );
  if (!row) throw new Error("count due mandates query returned no result");
  return row.n;
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
export async function listLatestVaultBalances(
  db: Storage,
  addresses: string[],
): Promise<Map<string, Map<string, string>>> {
  const unique = [...new Set(addresses)];
  const balances = new Map<string, Map<string, string>>();
  if (unique.length === 0) return balances;
  const placeholders = unique.map(() => "?").join(",");
  const rows = await db.all<{
    user: string;
    token: string;
    balance: string;
  }>(
    // The placeholders are one "?" per de-duped address; the addresses
    // themselves are bound parameters, so no request data reaches the SQL
    // text.
    `SELECT e."user" AS user, e.token AS token, e.balance AS balance
       FROM vault_events e
      WHERE e."user" IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM vault_events newer
           WHERE newer."user" = e."user"
             AND newer.token = e.token
             AND (newer.ledger > e.ledger OR
                  (newer.ledger = e.ledger AND newer.tx_hash > e.tx_hash))
        )`,
    unique,
  );
  for (const row of rows) {
    const perToken = balances.get(row.user) ?? new Map<string, string>();
    perToken.set(row.token, row.balance);
    balances.set(row.user, perToken);
  }
  return balances;
}

/**
 * The last indexed vault balance each due mandate would be paid from, in row
 * order: the subscriber's balance of the mandate's plan token, or undefined
 * when none is indexed. A mandate carries no token of its own — it inherits
 * its plan's — so a batch of rows costs two reads, not two per row.
 */
export async function lastKnownBalances(
  db: Storage,
  rows: DueMandateRecord[],
): Promise<Array<string | undefined>> {
  const tokens = await planTokensByIds(db, rows.map((row) => row.plan_id));
  const balances = await listLatestVaultBalances(db, rows.map((row) => row.subscriber));
  return rows.map((row) => {
    const token = tokens.get(row.plan_id);
    return token ? balances.get(row.subscriber)?.get(token) : undefined;
  });
}

/**
 * Whether the last known vault balance covers a charge: the `funded` flag of
 * `/due`. Amounts are compared as bigints: a balance is a decimal string in
 * the token's smallest unit and must never round-trip through a JavaScript
 * number. A subscriber the projection has never seen holds nothing.
 */
export function isFunded(balance: string | undefined, amount: string): boolean {
  return balance !== undefined && BigInt(balance) >= BigInt(amount);
}

/** Due mandates read per step of the unpaid report; keeps each batch's `IN (...)` lists small. */
const UNPAID_PAGE = 200;

/**
 * A merchant's due mandates whose last known vault balance cannot cover the
 * charge, longest overdue first (ties by mandate id), at most `limit` of them.
 *
 * The due predicate is the one `/due` uses and the funded test is
 * {@link isFunded}, so a mandate is here exactly when `/due` reports it with
 * `funded: false`. The due mandates are walked in keyset pages over
 * `mandates_merchant_status_next_charge`, already in report order, and the
 * walk stops as soon as `limit` unpaid ones are found: the cost is O(D) for
 * the D due mandates read before then, never a scan of the merchant's whole
 * history, and memory is O(page + limit).
 */
export async function listMerchantUnpaidMandates(
  db: Storage,
  merchant: string,
  now: number,
  limit: number,
): Promise<UnpaidMandateRow[]> {
  // The keyset is spelled as a closed range on next_charge plus a tiebreak on
  // id, not as a row value: SQLite's planner (with no ANALYZE statistics)
  // then seeks the merchant's own index on both bounds instead of walking the
  // protocol-wide `mandates_due` index. test/db.test.ts pins the plan.
  const sql =
    `SELECT id, subscriber, merchant, next_charge, amount, plan_id
       FROM mandates
      WHERE merchant = ? AND status = 'Active'
        AND next_charge BETWEEN ? AND ?
        AND (next_charge > ? OR id > ?)
        AND (max_charges = 0 OR charges_made < max_charges)
      ORDER BY next_charge, id
      LIMIT ?`;
  const unpaid: UnpaidMandateRow[] = [];
  let after = { next_charge: -1, id: -1 };
  for (;;) {
    const rows = await db.all<DueMandateRecord>(
      sql,
      [merchant, after.next_charge, now, after.next_charge, after.id, UNPAID_PAGE],
    );
    const balances = await lastKnownBalances(db, rows);
    for (const [i, row] of rows.entries()) {
      const balance = balances[i];
      if (isFunded(balance, row.amount)) continue;
      // No indexed balance means the vault holds nothing of the token.
      const held = BigInt(balance ?? "0");
      unpaid.push({
        id: row.id,
        subscriber: row.subscriber,
        next_charge: row.next_charge,
        amount: row.amount,
        balance: String(held),
        shortfall: String(BigInt(row.amount) - held),
        overdue_seconds: now - row.next_charge,
      });
      if (unpaid.length === limit) return unpaid;
    }
    if (rows.length < UNPAID_PAGE) return unpaid;
    after = rows[rows.length - 1]!;
  }
}

/** Revenue per token: sums from charges and active mandates, joined via plans. */
export async function listMerchantTokenRevenue(
  db: Storage,
  merchant: string,
): Promise<TokenRevenue[]> {
  const collected = await db.all<{ token: string; amount: string }>(
    `SELECT p.token AS token, c.amount
       FROM charges c
       JOIN mandates m ON m.id = c.mandate_id
       JOIN plans p ON p.id = m.plan_id
      WHERE c.merchant = ?`,
    [merchant],
  );
  const recurring = await db.all<{ token: string; amount: string; period: number }>(
    `SELECT p.token AS token, m.amount, m.period
       FROM mandates m
       JOIN plans p ON p.id = m.plan_id
      WHERE m.merchant = ? AND m.status = 'Active' AND m.period > 0`,
    [merchant],
  );

  const tokens = new Map<string, { totalCollected: string; mrr: string }>();
  for (const row of collected) {
    const sums = tokens.get(row.token) ?? { totalCollected: "0", mrr: "0" };
    sums.totalCollected = (BigInt(sums.totalCollected) + BigInt(row.amount)).toString();
    tokens.set(row.token, sums);
  }
  for (const row of recurring) {
    const entry = tokens.get(row.token) ?? { totalCollected: "0", mrr: "0" };
    entry.mrr = (BigInt(entry.mrr) + (BigInt(row.amount) * BigInt(SECONDS_PER_MONTH)) / BigInt(row.period)).toString();
    tokens.set(row.token, entry);
  }
  return [...tokens]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([token, sums]) => ({ token, ...sums }));
}

/** Compute merchant revenue summary and per-token breakdown. */
export async function getMerchantSummary(
  db: Storage,
  merchant: string,
  defaultToken?: string,
): Promise<MerchantSummary> {
  const active = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM mandates WHERE merchant = ? AND status = 'Active'",
    [merchant],
  );
  const collected = await db.all<{ amount: string }>(
    "SELECT amount FROM charges WHERE merchant = ?",
    [merchant],
  );
  // Recurring revenue, normalised from each mandate's own period: MRR over a
  // 30-day month and ARR over a 365-day year. Integer division truncates,
  // which is fine at base-unit (stroop) scale.
  const recurring = await db.all<{ amount: string; period: number }>(
    "SELECT amount, period FROM mandates WHERE merchant = ? AND status = 'Active' AND period > 0",
    [merchant],
  );
  const collectedTotal = collected.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const mrr = recurring.reduce(
    (sum, row) => sum + (BigInt(row.amount) * BigInt(SECONDS_PER_MONTH)) / BigInt(row.period),
    0n,
  );
  const arr = recurring.reduce(
    (sum, row) => sum + (BigInt(row.amount) * BigInt(SECONDS_PER_YEAR)) / BigInt(row.period),
    0n,
  );

  // The flat totals stop at one token only when a default exists. Without
  // TOKEN_ID they keep the previous all-token meaning.
  const tokens = await listMerchantTokenRevenue(db, merchant);
  const scoped = defaultToken
    ? tokens.find((t) => t.token === defaultToken)
    : undefined;

  return {
    merchant,
    activeMandates: active?.n ?? 0,
      totalCollected: defaultToken ? (scoped?.totalCollected ?? "0") : collectedTotal.toString(),
      chargeCount: collected.length,
      mrr: defaultToken ? (scoped?.mrr ?? "0") : mrr.toString(),
      arr: arr.toString(),
    tokens,
  };
}

/** Active positive-period mandates for a merchant's revenue forecast. */
export function listMerchantForecastMandates(
  db: Storage,
  merchant: string,
): Promise<ForecastMandateRow[]> {
  return db.all<ForecastMandateRow>(
      `SELECT amount, period, next_charge, charges_made, max_charges, fee_bps
         FROM mandates WHERE merchant = ? AND status = 'Active' AND period > 0`,
    [merchant],
  );
}

/** Subscriber mandates and cumulative gross amount paid (amount + fee). */
export async function getSubscriberSummary(
  db: Storage,
  subscriber: string,
): Promise<SubscriberSummary> {
  const mandates = await db.all<MandateRow>(
    "SELECT * FROM mandates WHERE subscriber = ? ORDER BY id DESC",
    [subscriber],
  );
  const paid = await db.all<{ amount: string; fee: string }>(
    "SELECT amount, fee FROM charges WHERE subscriber = ?",
    [subscriber],
  );
  return {
    subscriber,
    mandates,
    totalPaid: paid.reduce((total, charge) => total + BigInt(charge.amount) + BigInt(charge.fee), 0n).toString(),
  };
}

/** The lifecycle events a churn report counts, in report order. */
export const CHURN_KINDS = ["started", "cancelled", "ended", "completed"] as const;

export type ChurnKind = (typeof CHURN_KINDS)[number];

function bucketSql(db: Storage, bucket: ChurnBucketSize): string {
  if (db.dialect === "sqlite") return BUCKET_SQL[bucket];
  if (bucket === "day") return "FLOOR(at / 86400.0)::BIGINT * 86400";
  if (bucket === "week") return "345600 + FLOOR((at - 345600) / 604800.0)::BIGINT * 604800";
  return "EXTRACT(EPOCH FROM DATE_TRUNC('month', TO_TIMESTAMP(at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::BIGINT";
}

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
export async function getMerchantChurn(
  db: Storage,
  merchant: string,
  bucket: ChurnBucketSize,
  limit: number,
): Promise<MerchantChurnResponse> {
  const rows = await db.all<{
    kind: ChurnKind;
    bucket: number;
    n: number;
  }>(
      // The bucket expression is a vetted static fragment chosen by the
      // bucket size, never request data; the address is a bound parameter,
      // so no request data reaches the SQL text.
      `SELECT kind, ${bucketSql(db, bucket)} AS bucket, COUNT(*) AS n
         FROM mandate_events
        WHERE merchant = ?
        GROUP BY kind, bucket`,
      [merchant],
    );

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
    entry[row.kind] = Number(row.n);
    if (Number(row.bucket) < min) min = Number(row.bucket);
    if (Number(row.bucket) > max) max = Number(row.bucket);
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

/**
 * A merchant's cohort retention (#142): mandates grouped by the bucket they
 * started in, and for each cohort how many were still active after 1, 2,
 * 3... buckets.
 *
 * Both ends come from `mandate_events`, stamped with ledger close times: a
 * mandate is active after k periods when it has no departure (cancelled,
 * ended or completed) before the start of the k-th bucket after its cohort's.
 * A period is reported once that bucket has begun by `now`, and at most
 * MAX_CHURN_BUCKETS of them per cohort; `limit` keeps the most recent cohorts.
 *
 * SQLite groups the mandates by (cohort, departure bucket) in one statement —
 * starts from the (merchant, kind, at) index, each departure by primary key —
 * so R ≤ C × (D + 1) rows reach JavaScript rather than one per mandate. The
 * walk is then O(R + limit × periods) with O(R) memory.
 */
export async function getMerchantCohorts(
  db: Storage,
  merchant: string,
  bucket: ChurnBucketSize,
  limit: number,
  now: number,
): Promise<MerchantCohortsResponse> {
  // The bucket expression is a vetted static fragment chosen by the
  // bucket size, never request data; the address is bound as a parameter.
  const bucketExpr = bucketSql(db, bucket);
  const rows = await db.all<{ cohort: number; departed: number | null; n: number }>(
    `SELECT cohort, ${bucketExpr} AS departed, COUNT(*) AS n
       FROM (SELECT ${bucketExpr} AS cohort, departed_at AS at
               FROM (SELECT s.at AS at, d.at AS departed_at
                       FROM mandate_events s
                       LEFT JOIN mandate_events d
                         ON d.mandate_id = s.mandate_id AND d.slot = 'departure'
                      WHERE s.merchant = ? AND s.kind = 'started'))
      GROUP BY cohort, departed`,
    [merchant],
  );

  const cohorts = new Map<number, { size: number; departures: Map<number, number> }>();
  for (const row of rows) {
    let entry = cohorts.get(row.cohort);
    if (!entry) {
      entry = { size: 0, departures: new Map() };
      cohorts.set(row.cohort, entry);
    }
    entry.size += row.n;
    if (row.departed !== null) entry.departures.set(row.departed, row.n);
  }

  const starts = [...cohorts.keys()].sort((a, b) => a - b).slice(-limit);
  return {
    merchant,
    bucket,
    cohorts: starts.map((start) => {
      const { size, departures } = cohorts.get(start)!;
      const retention: CohortRetention[] = [];
      let departed = 0;
      let period = new Date(start * 1000);
      for (let k = 1; k <= MAX_CHURN_BUCKETS; k += 1) {
        // Departures in the bucket that is ending count against period k.
        departed += departures.get(period.getTime() / 1000) ?? 0;
        period = nextBucketStart(bucket, period);
        if (period.getTime() > now * 1000) break;
        const active = size - departed;
        retention.push({ period: k, active, share: active / size });
      }
      return { cohort: bucketLabel(bucket, new Date(start * 1000)), size, retention };
    }),
  };
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
export async function getMerchantRevenue(
  db: Storage,
  merchant: string,
  bucket: RevenueBucketSize,
  from: number | undefined,
  to: number | undefined,
  limit: number,
): Promise<MerchantRevenueResponse> {
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

  const rows = await db.all<{
    bucket: number;
    gross: bigint;
    fee: bigint;
    charges: number;
  }>(
    // The bucket expression is a vetted static fragment chosen by the
    // bucket size and the predicates are fixed; the address and the range
    // are bound parameters, so no request data reaches the SQL text.
    `SELECT ${bucketSql(db, bucket)} AS bucket,
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
    args,
  );

  const perBucket = new Map<number, { gross: bigint; fee: bigint; charges: number }>();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    // The statement reads integers as bigint, so the bucket start is one too:
    // it is a timestamp, not an amount, and fits in a number.
    const start = Number(row.bucket);
    perBucket.set(start, {
      gross: BigInt(row.gross),
      fee: BigInt(row.fee),
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
export async function listMerchantSubscribers(
  db: Storage,
  merchant: string,
  limit: number,
): Promise<MerchantSubscriberAggregate[]> {
  const rows = await db.all<{
    subscriber: string;
    mandate_count: number;
    charge_count: number;
    total_collected: bigint;
  }>(
      // The address is a bound parameter, so no request data reaches the SQL text.
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
      [merchant, limit],
    );
  return rows.map((row) => ({
    // Counts are small; collected amounts remain bigint at base-unit scale.
    subscriber: row.subscriber,
    mandateCount: Number(row.mandate_count),
    chargeCount: Number(row.charge_count),
    totalCollected: BigInt(row.total_collected),
  }));
}

/** Active positive-period mandates for a subscriber's upcoming schedule. */
export function listSubscriberUpcomingMandates(
  db: Storage,
  subscriber: string,
): Promise<UpcomingMandateRow[]> {
  return db.all<UpcomingMandateRow>(
      `SELECT id, merchant, amount, period, next_charge, charges_made, max_charges
         FROM mandates WHERE subscriber = ? AND status = 'Active' AND period > 0`,
    [subscriber],
  );
}

/** Run an aggregate returning one `total` column; decimal string out. */
/** Protocol-wide counts, gross volume (24h and all-time), fees, and indexer cursor. */
export async function getProtocolStats(
  db: Storage,
  since: number,
): Promise<StatsResponse> {
  const one = async (sql: string): Promise<number> =>
    (await db.get<{ n: number }>(sql))?.n ?? 0;
  const [plans, mandates, activeMandates, charges, recentCharges, allCharges, activeMerchants, cursor] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM plans"),
    one("SELECT COUNT(*) AS n FROM mandates"),
    one("SELECT COUNT(*) AS n FROM mandates WHERE status = 'Active'"),
    one("SELECT COUNT(*) AS n FROM charges"),
    db.all<{ amount: string; fee: string }>("SELECT amount, fee FROM charges WHERE created_at >= ?", [since]),
    db.all<{ amount: string; fee: string }>("SELECT amount, fee FROM charges"),
    one("SELECT COUNT(DISTINCT merchant) AS n FROM mandates WHERE status = 'Active'"),
    db.get<{ last_ledger: number }>("SELECT last_ledger FROM cursor WHERE id = 1"),
  ]);
  const volume24h = recentCharges.reduce((sum, charge) => sum + BigInt(charge.amount) + BigInt(charge.fee), 0n);
  const volumeAllTime = allCharges.reduce((sum, charge) => sum + BigInt(charge.amount) + BigInt(charge.fee), 0n);
  const totalFees = allCharges.reduce((sum, charge) => sum + BigInt(charge.fee), 0n);
  return {
    plans,
    mandates,
    activeMandates,
    charges,
    volume24h: volume24h.toString(),
    volumeAllTime: volumeAllTime.toString(),
    totalFees: totalFees.toString(),
    activeMerchants,
    lastIndexedLedger: cursor?.last_ledger ?? 0,
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
export async function listRawContractEvents(
  db: Storage,
  ledger: number,
  eventId: string,
  contract: string | undefined,
  limit: number,
): Promise<RawContractEventRow[]> {
  if (contract === undefined) {
    return db.all<RawContractEventRow>(
      "SELECT event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time FROM events WHERE (ledger, event_id) > (?, ?) ORDER BY ledger, event_id LIMIT ?",
      [ledger, eventId, limit],
    );
  }
  return db.all<RawContractEventRow>(
    "SELECT event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time FROM events WHERE (ledger, event_id) > (?, ?) AND contract_id = ? ORDER BY ledger, event_id LIMIT ?",
    [ledger, eventId, contract, limit],
  );
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

export function listMandateTimeline(db: Storage, mandateId: number): Promise<MandateTimelineRow[]> {
  return db.all<MandateTimelineRow>(
    "SELECT mandate_id, tx_hash, kind, ledger, at, details FROM mandate_timeline WHERE mandate_id = ? ORDER BY ledger ASC, tx_hash ASC, kind ASC",
    [mandateId],
  );
}

/** Contract upgrade history. */
export interface ContractUpgradeRow {
  contract_id: string;
  tx_hash: string;
  ledger: number;
  close_time: number;
  new_hash: string;
  old_hash: string | null;
}

export async function listContractUpgrades(
  db: Storage,
  contractId?: string,
  limit: number = 100,
): Promise<ContractUpgradeRow[]> {
  if (contractId === undefined) {
    return db.all<ContractUpgradeRow>(
      "SELECT contract_id, tx_hash, ledger, close_time, new_hash, old_hash FROM contract_upgrades ORDER BY ledger DESC LIMIT ?",
      [limit],
    );
  }
  return db.all<ContractUpgradeRow>(
    "SELECT contract_id, tx_hash, ledger, close_time, new_hash, old_hash FROM contract_upgrades WHERE contract_id = ? ORDER BY ledger DESC LIMIT ?",
    [contractId, limit],
  );
}
