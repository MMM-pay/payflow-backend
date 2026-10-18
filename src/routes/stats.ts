import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { getProtocolStats } from "../lib/queries.ts";

/** Window for /api/stats' recent-volume figure. */
const DAY_MS = 86_400_000;

/** `GET /stats`. */
export function statsRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/stats", (_req, res) => {
    // Volume is gross: the merchant's net amount plus the protocol fee. The
    // 24-hour window uses created_at, which is when the indexer saw the charge
    // -- charges carry no event timestamp of their own.
    const since = Date.now() - DAY_MS;
    res.json(getProtocolStats(db, since));
  });

  return r;
}
