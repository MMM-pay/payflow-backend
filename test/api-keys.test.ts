/**
 * Tests for issue #312: per-merchant API keys with scopes.
 *
 * Covers:
 *   - Create key (POST /merchants/:address/keys) — 201 + raw key returned once
 *   - List keys (GET /merchants/:address/keys) — 200 with key metadata
 *   - Use API key to authenticate list endpoint — 200
 *   - Revoke key (DELETE /merchants/:address/keys/:id) — 204
 *   - Revoked key rejected — 401
 *   - Auth failures: no token, wrong merchant, bad address
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import { Sep10Auth } from "../src/routes/auth.ts";
import { testAddress } from "./addresses.ts";

const MERCHANT = testAddress(50);
const OTHER_MERCHANT = testAddress(51);

const JWT_SECRET = "api-key-test-jwt-secret-32-chars-min";
const HOME = "payflow.example";
const WEB = "api.payflow.example";
const ISSUER = `https://${WEB}/api/testnet/auth`;
const SIGNING_KEY = Keypair.random();

const testnet: NetworkConfig = {
  name: "testnet",
  rpcUrl: "https://rpc.invalid",
  networkPassphrase: Networks.TESTNET,
  planRegistryId: "C".repeat(56),
  vaultId: "C".repeat(56),
  subscriptionId: "C".repeat(56),
  startLedger: 0,
  databasePath: ":memory:",
};

const config = { CORS_ORIGIN: "*" } as unknown as Config;

/** Forge a valid SEP-10 JWT for the given merchant address. */
function forgeJwt(address: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iss: ISSUER, sub: address, iat: now, exp: now + 900, jti: "test-jti" }),
  ).toString("base64url");
  const body = `${header}.${payload}`;
  const sig = createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

let server: Server;
let base = "";
const db = openDatabase(":memory:");

const auth = new Sep10Auth({
  signingKey: SIGNING_KEY.secret(),
  jwtSecret: JWT_SECRET,
  homeDomain: HOME,
  webAuthDomain: WEB,
  networkPassphrase: Networks.TESTNET,
  issuer: ISSUER,
  tokenTtlS: 900,
  loadAccount: async () => ({ signers: [], mediumThreshold: 1 }),
});

before(async () => {
  const app = createApp([{ config: testnet, db, indexer: { cursor: 1, latest: 1 } as never, auth }], config);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  db.close();
});

describe("per-merchant API keys (#312)", () => {
  describe("POST /merchants/:address/keys — create", () => {
    test("creates a key and returns it with status 201", async () => {
      const jwt = forgeJwt(MERCHANT);
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "my-server", scopes: ["read"] }),
      });
      assert.equal(res.status, 201);
      const body = await res.json() as Record<string, unknown>;
      assert.ok(typeof body.key === "string", "key is returned");
      assert.ok((body.key as string).startsWith("pfk_"), "key has pfk_ prefix");
      assert.equal(body.merchant, MERCHANT);
      assert.equal(body.name, "my-server");
      assert.deepEqual(body.scopes, ["read"]);
      assert.equal(body.lastUsedAt, null);
      assert.ok(typeof body.id === "number", "id is a number");
    });

    test("creates a key with default name and scopes when body is empty", async () => {
      const jwt = forgeJwt(MERCHANT);
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 201);
      const body = await res.json() as Record<string, unknown>;
      assert.ok((body.key as string).startsWith("pfk_"));
      assert.equal(body.name, "");
      assert.deepEqual(body.scopes, ["read"]);
    });

    test("returns 401 when no token is provided", async () => {
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 401);
    });

    test("returns 403 when JWT is for a different merchant", async () => {
      const jwt = forgeJwt(OTHER_MERCHANT);
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 403);
    });

    test("returns 400 for a bad address", async () => {
      const jwt = forgeJwt(MERCHANT);
      const res = await fetch(`${base}/api/merchants/not-a-stellar-address/keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });
  });

  describe("GET /merchants/:address/keys — list", () => {
    let createdId: number;
    let createdKey: string;

    before(async () => {
      const jwt = forgeJwt(MERCHANT);
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "list-test-key" }),
      });
      const body = await res.json() as Record<string, unknown>;
      createdId = body.id as number;
      createdKey = body.key as string;
    });

    test("lists keys with a JWT — 200", async () => {
      const jwt = forgeJwt(MERCHANT);
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.merchant, MERCHANT);
      assert.ok(Array.isArray(body.keys), "keys is an array");
      const keys = body.keys as unknown[];
      assert.ok(keys.length >= 1, "at least one key is listed");
    });

    test("lists keys with an API key — 200", async () => {
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        headers: { authorization: `Bearer ${createdKey}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { merchant: string; keys: unknown[] };
      assert.equal(body.merchant, MERCHANT);
      assert.ok(body.keys.length >= 1);
    });

    test("key listing does not include the raw key value", async () => {
      const jwt = forgeJwt(MERCHANT);
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      const body = await res.json() as { keys: Record<string, unknown>[] };
      for (const k of body.keys) {
        assert.ok(!("key" in k), "raw key is not in listing");
      }
    });

    test("returns 401 when no token is provided", async () => {
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys`);
      assert.equal(res.status, 401);
    });

    test("returns 403 when token is for a different merchant", async () => {
      const jwt = forgeJwt(OTHER_MERCHANT);
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      assert.equal(res.status, 403);
    });

    test("revoke and verify rejection", async () => {
      const jwt = forgeJwt(MERCHANT);
      const revokeRes = await fetch(`${base}/api/merchants/${MERCHANT}/keys/${createdId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${jwt}` },
      });
      assert.equal(revokeRes.status, 204);

      const afterRes = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        headers: { authorization: `Bearer ${createdKey}` },
      });
      assert.equal(afterRes.status, 401, "revoked key is rejected");
    });
  });

  describe("DELETE /merchants/:address/keys/:id — revoke", () => {
    test("revokes a key and returns 204", async () => {
      const jwt = forgeJwt(MERCHANT);
      const createRes = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "to-revoke" }),
      });
      const { id } = await createRes.json() as { id: number };

      const deleteRes = await fetch(`${base}/api/merchants/${MERCHANT}/keys/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${jwt}` },
      });
      assert.equal(deleteRes.status, 204);
    });

    test("returns 404 when revoking a key that does not exist", async () => {
      const jwt = forgeJwt(MERCHANT);
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys/99999`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${jwt}` },
      });
      assert.equal(res.status, 404);
    });

    test("returns 401 when no token is provided", async () => {
      const res = await fetch(`${base}/api/merchants/${MERCHANT}/keys/1`, {
        method: "DELETE",
      });
      assert.equal(res.status, 401);
    });

    test("returns 403 when token is for a different merchant", async () => {
      const jwt = forgeJwt(MERCHANT);
      const createRes = await fetch(`${base}/api/merchants/${MERCHANT}/keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "other-revoke-test" }),
      });
      const { id } = await createRes.json() as { id: number };

      const wrongJwt = forgeJwt(OTHER_MERCHANT);
      const deleteRes = await fetch(`${base}/api/merchants/${MERCHANT}/keys/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${wrongJwt}` },
      });
      assert.equal(deleteRes.status, 403);
    });
  });
});
