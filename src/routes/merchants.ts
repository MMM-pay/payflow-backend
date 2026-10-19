import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import {
  getMerchantSummary,
  listMerchantForecastMandates,
  listMerchantSubscribers,
} from "../lib/queries.ts";
import type {
  ForecastResponse,
  MerchantSubscribersResponse,
  MerchantSummary,
} from "./types.ts";
import { limitOf } from "./helpers.ts";

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

    const body = getMerchantSummary(db, address, defaultToken);
    cache.set(cacheKey, body);
    res.json(body);
  });

  /** The merchant's distinct subscribers, grouped by lifetime value. */
  r.get("/merchants/:address/subscribers", (req, res) => {
    const address = String(req.params.address);
    const body: MerchantSubscribersResponse = {
      merchant: address,
      subscribers: listMerchantSubscribers(db, address, limitOf(req.query.limit)).map(
        (sub) => ({ ...sub, totalCollected: sub.totalCollected.toString() }),
      ),
    };
    res.json(body);
  });

  /** Projected charges over the next `days`, net of the protocol fee. */
  r.get("/merchants/:address/forecast", (req, res) => {
    const address = String(req.params.address);
    const days = daysOf(req.query.days);
    const from = Math.floor(Date.now() / 1000);
    const to = from + days * DAY_S;

    const mandates = listMerchantForecastMandates(db, address);

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

