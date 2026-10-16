import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { SECONDS_PER_MONTH, SECONDS_PER_YEAR } from "./helpers.ts";
import type { ForecastResponse, MerchantSummary } from "./types.ts";

/**
 * Bounded LRU in-memory cache for merchant summaries.
 * Keeps memory bounded under high merchant concurrency while allowing
 * instant invalidation when the indexer applies an event for a merchant.
 */
export class MerchantSummaryCache {
  private readonly max: number;
  private readonly map = new Map<string, MerchantSummary>();

  constructor(max = 1_000) {
    this.max = max;
  }

  get(merchant: string): MerchantSummary | undefined {
    const entry = this.map.get(merchant);
    if (entry !== undefined) {
      this.map.delete(merchant);
      this.map.set(merchant, entry);
    }
    return entry;
  }

  set(merchant: string, summary: MerchantSummary): void {
    if (this.map.has(merchant)) {
      this.map.delete(merchant);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(merchant, summary);
  }

  invalidate(merchant: string): void {
    for (const key of [...this.map.keys()]) {
      if (key === merchant || key.startsWith(`${merchant}:`)) {
        this.map.delete(key);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export const defaultMerchantSummaryCache = new MerchantSummaryCache();

/** Revenue per token: sums from charges and active mandates, joined via plans. */
function tokensOf(
  db: DatabaseSync,
  merchant: string,
): { token: string; totalCollected: string; mrr: string }[] {
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

const DAY_S = 86_400;
/** Longest forecast horizon, to keep the arithmetic bounded. */
const MAX_FORECAST_DAYS = 365;

function daysOf(raw: unknown, fallback = 30): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), MAX_FORECAST_DAYS);
}

/**
 * How many times a mandate will charge in [from, to).
 *
 * Occurrences are `next_charge + k × period`; a `max_charges` of 0 means the
 * mandate never expires, otherwise the remaining allowance caps the count.
 * Occurrences before `from` are not re-counted here: a charge already due is
 * the keeper's business, not a projection.
 */
function occurrencesIn(
  m: { next_charge: number; period: number; charges_made: number; max_charges: number },
  from: number,
  to: number,
): number {
  if (m.period <= 0 || to <= from) return 0;
  const kStart = m.next_charge < from ? Math.ceil((from - m.next_charge) / m.period) : 0;
  let kEnd = Math.floor((to - 1 - m.next_charge) / m.period);
  if (m.max_charges > 0) kEnd = Math.min(kEnd, m.max_charges - m.charges_made - 1);
  return kEnd < kStart ? 0 : kEnd - kStart + 1;
}

/** `GET /merchants/:address/summary`. */
export function merchantsRouter(
  db: DatabaseSync,
  cache: MerchantSummaryCache = defaultMerchantSummaryCache,
  defaultToken?: string,
): Router {
  const r = Router();

  r.get("/merchants/:address/summary", (req, res) => {
    const address = String(req.params.address);
    const cacheKey = defaultToken ? `${address}:${defaultToken}` : address;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      res.json(cached);
      return;
    }

    const active = db
      .prepare(
        "SELECT COUNT(*) AS n FROM mandates WHERE merchant = ? AND status = 'Active'",
      )
      .get(address) as { n: number };
    const collected = db
      .prepare(
        "SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total, COUNT(*) AS n FROM charges WHERE merchant = ?",
      )
      .get(address) as { total: number; n: number };
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
      .get(address) as { mrr: number; arr: number };

    // The flat totals stop at one token only when a default exists. Without
    // TOKEN_ID they keep the previous all-token meaning.
    const tokens = tokensOf(db, address);
    const scoped = defaultToken
      ? tokens.find((t) => t.token === defaultToken)
      : undefined;

    const body: MerchantSummary = {
      merchant: address,
      activeMandates: active.n,
      totalCollected: defaultToken
        ? (scoped?.totalCollected ?? "0")
        : String(collected.total),
      chargeCount: collected.n,
      mrr: defaultToken ? (scoped?.mrr ?? "0") : String(recurring.mrr),
      arr: String(recurring.arr),
      tokens,
    };
    cache.set(cacheKey, body);
    res.json(body);
  });

  /** Projected charges over the next `days`, net of the protocol fee. */
  r.get("/merchants/:address/forecast", (req, res) => {
    const address = String(req.params.address);
    const days = daysOf(req.query.days);
    const from = Math.floor(Date.now() / 1000);
    const to = from + days * DAY_S;

    const mandates = db
      .prepare(
        `SELECT amount, period, next_charge, charges_made, max_charges, fee_bps
           FROM mandates WHERE merchant = ? AND status = 'Active' AND period > 0`,
      )
      .all(address) as {
      amount: string;
      period: number;
      next_charge: number;
      charges_made: number;
      max_charges: number;
      fee_bps: number;
    }[];

    let net = 0n;
    let counted = 0;
    for (const m of mandates) {
      const occurrences = occurrencesIn(m, from, to);
      if (occurrences === 0) continue;
      const perCharge = (BigInt(m.amount) * BigInt(10_000 - m.fee_bps)) / 10_000n;
      net += perCharge * BigInt(occurrences);
      counted += 1;
    }

    const body: ForecastResponse = {
      merchant: address,
      days,
      from,
      to,
      forecast: net.toString(),
      mandateCount: counted,
      assumptions: [
        "Only Active mandates are projected; paused, cancelled, and completed mandates are excluded.",
        "Charges count where they fall due in [from, to); one falling due exactly at `to` is excluded.",
        "Charges already due before `from` are not counted here — see /api/due and the charge history.",
        "Each occurrence is net of the mandate's fee_bps: amount × (10000 − fee_bps) ÷ 10000.",
        "Vault funding is not modelled; an underfunded vault will not settle on schedule.",
        "A mandate with max_charges > 0 stops being projected once charges_made reaches the cap.",
      ],
    };
    res.json(body);
  });

  return r;
}

