import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import {
  getMandateById,
  listDueMandates,
  listMandateCharges,
  listMandates,
} from "../lib/queries.ts";
import { limitOf } from "./helpers.ts";
import { sendApiError } from "./errors.ts";
import type {
  ChargePage,
  DuePage,
  MandatePage,
} from "./types.ts";

/** Upper bound on ids in one batch request. */
const MAX_IDS = 100;

/**
 * Parse `?ids=1,2,3`. Returns null when any token is not a positive integer
 * and `tooMany` when the raw list exceeds MAX_IDS — checked before de-duping,
 * so a client cannot send an unbounded list.
 */
function parseIds(raw: unknown): { ids: number[]; tooMany: boolean } | null {
  const tokens = String(raw).split(",");
  const ids: number[] = [];
  for (const token of tokens) {
    const text = token.trim();
    if (!/^\d+$/.test(text)) return null;
    const id = Number(text);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    ids.push(id);
  }
  return { ids: [...new Set(ids)], tooMany: tokens.length > MAX_IDS };
}

/** `GET /mandates*` and the keeper-facing `GET /due`. */
export function mandatesRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/mandates", (req, res) => {
    const { ids, subscriber, merchant, status } = req.query;
    let parsedIds: number[] | undefined;
    if (ids !== undefined) {
      const parsed = parseIds(ids);
      if (parsed === null) {
        sendApiError(res, req, 400, "invalid_ids");
        return;
      }
      if (parsed.tooMany) {
        sendApiError(res, req, 400, "too_many_ids");
        return;
      }
      parsedIds = parsed.ids;
    }
    const mandates = listMandates(db, {
      ids: parsedIds,
      subscriber: subscriber ? String(subscriber) : undefined,
      merchant: merchant ? String(merchant) : undefined,
      status: status ? String(status) : undefined,
      limit: limitOf(req.query.limit),
    });
    const body: MandatePage = { mandates };
    res.json(body);
  });

  r.get("/mandates/:id", (req, res) => {
    const row = getMandateById(db, Number(req.params.id));
    if (!row) {
      sendApiError(res, req, 404, "mandate_not_found");
      return;
    }
    res.json(row);
  });

  r.get("/mandates/:id/charges", (req, res) => {
    const charges = listMandateCharges(
      db,
      Number(req.params.id),
      limitOf(req.query.limit),
    );
    const body: ChargePage = { charges };
    res.json(body);
  });

  /** Mandates chargeable right now, per the indexed projection. */
  r.get("/due", (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const due = listDueMandates(db, now, limitOf(req.query.limit));
    const body: DuePage = { now, due };
    res.json(body);
  });

  return r;
}
