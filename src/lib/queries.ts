import type { Storage } from "./store/types.ts";
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
export async function listPlans(
  db: Storage,
  filter: ListPlansFilter,
): Promise<{ rows: PlanRow[]; nextCursorId: number | null }> {
  return cursorPage<PlanRow>(
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

  const total = Number(mandateCounts?.total_mandates ?? 0);
  return {
    planId,
    activeMandates: Number(mandateCounts?.active_mandates ?? 0),
    totalMandates: total,
    cancellations: Number(mandateCounts?.cancellations ?? 0),
    totalCollected: BigInt(revenue?.total_collected ?? 0),
    // Charges settled is a count, never an amount; safe to coerce to a number.
    totalCharges: Number(revenue?.total_charges ?? 0),
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

/** List charge events for a mandate ordered by ledger descending. */
export async function listMandateCharges(
  db: Storage,
  mandateId: number,
  limit: number,
): Promise<ChargeRow[]> {
    return db.all<ChargeRow>(
      "SELECT * FROM charges WHERE mandate_id = ? ORDER BY ledger DESC, tx_hash DESC LIMIT ?",
    [mandateId, limit],
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
  return { fee_bps: history[0]?.new_fee_bps ?? null, history };
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
