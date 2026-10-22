import { Router } from "express";
import type { Storage } from "../lib/store/types.ts";
import { getVaultBalances, listVaultEvents } from "../lib/queries.ts";
import { limitOf } from "./helpers.ts";
import { addressSchema, limitSchema, present, validate } from "./validate.ts";
import type { VaultBalancePage, VaultEventPage } from "./types.ts";

/** `GET /vault/:address` and its append-only funding history. */
export function vaultRouter(db: Storage): Router {
  const r = Router();

  r.get("/vault/:address", async (req, res) => {
    const address = validate(req, res, "address", addressSchema, req.params.address);
    if (!address.ok) return;

    const balances = await getVaultBalances(db, address.value);
    res.json({ address: address.value, balances } satisfies VaultBalancePage);
  });

  r.get("/vault/:address/events", async (req, res) => {
    const address = validate(req, res, "address", addressSchema, req.params.address);
    if (!address.ok) return;
    const limit = validate(req, res, "limit", limitSchema.optional(), present(req.query.limit));
    if (!limit.ok) return;

    const events = await listVaultEvents(db, address.value, limitOf(limit.value));
    res.json({ address: address.value, events } satisfies VaultEventPage);
  });

  return r;
}