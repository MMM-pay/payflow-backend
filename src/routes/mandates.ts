import { Router } from "express";
import type { Storage } from "../lib/store/types.ts";
import {
  getVaultBalances,
  getMandateById,
  listDueMandates,
  listMandateCharges,
  listMandates,
  planTokensByIds,
} from "../lib/queries.ts";
import type { TokenMetadataService } from "../lib/tokens.ts";
import { encodeCursor, limitOf, tokenFields } from "./helpers.ts";
import { sendApiError } from "./errors.ts";
import {
  addressSchema,
  cursorSchema,
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

  r.get("/mandates/:id/charges", async (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    if (!(await getMandateById(db, id.value))) {
      sendApiError(res, req, 404, "mandate_not_found");
      return;
    }
    const charges = await listMandateCharges(db, id.value, limitOf(limit.value));
    const body: ChargePage = { charges };
    res.json(body);
  });

  /** Mandates chargeable right now, per the indexed projection. */
  r.get("/due", async (req, res) => {
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    const now = Math.floor(Date.now() / 1000);
    const due = await listDueMandates(db, now, limitOf(limit.value));
    const planTokens = await planTokensByIds(db, due.map((mandate) => mandate.plan_id));
    const balances = new Map<string, bigint>();
    const subscribers = [...new Set(due.map((mandate) => mandate.subscriber))];
    await Promise.all(
      subscribers.map(async (subscriber) => {
        const vaultBalances = await getVaultBalances(db, subscriber);
        for (const balance of vaultBalances) {
          balances.set(`${subscriber}|${balance.token}`, BigInt(balance.balance));
        }
      }),
    );
    const body: DuePage = {
      now,
      due: due.map((mandate) => {
        const token = planTokens.get(mandate.plan_id);
        const balance = token ? balances.get(`${mandate.subscriber}|${token}`) : undefined;
        const row: DueMandateRow = {
          id: mandate.id,
          subscriber: mandate.subscriber,
          merchant: mandate.merchant,
          next_charge: mandate.next_charge,
          amount: mandate.amount,
          funded: balance !== undefined && balance >= BigInt(mandate.amount),
        };
        return row;
      }),
    };
    res.json(body);
  });

  return r;
}
