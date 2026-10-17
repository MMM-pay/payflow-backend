import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { TokenMetadataService } from "../lib/tokens.ts";
import { limitOf, tokenFields } from "./helpers.ts";
import type { PlanPage, PlanRow } from "./types.ts";

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
    const rows = merchant
      ? db
          .prepare("SELECT * FROM plans WHERE merchant = ? ORDER BY id DESC LIMIT ?")
          .all(String(merchant), limitOf(req.query.limit))
      : db
          .prepare("SELECT * FROM plans ORDER BY id DESC LIMIT ?")
          .all(limitOf(req.query.limit));
    const plans = await Promise.all(
      (rows as unknown as PlanRow[]).map(async (row) => ({
        ...row,
        ...(await tokenFields(tokens, row.token)),
      })),
    );
    const body: PlanPage = { plans };
    res.json(body);
  });

  r.get("/plans/:id", async (req, res) => {
    const row = db
      .prepare("SELECT * FROM plans WHERE id = ?")
      .get(Number(req.params.id)) as unknown as PlanRow | undefined;
    if (!row) {
      res.status(404).json({ error: "plan_not_found" });
      return;
    }
    res.json({ ...row, ...(await tokenFields(tokens, row.token)) });
  });

  return r;
}
