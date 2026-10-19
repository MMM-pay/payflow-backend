import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { getProtocolFeeHistory } from "../lib/queries.ts";
import type { ProtocolResponse } from "./types.ts";

/** `GET /protocol`: latest indexed fee and its change history. */
export function protocolRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/protocol", (_req, res) => {
    const body: ProtocolResponse = getProtocolFeeHistory(db);
    res.json(body);
  });

  return r;
}