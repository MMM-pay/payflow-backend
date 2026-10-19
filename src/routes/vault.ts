import { Router } from "express";
import type { Storage } from "../lib/store/types.ts";
import { getVaultBalances, listVaultEvents } from "../lib/queries.ts";
import { limitOf } from "./helpers.ts";
import type { VaultBalancePage, VaultEventPage } from "./types.ts";

/** `GET /vault/:address` and its append-only funding history. */
export function vaultRouter(db: Storage): Router {
  const r = Router();

  r.get("/vault/:address", async (req, res) => {
    const address = String(req.params.address);
    const balances = await getVaultBalances(db, address);
    res.json({ address, balances } satisfies VaultBalancePage);
  });

  r.get("/vault/:address/events", async (req, res) => {
    const address = String(req.params.address);
    const events = await listVaultEvents(db, address, limitOf(req.query.limit));
    res.json({ address, events } satisfies VaultEventPage);
  });

  return r;
}