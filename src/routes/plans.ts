import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { getPlanById, listPlans } from "../lib/queries.ts";
import { limitOf } from "./helpers.ts";
import { sendApiError } from "./errors.ts";
import type { PlanPage } from "./types.ts";

/** `GET /plans` and `GET /plans/:id`. */
export function plansRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/plans", (req, res) => {
    const { merchant } = req.query;
    const plans = listPlans(db, {
      merchant: merchant ? String(merchant) : undefined,
      limit: limitOf(req.query.limit),
    });
    const body: PlanPage = { plans };
    res.json(body);
  });

  r.get("/plans/:id", (req, res) => {
    const row = getPlanById(db, Number(req.params.id));
    if (!row) {
      sendApiError(res, req, 404, "plan_not_found");
      return;
    }
    res.json(row);
  });

  return r;
}
