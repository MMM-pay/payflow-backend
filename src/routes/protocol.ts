import { Router } from "express";
import type { Storage } from "../lib/store/types.ts";
import { getProtocolFeeHistory } from "../lib/queries.ts";
import type { ProtocolResponse } from "./types.ts";

/** `GET /protocol`: latest indexed fee and its change history. */
export function protocolRouter(db: Storage): Router {
  const r = Router();

  r.get("/protocol", async (_req, res) => {
    const body: ProtocolResponse = await getProtocolFeeHistory(db);
    res.json(body);
  });

  return r;
}