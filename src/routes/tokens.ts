import { Router } from "express";
import { StrKey } from "@stellar/stellar-sdk";
import { TokenMetadataUnavailable, type TokenMetadataService } from "../lib/tokens.ts";
import { logger } from "../lib/logger.ts";
import { sendApiError } from "./errors.ts";
import { queryOnly } from "./validate.ts";
import type { TokenMetadata } from "./types.ts";

/**
 * `GET /tokens/:id` — what a token contract id means.
 *
 * The metadata is read from the token contract itself and cached, so a client
 * no longer has to assume XLM and 7 decimals for every amount it displays.
 */
export function tokensRouter(tokens: TokenMetadataService): Router {
  const r = Router();

  r.get("/tokens/:id", queryOnly(), async (req, res) => {
    const id = req.params.id;
    if (typeof id !== "string" || (id.toLowerCase() !== "native" && !StrKey.isValidContract(id))) {
      sendApiError(res, req, 400, "invalid_token_id");
      return;
    }

    let body: TokenMetadata;
    try {
      body = await tokens.fetch(id.toLowerCase() === "native" ? "native" : id);
    } catch (err) {
      if (err instanceof TokenMetadataUnavailable) {
        // Transient by definition: the next request reads the contract again.
        logger.warn({ token: id, reason: err.reason }, "token metadata unavailable");
        sendApiError(res, req, 502, "token_metadata_unavailable");
        return;
      }
      throw err;
    }
    res.json(body);
  });

  return r;
}
