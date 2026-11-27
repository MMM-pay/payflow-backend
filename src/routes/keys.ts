/**
 * Per-merchant API key management.
 *
 * A merchant authenticated via SEP-10 JWT can create scoped API keys so their
 * server-side code can read their own data without keeping a Stellar secret key
 * in a web server.
 *
 * Keys are stored hashed (HMAC-SHA256) so a database read does not expose the
 * raw value. The raw key is returned once at creation and is never retrievable
 * afterwards. A key prefix is kept for display ("ends in pfk_a1b2c3...").
 *
 * Routes:
 *   POST   /merchants/:address/keys           – create (requires SEP-10 JWT)
 *   GET    /merchants/:address/keys           – list   (requires SEP-10 JWT or API key)
 *   DELETE /merchants/:address/keys/:id       – revoke (requires SEP-10 JWT)
 */

import express, { Router } from "express";
import { z } from "zod";
import type { Storage } from "../lib/store/types.ts";
import {
  generateApiKey,
  hashApiKey,
  resolveSession,
  sessionOf,
  type Sep10Auth,
} from "./auth.ts";
import { sendApiError } from "./errors.ts";
import { addressSchema, idSchema, validate } from "./validate.ts";
import type { ApiKeyCreateResponse, ApiKeyListResponse, MerchantApiKey } from "./types.ts";

const createKeySchema = z.object({
  name: z.string().max(100).optional().default(""),
  scopes: z.array(z.enum(["read"])).optional().default(["read"]),
});

function rowToKey(merchant: string, row: {
  id: number; key_prefix: string; name: string;
  scopes: string; created_at: number; last_used_at: number | null;
}): MerchantApiKey {
  return {
    id: row.id,
    merchant,
    keyPrefix: row.key_prefix,
    name: row.name,
    scopes: row.scopes.split(","),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}

export function keysRouter(db: Storage, auth: Sep10Auth | undefined): Router {
  const r = Router();

  /**
   * `POST /merchants/:address/keys`
   *
   * Creates a new API key for the merchant. The raw key is returned this once
   * and cannot be recovered; store it immediately. Requires a valid SEP-10 JWT
   * for the merchant's address.
   */
  r.post("/merchants/:address/keys", express.json({ limit: "8kb" }), async (req, res) => {
    const address = validate(req, res, "address", addressSchema, req.params.address);
    if (!address.ok) return;

    const session = sessionOf(req, res, auth);
    if (!session.ok) return;
    if (session.value === null) {
      sendApiError(res, req, 401, "unauthorized", "A SEP-10 bearer token is required to manage API keys.");
      return;
    }
    if (session.value !== address.value) {
      sendApiError(res, req, 403, "forbidden", "You can only create API keys for your own merchant account.");
      return;
    }

    const body = validate(req, res, "body", createKeySchema, req.body);
    if (!body.ok) return;

    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const keyPrefix = key.slice(0, 12);
    const now = Math.floor(Date.now() / 1000);
    const scopesStr = body.value.scopes.join(",");

    await db.run(
      `INSERT INTO merchant_api_keys (merchant, key_hash, key_prefix, name, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [address.value, keyHash, keyPrefix, body.value.name, scopesStr, now],
    );

    const inserted = await db.get<{ id: number }>(
      "SELECT id FROM merchant_api_keys WHERE key_hash = ?",
      [keyHash],
    );

    const response: ApiKeyCreateResponse = {
      id: inserted!.id,
      merchant: address.value,
      key,
      keyPrefix,
      name: body.value.name,
      scopes: body.value.scopes,
      createdAt: now,
      lastUsedAt: null,
    };
    res.status(201).json(response);
  });

  /**
   * `GET /merchants/:address/keys`
   *
   * Lists all active (non-revoked) API keys for the merchant. Requires a valid
   * SEP-10 JWT or an active API key with "read" scope for the merchant's address.
   */
  r.get("/merchants/:address/keys", async (req, res) => {
    const address = validate(req, res, "address", addressSchema, req.params.address);
    if (!address.ok) return;

    const session = await resolveSession(req, res, auth, db);
    if (!session.ok) return;
    if (session.value === null) {
      sendApiError(res, req, 401, "unauthorized", "Authentication is required to list API keys.");
      return;
    }
    if (session.value !== address.value) {
      sendApiError(res, req, 403, "forbidden", "You can only list API keys for your own merchant account.");
      return;
    }

    const rows = await db.all<{
      id: number; key_prefix: string; name: string;
      scopes: string; created_at: number; last_used_at: number | null;
    }>(
      `SELECT id, key_prefix, name, scopes, created_at, last_used_at
         FROM merchant_api_keys
        WHERE merchant = ? AND revoked = 0
        ORDER BY created_at DESC`,
      [address.value],
    );

    const response: ApiKeyListResponse = {
      merchant: address.value,
      keys: rows.map((row) => rowToKey(address.value, row)),
    };
    res.json(response);
  });

  /**
   * `DELETE /merchants/:address/keys/:id`
   *
   * Revokes an API key. The key is marked revoked in-place and can no longer
   * authenticate requests. Requires a valid SEP-10 JWT for the merchant's
   * address.
   */
  r.delete("/merchants/:address/keys/:id", async (req, res) => {
    const address = validate(req, res, "address", addressSchema, req.params.address);
    if (!address.ok) return;
    const keyId = validate(req, res, "id", idSchema, req.params.id);
    if (!keyId.ok) return;

    const session = sessionOf(req, res, auth);
    if (!session.ok) return;
    if (session.value === null) {
      sendApiError(res, req, 401, "unauthorized", "A SEP-10 bearer token is required to manage API keys.");
      return;
    }
    if (session.value !== address.value) {
      sendApiError(res, req, 403, "forbidden", "You can only revoke API keys for your own merchant account.");
      return;
    }

    const existing = await db.get<{ id: number }>(
      "SELECT id FROM merchant_api_keys WHERE id = ? AND merchant = ? AND revoked = 0",
      [keyId.value, address.value],
    );
    if (!existing) {
      sendApiError(res, req, 404, "not_found", "The API key was not found.");
      return;
    }

    await db.run("UPDATE merchant_api_keys SET revoked = 1 WHERE id = ?", [keyId.value]);
    res.status(204).send();
  });

  return r;
}
