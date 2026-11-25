import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Server } from "node:http";
import { StrKey } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";

/**
 * HTTPS enforcement (#277): in production a plaintext request must not be
 * served, and every response carries HSTS so browsers stop trying `http://`.
 */

const VALID_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));
const BASE_ENV = {
  PLAN_REGISTRY_ID: VALID_CONTRACT_ID,
  VAULT_ID: VALID_CONTRACT_ID,
  SUBSCRIPTION_ID: VALID_CONTRACT_ID,
};

describe("REQUIRE_HTTPS config", () => {
  test("defaults on in production", () => {
    assert.equal(loadConfig({ ...BASE_ENV, NODE_ENV: "production" }).REQUIRE_HTTPS, true);
  });

  test("defaults off outside production", () => {
    assert.equal(loadConfig({ ...BASE_ENV }).REQUIRE_HTTPS, false);
    assert.equal(loadConfig({ ...BASE_ENV, NODE_ENV: "development" }).REQUIRE_HTTPS, false);
  });

  test("an explicit value overrides the NODE_ENV default", () => {
    assert.equal(loadConfig({ ...BASE_ENV, NODE_ENV: "production", REQUIRE_HTTPS: "false" }).REQUIRE_HTTPS, false);
    assert.equal(loadConfig({ ...BASE_ENV, REQUIRE_HTTPS: "true" }).REQUIRE_HTTPS, true);
  });

  test("rejects a value that is not a boolean", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, REQUIRE_HTTPS: "yes" }), /REQUIRE_HTTPS/);
  });

  test("HSTS max-age defaults to one year", () => {
    assert.equal(loadConfig({ ...BASE_ENV }).HSTS_MAX_AGE_S, 31_536_000);
  });
});

function serve(config: Config): Promise<{ base: string; close: () => void }> {
  const db = openDatabase(":memory:");
  const app = createApp(db, config);
  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      resolve({
        base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
        close: () => {
          server.close();
          db.close();
        },
      });
    });
  });
}

describe("with REQUIRE_HTTPS on", () => {
  let base = "";
  let close = () => {};

  before(async () => {
    ({ base, close } = await serve({ CORS_ORIGIN: "*", REQUIRE_HTTPS: true } as unknown as Config));
  });
  after(() => close());

  test("rejects a plaintext API request with the error envelope", async () => {
    const res = await fetch(`${base}/api/v1/plans`);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "forbidden");
    assert.match(body.error.message, /HTTPS is required/);
  });

  test("rejects a plaintext write without a redirect", async () => {
    const res = await fetch(`${base}/api/v1/plans`, { method: "POST", redirect: "manual" });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("location"), null);
  });

  test("serves a request the TLS-terminating proxy marks as https", async () => {
    const res = await fetch(`${base}/api/v1/plans`, { headers: { "X-Forwarded-Proto": "https" } });
    assert.notEqual(res.status, 403);
  });

  test("keeps platform health checks reachable over plaintext", async () => {
    for (const path of ["/health", "/ready"]) {
      const res = await fetch(`${base}${path}`);
      assert.notEqual(res.status, 403, path);
    }
  });

  test("sends Strict-Transport-Security on every response", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  });
});

describe("with REQUIRE_HTTPS off", () => {
  test("serves plaintext for local development", async () => {
    const { base, close } = await serve({ CORS_ORIGIN: "*", REQUIRE_HTTPS: false } as unknown as Config);
    try {
      const res = await fetch(`${base}/api/v1/plans`);
      assert.notEqual(res.status, 403);
    } finally {
      close();
    }
  });

  test("HSTS_MAX_AGE_S=0 drops the header", async () => {
    const { base, close } = await serve({ CORS_ORIGIN: "*", HSTS_MAX_AGE_S: 0 } as unknown as Config);
    try {
      const res = await fetch(`${base}/health`);
      assert.equal(res.headers.get("strict-transport-security"), null);
    } finally {
      close();
    }
  });
});
