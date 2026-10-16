import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { SECONDS_PER_MONTH, SECONDS_PER_YEAR } from "./helpers.ts";
import type { MerchantSummary } from "./types.ts";

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

  return r;
}
