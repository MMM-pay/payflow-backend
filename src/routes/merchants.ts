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
    this.map.delete(merchant);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export const defaultMerchantSummaryCache = new MerchantSummaryCache();

/** `GET /merchants/:address/summary`. */
export function merchantsRouter(
  db: DatabaseSync,
  cache: MerchantSummaryCache = defaultMerchantSummaryCache,
): Router {
  const r = Router();

  r.get("/merchants/:address/summary", (req, res) => {
    const address = String(req.params.address);
    const cached = cache.get(address);
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

    const body: MerchantSummary = {
      merchant: address,
      activeMandates: active.n,
      totalCollected: String(collected.total),
      chargeCount: collected.n,
      mrr: String(recurring.mrr),
      arr: String(recurring.arr),
    };
    cache.set(address, body);
    res.json(body);
  });

  return r;
}
