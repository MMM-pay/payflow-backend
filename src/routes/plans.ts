import { Router } from "express";
import type { Storage } from "../lib/store/types.ts";
import { getPlanById, listPlans } from "../lib/queries.ts";
import type { TokenMetadataService } from "../lib/tokens.ts";
import { limitOf, tokenFields } from "./helpers.ts";
import { sendApiError } from "./errors.ts";
import type { PlanPage } from "./types.ts";

/**
 * `GET /plans` and `GET /plans/:id`.
 *
 * Each row's amount is in its token's smallest unit, so the response carries
 * the token's `symbol` and `decimals` alongside it (resolved from the token
 * contract, cached). When the contract cannot be read those are `null` and the
 * amount stays a string — the endpoint never fails just because RPC is down.
 */
export function plansRouter(db: Storage, tokens: TokenMetadataService): Router {
  const r = Router();

  r.get("/plans", async (req, res) => {
    const { merchant } = req.query;
    const plans = await Promise.all(
      (await listPlans(db, {
        merchant: merchant ? String(merchant) : undefined,
        limit: limitOf(req.query.limit),
      })).map(async (row) => ({ ...row, ...(await tokenFields(tokens, row.token)) })),
    );
    const body: PlanPage = { plans };
    res.json(body);
  });

  r.get("/plans/:id", async (req, res) => {
    const row = await getPlanById(db, Number(req.params.id));
    if (!row) {
      sendApiError(res, req, 404, "plan_not_found");
      return;
    }
    res.json({ ...row, ...(await tokenFields(tokens, row.token)) });
  });

  return r;
}
