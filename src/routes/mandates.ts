import { Router } from "express";
import type { Storage } from "../lib/store/types.ts";
import {
  getMandateById,
  isFunded,
  lastKnownBalances,
  listChargeAttempts,
  listDueMandates,
  listMandateCharges,
  listMandateTimeline,
  listMandates,
  planTokensByIds,
} from "../lib/queries.ts";
import type { TokenMetadataService } from "../lib/tokens.ts";
import { encodeCursor, limitOf, tokenFields } from "./helpers.ts";
import { sendApiError } from "./errors.ts";
import {
  addressSchema,
  cursorSchema,
  dateBoundSchema,
  idSchema,
  limitSchema,
  mandateStatusSchema,
  present,
  validate,
} from "./validate.ts";
import type {
  ChargeAttemptPage,
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
export function mandatesRouter(db: Storage, tokens: TokenMetadataService): Router {
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

    const page = await listMandates(db, {
      ids: parsedIds,
      subscriber: subscriber.value,
      merchant: merchant.value,
      status: status.value,
      cursor: cursor.value,
      limit: limitOf(limit.value),
    });
    // A mandate carries no token of its own; it inherits its plan's, batched
    // into one read per page (see lib/queries.ts).
    const planTokens = await planTokensByIds(db, page.rows.map((row) => row.plan_id));
    const mandates = await Promise.all(
      page.rows.map(async (row) => ({
        ...row,
        ...(await tokenFields(tokens, planTokens.get(row.plan_id))),
      })),
    );
    const body: MandatePage = {
      mandates,
      nextCursor: page.nextCursorId === null ? null : encodeCursor(page.nextCursorId),
    };
    res.json(body);
  });

  r.get("/mandates/:id", async (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;

    const row = await getMandateById(db, id.value);
    if (!row) {
      sendApiError(res, req, 404, "mandate_not_found");
      return;
    }
    const tokenId = (await planTokensByIds(db, [row.plan_id])).get(row.plan_id);
    res.json({ ...row, ...(await tokenFields(tokens, tokenId)) });
  });

  r.get("/mandates/:id/timeline", async (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;
    if (!(await getMandateById(db, id.value))) {
      sendApiError(res, req, 404, "mandate_not_found");
      return;
    }
    const events = (await listMandateTimeline(db, id.value)).map((event) => ({
      mandateId: event.mandate_id,
      txHash: event.tx_hash,
      kind: event.kind,
      ledger: event.ledger,
      at: event.at,
      details: JSON.parse(event.details) as Record<string, string | boolean>,
    }));
    res.json({ events });
  });
  r.get("/mandates/:id/charges", async (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;
    const from = validate(
      req,
      res,
      "from",
      dateBoundSchema("from").optional(),
      present(req.query.from),
    );
    if (!from.ok) return;
    const to = validate(req, res, "to", dateBoundSchema("to").optional(), present(req.query.to));
    if (!to.ok) return;
    if (from.value !== undefined && to.value !== undefined && from.value > to.value) {
      sendApiError(res, req, 400, "invalid_request", "The date range is not valid.", [
        { path: "from", message: "must not be after `to`" },
      ]);
      return;
    }

    if (!(await getMandateById(db, id.value))) {
      sendApiError(res, req, 404, "mandate_not_found");
      return;
    }
    const charges = await listMandateCharges(
      db,
      id.value,
      limitOf(limit.value),
      from.value,
      to.value,
    );
    const body: ChargePage = { charges };
    res.json(body);
  });

  /**
   * The keeper's attempts to charge the mandate, newest first: when, how it
   * ended, the error code and transaction hash, and the backoff that
   * followed. Answers "why wasn't I charged?" for 90 days back.
   */
  r.get("/mandates/:id/attempts", async (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    if (!(await getMandateById(db, id.value))) {
      sendApiError(res, req, 404, "mandate_not_found");
      return;
    }

    const body: ChargeAttemptPage = {
      attempts: await listChargeAttempts(db, id.value, limitOf(limit.value)),
    };
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
  r.get("/due", async (req, res) => {
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    const now = Math.floor(Date.now() / 1000);
    const rows = await listDueMandates(db, now, limitOf(limit.value));
    // The vault balance is per (subscriber, token), and a mandate inherits its
    // plan's token; the merchant unpaid report shares this funded test.
    const balances = await lastKnownBalances(db, rows);

    const due: DueMandateRow[] = rows.map((row, i) => ({
      id: row.id,
      subscriber: row.subscriber,
      merchant: row.merchant,
      next_charge: row.next_charge,
      amount: row.amount,
      funded: isFunded(balances[i], row.amount),
    }));
    const body: DuePage = { now, due };
    res.json(body);
  });

  return r;
}
