import { Router } from "express";
import type { Storage } from "../lib/store/types.ts";
import {
  getMandateById,
  listDueMandates,
  listMandateCharges,
  listMandates,
  planTokensByIds,
} from "../lib/queries.ts";
import type { TokenMetadataService } from "../lib/tokens.ts";
import { limitOf, tokenFields } from "./helpers.ts";
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
export function mandatesRouter(db: Storage, tokens: TokenMetadataService): Router {
  const r = Router();

  r.get("/mandates", async (req, res) => {
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
    const rows = await listMandates(db, {
      ids: parsedIds,
      subscriber: subscriber ? String(subscriber) : undefined,
      merchant: merchant ? String(merchant) : undefined,
      status: status ? String(status) : undefined,
      limit: limitOf(req.query.limit),
    });
    // A mandate carries no token of its own; it inherits its plan's, batched
    // into one read per page (see lib/queries.ts).
    const planTokens = await planTokensByIds(db, rows.map((row) => row.plan_id));
    const mandates = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        ...(await tokenFields(tokens, planTokens.get(row.plan_id))),
      })),
    );
    const body: MandatePage = { mandates };
    res.json(body);
  });

  r.get("/mandates/:id", async (req, res) => {
    const row = await getMandateById(db, Number(req.params.id));
    if (!row) {
      sendApiError(res, req, 404, "mandate_not_found");
      return;
    }
    const tokenId = (await planTokensByIds(db, [row.plan_id])).get(row.plan_id);
    res.json({ ...row, ...(await tokenFields(tokens, tokenId)) });
  });

  r.get("/mandates/:id/charges", async (req, res) => {
    const charges = await listMandateCharges(
      db,
      Number(req.params.id),
      limitOf(req.query.limit),
    );
    const body: ChargePage = { charges };
    res.json(body);
  });

  /** Mandates chargeable right now, per the indexed projection. */
  r.get("/due", async (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const due = await listDueMandates(db, now, limitOf(req.query.limit));
    const body: DuePage = { now, due };
    res.json(body);
  });

  return r;
}
