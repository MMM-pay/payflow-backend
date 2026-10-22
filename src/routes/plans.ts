import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import {
  getPlanById,
  getPlanStats,
  listPlans,
  listPlansBySubscribers,
  merchantNamesByAddress,
} from "../lib/queries.ts";
import type { TokenMetadataService } from "../lib/tokens.ts";
import { encodeCursor, limitOf, tokenFields } from "./helpers.ts";
import { sendApiError } from "./errors.ts";
import {
  addressSchema,
  cursorSchema,
  idSchema,
  limitSchema,
  present,
  validate,
} from "./validate.ts";
import { z } from "zod";
import type { PlanPage, PlanRow, PlanStatsResponse } from "./types.ts";

/** The orders `GET /plans?sort=` accepts besides the default, newest first. */
const planSortSchema = z.enum(["subscribers"]);

/**
 * `GET /plans` and `GET /plans/:id`.
 *
 * Each row's amount is in its token's smallest unit, so the response carries
 * the token's `symbol` and `decimals` alongside it (resolved from the token
 * contract, cached). When the contract cannot be read those are `null` and the
 * amount stays a string — the endpoint never fails just because RPC is down.
 * Each row also carries the merchant's self-declared display name, or `null`.
 */
export function plansRouter(db: DatabaseSync, tokens: TokenMetadataService): Router {
  const r = Router();

  /** Join the token metadata and the merchant's display name onto a page of plans. */
  const enrich = async (rows: PlanRow[]): Promise<PlanRow[]> => {
    const names = merchantNamesByAddress(db, rows.map((row) => row.merchant));
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        ...(await tokenFields(tokens, row.token)),
        merchantName: names.get(row.merchant) ?? null,
      })),
    );
  };

  r.get("/plans", async (req, res) => {
    const merchant = validate(
      req,
      res,
      "merchant",
      addressSchema.optional(),
      present(req.query.merchant),
    );
    if (!merchant.ok) return;
    const q = validate(
      req,
      res,
      "q",
      z.string().optional(),
      present(req.query.q),
    );
    if (!q.ok) return;
    const cursor = validate(
      req,
      res,
      "cursor",
      cursorSchema.optional(),
      present(req.query.cursor),
    );
    if (!cursor.ok) return;
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;
    const sort = validate(req, res, "sort", planSortSchema.optional(), present(req.query.sort));
    if (!sort.ok) return;

    // The most popular plans: one ranked page of `limit` plans. A cursor names
    // a position in the newest-first order, which this ranking does not have,
    // so combining the two is refused rather than silently ignored.
    if (sort.value === "subscribers") {
      if (cursor.value !== undefined) {
        sendApiError(res, req, 400, "invalid_request", undefined, [
          { path: "cursor", message: "is not supported with sort=subscribers" },
        ]);
        return;
      }
      const rows = listPlansBySubscribers(db, {
        merchant: merchant.value,
        q: q.value,
        limit: limitOf(limit.value),
      });
      const body: PlanPage = { plans: await enrich(rows), nextCursor: null };
      res.json(body);
      return;
    }

    const page = listPlans(db, {
      merchant: merchant.value,
      q: q.value,
      cursor: cursor.value,
      limit: limitOf(limit.value),
    });
    const body: PlanPage = {
      plans: await enrich(page.rows),
      nextCursor: page.nextCursorId === null ? null : encodeCursor(page.nextCursorId),
    };
    res.json(body);
  });

  r.get("/plans/:id", async (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;

    const row = getPlanById(db, id.value);
    if (!row) {
      sendApiError(res, req, 404, "plan_not_found");
      return;
    }
    const [plan] = await enrich([row]);
    res.json(plan);
  });

  /** `GET /plans/:id/stats`: active and total mandates, cancellations, gross
   * collected, and average charges per mandate. */
  r.get("/plans/:id/stats", (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;
    const planId = id.value;

    if (!getPlanById(db, planId)) {
      sendApiError(res, req, 404, "plan_not_found");
      return;
    }
    const stats = getPlanStats(db, planId);
    const body: PlanStatsResponse = {
      planId,
      activeMandates: stats.activeMandates,
      totalMandates: stats.totalMandates,
      cancellations: stats.cancellations,
      totalCollected: String(stats.totalCollected),
      totalCharges: stats.totalCharges,
      // A plan with no mandates has no average; report 0 rather than NaN.
      averageChargesPerMandate:
        stats.totalMandates === 0 ? 0 : stats.totalCharges / stats.totalMandates,
    };
    res.json(body);
  });

  return r;
}
