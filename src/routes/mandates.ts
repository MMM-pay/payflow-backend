import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { TokenMetadataService } from "../lib/tokens.ts";
import { limitOf, tokenFields } from "./helpers.ts";
import type {
  ChargePage,
  ChargeRow,
  DueMandateRow,
  DuePage,
  MandatePage,
  MandateRow,
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

/**
 * A mandate row has no token column of its own: it inherits its plan's. This
 * fetches the token for every distinct plan id in one query, so a page of
 * mandates costs one read rather than one per row. Missing plans (a mandate
 * whose plan was not indexed) simply resolve to `null` metadata.
 */
function planTokenBy(db: DatabaseSync, planIds: number[]): Map<number, string> {
  const ids = [...new Set(planIds)];
  if (ids.length === 0) return new Map();
  const rows = db
    // `clause` is `?` placeholders only, one per de-duped numeric id; the ids
    // themselves are bound parameters, never interpolated.
    // eslint-disable-next-line no-restricted-syntax
    .prepare(`SELECT id, token FROM plans WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...(ids as never[])) as unknown as { id: number; token: string }[];
  return new Map(rows.map((row) => [row.id, row.token]));
}

/** `GET /mandates*` and the keeper-facing `GET /due`. */
export function mandatesRouter(db: DatabaseSync, tokens: TokenMetadataService): Router {
  const r = Router();

  r.get("/mandates", async (req, res) => {
    const { ids, subscriber, merchant, status } = req.query;
    const where: string[] = [];
    const args: unknown[] = [];
    if (ids !== undefined) {
      const parsed = parseIds(ids);
      if (parsed === null) {
        res.status(400).json({ error: "invalid_ids" });
        return;
      }
      if (parsed.tooMany) {
        res.status(400).json({ error: "too_many_ids" });
        return;
      }
      where.push(`id IN (${parsed.ids.map(() => "?").join(",")})`);
      args.push(...parsed.ids);
    }
    if (subscriber) {
      where.push("subscriber = ?");
      args.push(String(subscriber));
    }
    if (merchant) {
      where.push("merchant = ?");
      args.push(String(merchant));
    }
    if (status) {
      where.push("status = ?");
      args.push(String(status));
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(limitOf(req.query.limit));
    const rows = db
      // `clause` is assembled above from fixed predicates; every value is a
      // bound parameter, so this interpolation is structural, not user data.
      // eslint-disable-next-line no-restricted-syntax
      .prepare(`SELECT * FROM mandates ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...(args as never[])) as unknown as MandateRow[];
    const planTokens = planTokenBy(db, rows.map((row) => row.plan_id));
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
    const row = db
      .prepare("SELECT * FROM mandates WHERE id = ?")
      .get(Number(req.params.id)) as unknown as MandateRow | undefined;
    if (!row) {
      res.status(404).json({ error: "mandate_not_found" });
      return;
    }
    const tokenId = planTokenBy(db, [row.plan_id]).get(row.plan_id);
    res.json({ ...row, ...(await tokenFields(tokens, tokenId)) });
  });

  r.get("/mandates/:id/charges", (req, res) => {
    const rows = db
      .prepare("SELECT * FROM charges WHERE mandate_id = ? ORDER BY ledger DESC LIMIT ?")
      .all(Number(req.params.id), limitOf(req.query.limit));
    const body: ChargePage = { charges: rows as unknown as ChargeRow[] };
    res.json(body);
  });

  /** Mandates chargeable right now, per the indexed projection. */
  r.get("/due", (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const rows = db
      .prepare(
        `SELECT id, subscriber, merchant, next_charge, amount
           FROM mandates
          WHERE status = 'Active' AND next_charge <= ?
            AND (max_charges = 0 OR charges_made < max_charges)
          ORDER BY next_charge ASC LIMIT ?`,
      )
      .all(now, limitOf(req.query.limit));
    const body: DuePage = { now, due: rows as unknown as DueMandateRow[] };
    res.json(body);
  });

  return r;
}
