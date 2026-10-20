import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { getPlanById, getPlanStats, listPlans } from "../lib/queries.ts";
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
import type { PlanPage, PlanStatsResponse } from "./types.ts";

/**
 * `GET /plans` and `GET /plans/:id`.
 *
 * Each row's amount is in its token's smallest unit, so the response carries
 * the token's `symbol` and `decimals` alongside it (resolved from the token
 * contract, cached). When the contract cannot be read those are `null` and the
 * amount stays a string — the endpoint never fails just because RPC is down.
 */
export function plansRouter(db: DatabaseSync, tokens: TokenMetadataService): Router {
  const r = Router();

  r.get("/plans", async (req, res) => {
    const merchant = validate(
      req,
      res,
      "merchant",
      addressSchema.optional(),
      present(req.query.merchant),
    );
    if (!merchant.ok) return;
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

    const page = listPlans(db, {
      merchant: merchant.value,
      cursor: cursor.value,
      limit: limitOf(limit.value),
    });
    const plans = await Promise.all(
      page.rows.map(async (row) => ({ ...row, ...(await tokenFields(tokens, row.token)) })),
    );
    const body: PlanPage = {
      plans,
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
    const tokenId = row.token;
    res.json({ ...row, ...(await tokenFields(tokens, tokenId)) });
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
