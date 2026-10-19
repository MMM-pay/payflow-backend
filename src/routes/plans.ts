import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { getPlanById, getPlanStats, listPlans } from "../lib/queries.ts";
import type { TokenMetadataService } from "../lib/tokens.ts";
import { limitOf, tokenFields } from "./helpers.ts";
import { sendApiError } from "./errors.ts";
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
    const { merchant } = req.query;
    const plans = await Promise.all(
      listPlans(db, {
        merchant: merchant ? String(merchant) : undefined,
        limit: limitOf(req.query.limit),
      }).map(async (row) => ({ ...row, ...(await tokenFields(tokens, row.token)) })),
    );
    const body: PlanPage = { plans };
    res.json(body);
  });

  r.get("/plans/:id", async (req, res) => {
    const row = getPlanById(db, Number(req.params.id));
    if (!row) {
      sendApiError(res, req, 404, "plan_not_found");
      return;
    }
    res.json({ ...row, ...(await tokenFields(tokens, row.token)) });
  });

  /** `GET /plans/:id/stats`: active and total mandates, cancellations, gross
   * collected, and average charges per mandate. */
  r.get("/plans/:id/stats", (req, res) => {
    const planId = Number(req.params.id);
    // A plan id is a positive integer; anything else cannot name a plan.
    if (!Number.isInteger(planId) || planId <= 0) {
      sendApiError(res, req, 404, "plan_not_found");
      return;
    }
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
