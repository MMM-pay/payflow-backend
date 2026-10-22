import { Router } from "express";
import type { Storage } from "../lib/store/types.ts";
import { churnBucketSize } from "../lib/churn.ts";
import { getProtocolFeeHistory, getProtocolFees } from "../lib/queries.ts";
import { DEFAULT_REVENUE_BUCKETS, MAX_REVENUE_BUCKETS } from "./helpers.ts";
import { bucketSchema, limitSchema, present, validate } from "./validate.ts";
import type { ProtocolFeesResponse, ProtocolResponse } from "./types.ts";

/** `GET /protocol`: latest indexed fee and its change history. */
export function protocolRouter(db: Storage): Router {
  const r = Router();

  r.get("/protocol", async (_req, res) => {
    const body: ProtocolResponse = await getProtocolFeeHistory(db);
    res.json(body);
  });

  /**
   * `GET /protocol/fees?bucket=day|week|month`: the protocol's fee income per
   * calendar bucket of the ledger close time each charge was emitted in.
   *
   * `bucket` defaults to `month`, and `limit` is how many of the most recent
   * buckets to report, capped like the merchant revenue report's.
   */
  r.get("/protocol/fees", async (req, res) => {
    const bucket = validate(req, res, "bucket", bucketSchema.optional(), present(req.query.bucket));
    if (!bucket.ok) return;
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    const body: ProtocolFeesResponse = await getProtocolFees(
      db,
      churnBucketSize(bucket.value),
      limit.value === undefined
        ? DEFAULT_REVENUE_BUCKETS
        : Math.min(limit.value, MAX_REVENUE_BUCKETS),
    );
    res.json(body);
  });

  return r;
}
