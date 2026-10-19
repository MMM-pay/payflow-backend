import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { getVaultBalances, listVaultEvents } from "../lib/queries.ts";
import { limitOf } from "./helpers.ts";
import type { VaultBalancePage, VaultEventPage } from "./types.ts";

/** `GET /vault/:address` and its append-only funding history. */
export function vaultRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/vault/:address", (req, res) => {
    const address = String(req.params.address);
    const balances = getVaultBalances(db, address);
    res.json({ address, balances } satisfies VaultBalancePage);
  });

  r.get("/vault/:address/events", (req, res) => {
    const address = String(req.params.address);
    const events = listVaultEvents(db, address, limitOf(req.query.limit));
    res.json({ address, events } satisfies VaultEventPage);
  });

  return r;
}