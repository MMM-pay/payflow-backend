import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import {
  getMandateById,
  listDueMandates,
  listLatestVaultBalances,
  listMandateCharges,
  listMandates,
  planTokensByIds,
} from "../lib/queries.ts";
import type { TokenMetadataService } from "../lib/tokens.ts";
import { limitOf, tokenFields } from "./helpers.ts";
import { sendApiError } from "./errors.ts";
import {
  addressSchema,
  idSchema,
  limitSchema,
  mandateStatusSchema,
  present,
  validate,
} from "./validate.ts";
import type {
  ChargePage,
  DueMandateRow,
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
export function mandatesRouter(db: DatabaseSync, tokens: TokenMetadataService): Router {
  const r = Router();

  r.get("/mandates", async (req, res) => {
    const { ids } = req.query;
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
    const subscriber = validate(
      req,
      res,
      "subscriber",
      addressSchema.optional(),
      present(req.query.subscriber),
    );
    if (!subscriber.ok) return;
    const merchant = validate(
      req,
      res,
      "merchant",
      addressSchema.optional(),
      present(req.query.merchant),
    );
    if (!merchant.ok) return;
    const status = validate(
      req,
      res,
      "status",
      mandateStatusSchema.optional(),
      present(req.query.status),
    );
    if (!status.ok) return;
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    const rows = listMandates(db, {
      ids: parsedIds,
      subscriber: subscriber.value,
      merchant: merchant.value,
      status: status.value,
      limit: limitOf(limit.value),
    });
    // A mandate carries no token of its own; it inherits its plan's, batched
    // into one read per page (see lib/queries.ts).
    const planTokens = planTokensByIds(db, rows.map((row) => row.plan_id));
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
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;

    const row = getMandateById(db, id.value);
    if (!row) {
      sendApiError(res, req, 404, "mandate_not_found");
      return;
    }
    const tokenId = planTokensByIds(db, [row.plan_id]).get(row.plan_id);
    res.json({ ...row, ...(await tokenFields(tokens, tokenId)) });
  });

  r.get("/mandates/:id/charges", (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    // A mandate that does not exist has no charges: the same 404 the
    // mandate's own route answers, so a caller cannot mistake "no such
    // mandate" for "no charges yet".
    if (!getMandateById(db, id.value)) {
      sendApiError(res, req, 404, "mandate_not_found");
      return;
    }

    const charges = listMandateCharges(db, id.value, limitOf(limit.value));
    const body: ChargePage = { charges };
    res.json(body);
  });

  /**
   * Mandates chargeable right now, per the indexed projection.
   *
   * Each one carries `funded`: whether the last known vault balance covers
   * the charge. The balance is the one the indexer last saw, so it can be
   * behind the chain — the keeper reads it from the contract before it
   * settles — but it is enough to tell a mandate that is merely due from one
   * that is waiting for a top-up.
   */
  r.get("/due", (req, res) => {
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    const now = Math.floor(Date.now() / 1000);
    const rows = listDueMandates(db, now, limitOf(limit.value));
    // A mandate carries no token of its own; it inherits its plan's, and the
    // vault balance is per (subscriber, token).
    const tokens = planTokensByIds(db, rows.map((row) => row.plan_id));
    const balances = listLatestVaultBalances(
      db,
      rows.map((row) => row.subscriber),
    );

    const due: DueMandateRow[] = rows.map((row) => {
      const token = tokens.get(row.plan_id);
      const balance = token ? balances.get(row.subscriber)?.get(token) : undefined;
      return {
        id: row.id,
        subscriber: row.subscriber,
        merchant: row.merchant,
        next_charge: row.next_charge,
        amount: row.amount,
        // Amounts are compared as bigints: a balance is a decimal string in
        // the token's smallest unit and must never round-trip through a
        // JavaScript number.
        funded: balance !== undefined && BigInt(balance) >= BigInt(row.amount),
      };
    });
    const body: DuePage = { now, due };
    res.json(body);
  });

  return r;
}
