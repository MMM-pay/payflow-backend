import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { readCursor } from "../lib/db.ts";
import type { StatsResponse } from "./types.ts";

/** Window for /api/stats' recent-volume figure. */
const DAY_MS = 86_400_000;

/** Run an aggregate returning one `total` column; decimal string out. */
function sumOf(db: DatabaseSync, sql: string, ...args: unknown[]): string {
  const stmt = db.prepare(sql);
  // Read as bigint so a large sum never round-trips through a JS number.
  stmt.setReadBigInts(true);
  const row = stmt.get(...(args as never[])) as { total: bigint } | undefined;
  return String(row?.total ?? 0n);
}

/** `GET /stats`. */
export function statsRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/stats", (_req, res) => {
    const one = (sql: string): number =>
      (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
    // Volume is gross: the merchant's net amount plus the protocol fee. The
    // 24-hour window uses created_at, which is when the indexer saw the charge
    // -- charges carry no event timestamp of their own.
    const since = Date.now() - DAY_MS;
    const body: StatsResponse = {
      plans: one("SELECT COUNT(*) AS n FROM plans"),
      mandates: one("SELECT COUNT(*) AS n FROM mandates"),
      activeMandates: one("SELECT COUNT(*) AS n FROM mandates WHERE status = 'Active'"),
      charges: one("SELECT COUNT(*) AS n FROM charges"),
      volume24h: sumOf(
        db,
        "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges WHERE created_at >= ?",
        since,
      ),
      volumeAllTime: sumOf(
        db,
        "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges",
      ),
      totalFees: sumOf(
        db,
        "SELECT COALESCE(SUM(CAST(fee AS INTEGER)), 0) AS total FROM charges",
      ),
      activeMerchants: one(
        "SELECT COUNT(DISTINCT merchant) AS n FROM mandates WHERE status = 'Active'",
      ),
      lastIndexedLedger: readCursor(db, 0),
    };
    res.json(body);
  });

  return r;
}
