import type { Storage } from "./store/types.ts";
import { SECONDS_PER_MONTH, SECONDS_PER_YEAR } from "../routes/helpers.ts";
import type {
  ChargeRow,
  DueMandateRow,
  ProtocolResponse,
  MandateRow,
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
export async function listPlans(db: Storage, filter: ListPlansFilter): Promise<PlanRow[]> {
  const rows = filter.merchant
    ? await db.all("SELECT * FROM plans WHERE merchant = ? ORDER BY id DESC LIMIT ?", [filter.merchant, filter.limit])
    : await db.all("SELECT * FROM plans ORDER BY id DESC LIMIT ?", [filter.limit]);
  return rows as PlanRow[];
}

/** Look up a single plan by on-chain id. */
export async function getPlanById(db: Storage, id: number): Promise<PlanRow | undefined> {
  return db.get<PlanRow>("SELECT * FROM plans WHERE id = ?", [id]);
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

/** List mandates ordered newest-first with optional id batch, subscriber, merchant, and status filters. */
export async function listMandates(
  db: Storage,
  filter: ListMandatesFilter,
): Promise<MandateRow[]> {
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
  const rows = await db.all<MandateRow>(
    `SELECT * FROM mandates ${clause} ORDER BY id DESC LIMIT ?`,
    args,
  );
  return rows;
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
): Promise<DueMandateRow[]> {
  return db.all<DueMandateRow>(
      `SELECT id, subscriber, merchant, next_charge, amount
         FROM mandates
        WHERE status = 'Active' AND next_charge <= ?
          AND (max_charges = 0 OR charges_made < max_charges)
        ORDER BY next_charge ASC LIMIT ?`,
    [now, limit],
  );
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
