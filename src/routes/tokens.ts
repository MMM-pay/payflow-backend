import { Router } from "express";
import { TokenMetadataUnavailable, type TokenMetadataService } from "../lib/tokens.ts";
import { logger } from "../lib/logger.ts";
import type { TokenMetadata } from "./types.ts";

/** Contract ids are strkey-encoded ed25519 addresses; `native` is also accepted. */
const TOKEN_ID = /^(native|[A-Z0-9]{56})$/i;

/**
 * `GET /tokens/:id` — what a token contract id means.
 *
 * The metadata is read from the token contract itself and cached, so a client
 * no longer has to assume XLM and 7 decimals for every amount it displays.
 */
export function tokensRouter(tokens: TokenMetadataService): Router {
  const r = Router();

  r.get("/tokens/:id", async (req, res) => {
    const id = String(req.params.id);
    if (!TOKEN_ID.test(id)) {
      res.status(400).json({ error: "invalid_token_id" });
      return;
    }

    let body: TokenMetadata;
    try {
      body = await tokens.fetch(id);
    } catch (err) {
      if (err instanceof TokenMetadataUnavailable) {
        // Transient by definition: the next request reads the contract again.
        logger.warn({ token: id, reason: err.reason }, "token metadata unavailable");
        res.status(502).json({ error: "token_metadata_unavailable" });
        return;
      }
      throw err;
    }
    res.json(body);
  });

  return r;
}
