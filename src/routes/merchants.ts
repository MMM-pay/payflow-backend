import { Router } from "express";
import type { Storage } from "../lib/store/types.ts";
import {
  getMerchantSummary,
  listMerchantForecastMandates,
  listMerchantSubscribers,
  getMerchantChurn,
  getMerchantRevenue,
} from "../lib/queries.ts";
import { churnBucketSize } from "../lib/churn.ts";
import type {
  ForecastResponse,
  MerchantChurnResponse,
  MerchantRevenueResponse,
  MerchantSubscribersResponse,
  MerchantSummary,
} from "./types.ts";
import {
  DEFAULT_REVENUE_BUCKETS,
  limitOf,
  MAX_CHURN_BUCKETS,
  MAX_REVENUE_BUCKETS,
} from "./helpers.ts";
import {
  addressSchema,
  bucketSchema,
  daysSchema,
  limitSchema,
  present,
  unixSecondsSchema,
  validate,
} from "./validate.ts";

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
/** Buckets reported by the churn endpoint when the caller does not say. */
const DEFAULT_CHURN_BUCKETS = 12;

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
  db: Storage,
  cache: MerchantSummaryCache = defaultMerchantSummaryCache,
  defaultToken?: string,
): Router {
  const r = Router();

  r.get("/merchants/:address/summary", async (req, res) => {
    const address = validate(req, res, "address", addressSchema, req.params.address);
    if (!address.ok) return;

    const cacheKey = defaultToken ? `${address.value}:${defaultToken}` : address.value;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      res.json(cached);
      return;
    }

  const body = await getMerchantSummary(db, address.value, defaultToken);
    cache.set(cacheKey, body);
    res.json(body);
  });

  /** The merchant's distinct subscribers, grouped by lifetime value. */
  r.get("/merchants/:address/subscribers", async (req, res) => {
    const address = validate(req, res, "address", addressSchema, req.params.address);
    if (!address.ok) return;
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    const subscribers = await listMerchantSubscribers(db, address.value, limitOf(limit.value));
    const body: MerchantSubscribersResponse = {
      merchant: address.value,
      subscribers: subscribers.map(
        (sub) => ({ ...sub, totalCollected: sub.totalCollected.toString() }),
      ),
    };
    res.json(body);
  });

  /**
   * `GET /merchants/:address/churn?bucket=month`: how many mandates started
   * and departed in each time bucket.
   *
   * `bucket` picks the period (`day`, `week` or `month`; `month` by default)
   * and `limit` how many of the most recent buckets to report. The counts are
   * bucketed by the ledger close time of each event, so they are the chain's
   * own history rather than the indexer's view of it.
   */
  r.get("/merchants/:address/churn", async (req, res) => {
    const address = validate(req, res, "address", addressSchema, req.params.address);
    if (!address.ok) return;
    const bucket = validate(req, res, "bucket", bucketSchema.optional(), present(req.query.bucket));
    if (!bucket.ok) return;
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    const body: MerchantChurnResponse = await getMerchantChurn(
      db,
      address.value,
      churnBucketSize(bucket.value),
      Math.min(limitOf(limit.value, DEFAULT_CHURN_BUCKETS), MAX_CHURN_BUCKETS),
    );
    res.json(body);
  });

  /**
   * `GET /merchants/:address/revenue?bucket=day|week&from=&to=`: what the
   * merchant took in, what the protocol took and what was left, over time.
   *
   * The buckets are calendar periods in UTC, taken from the close time of
   * the ledger each charge was emitted in, so the report is the chain's own
   * history rather than the indexer's view of it. `from` and `to` bound the
   * range in unix seconds; without them the report covers the merchant's
   * whole history.
   */
  r.get("/merchants/:address/revenue", async (req, res) => {
    const address = validate(req, res, "address", addressSchema, req.params.address);
    if (!address.ok) return;
    const bucket = validate(req, res, "bucket", bucketSchema.optional(), present(req.query.bucket));
    if (!bucket.ok) return;
    const from = validate(req, res, "from", unixSecondsSchema.optional(), present(req.query.from));
    if (!from.ok) return;
    const to = validate(req, res, "to", unixSecondsSchema.optional(), present(req.query.to));
    if (!to.ok) return;
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    const body: MerchantRevenueResponse = await getMerchantRevenue(
      db,
      address.value,
      churnBucketSize(bucket.value),
      from.value,
      to.value,
      limit.value === undefined
        ? DEFAULT_REVENUE_BUCKETS
        : Math.min(limit.value, MAX_REVENUE_BUCKETS),
    );
    res.json(body);
  });

  /** Projected charges over the next `days`, net of the protocol fee. */
  r.get("/merchants/:address/forecast", async (req, res) => {
    const address = validate(req, res, "address", addressSchema, req.params.address);
    if (!address.ok) return;
    const days = validate(req, res, "days", daysSchema.optional(), present(req.query.days));
    if (!days.ok) return;

    const window = daysOf(days.value);
    const from = Math.floor(Date.now() / 1000);
    const to = from + window * DAY_S;

    const mandates = await listMerchantForecastMandates(db, address.value);

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
      merchant: address.value,
      days: window,
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

