import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { logger } from "../src/lib/logger.ts";
import type { Config, NetworkConfig } from "../src/config.ts";

/**
 * Every non-2xx response uses one envelope, whatever the route:
 *
 * ```json
 * { "error": { "code": "...", "message": "...", "requestId": "..." } }
 * ```
 *
 * The routes below are one representative error path from each mounted
 * router — plans, mandates, merchants, the admin surface the fallthrough 404
 * and the unauthenticated admin 401. A change that grows a second error
 * shape, or lets a handler send a bare string, fails here.
 */

logger.level = "silent";

const testnet: NetworkConfig = {
  name: "testnet",
  rpcUrl: "https://rpc.invalid",
  networkPassphrase: "Test SDF Network ; September 2015",
  planRegistryId: "C".repeat(56),
  vaultId: "C".repeat(56),
  subscriptionId: "C".repeat(56),
  startLedger: 0,
  databasePath: ":memory:",
};

const ADMIN_TOKEN = "test-admin-token-0123456789";
const config = {
  CORS_ORIGIN: "*",
  ADMIN_TOKEN,
  ADMIN_TOKENS: [],
} as unknown as Config;

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string | null;
    details?: unknown;
  };
}

/**
 * Assert the response body is the one documented error shape — the `error`
 * key alone, a non-empty code and message, and an optional request id.
 */
function assertEnvelope(body: unknown): ErrorEnvelope {
  assert.ok(typeof body === "object" && body !== null, "the body is an object");
  const envelope = body as Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope), ["error"], "the body carries `error` and nothing else");
  const error = envelope.error as Record<string, unknown>;
  assert.ok(typeof error === "object" && error !== null, "`error` is an object");
  const unexpected = Object.keys(error).filter(
    (key) => !["code", "message", "requestId", "details"].includes(key),
  );
  assert.deepEqual(unexpected, [], "the error object has no fields beyond the documented ones");
  assert.equal(typeof error.code, "string");
  assert.ok((error.code as string).length > 0, "the code is not empty");
  assert.match(error.code as string, /^[a-z][a-z0-9_]*$/, "the code is machine-readable");
  assert.equal(typeof error.message, "string");
  assert.ok((error.message as string).length > 0, "the message is not empty");
  assert.ok(
    error.requestId === null || typeof error.requestId === "string",
    "the requestId is a string or null",
  );
  return body as ErrorEnvelope;
}

describe("error envelope", () => {
  const db = openDatabase(":memory:");
  let server: Server;
  let base = "";

  before(async () => {
    const app = createApp(
      [{ config: testnet, db }],
      config,
      {
        // Enough of the admin surface for its 401 path to exist. `reindex`
        // is what marks the third argument as admin hooks to `createApp`.
        reindex: async () => ({}),
        getAuditLogs: () => [],
      },
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    server.close();
  });

  /** One request with a known request id, so the echo can be asserted. */
  async function get(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; contentType: string | null; body: unknown }> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "X-Request-Id": "envelope-test", ...(init.headers ?? {}) },
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON body fails the envelope assertion below.
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body,
    };
  }

  const cases: Array<{ name: string; path: string; status: number; code: string; init?: RequestInit }> = [
    {
      name: "a malformed plan id",
      path: "/api/v1/plans/not-a-number",
      status: 400,
      code: "invalid_request",
    },
    {
      name: "an unknown plan",
      path: "/api/v1/plans/999999",
      status: 404,
      code: "plan_not_found",
    },
    {
      name: "a malformed mandate id",
      path: "/api/v1/mandates/not-a-number",
      status: 400,
      code: "invalid_request",
    },
    {
      name: "an unknown mandate",
      path: "/api/v1/mandates/999999",
      status: 404,
      code: "mandate_not_found",
    },
    {
      name: "a malformed merchant address",
      path: "/api/v1/merchants/not-an-address/summary",
      status: 400,
      code: "invalid_request",
    },
    {
      name: "an unknown path",
      path: "/api/v1/does-not-exist",
      status: 404,
      code: "not_found",
    },
    {
      name: "a method the API does not expose",
      path: "/api/v1/plans",
      status: 404,
      code: "not_found",
      init: { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
    },
    {
      name: "an admin route without a token",
      path: "/admin/audit-logs",
      status: 401,
      code: "unauthorized",
    },
  ];

  for (const scenario of cases) {
    test(`${scenario.name} uses the shared error envelope`, async () => {
      const result = await get(scenario.path, scenario.init);
      assert.equal(result.status, scenario.status, `status for ${scenario.path}`);
      assert.match(
        result.contentType ?? "",
        /^application\/json/,
        "an error is answered as JSON",
      );
      const envelope = assertEnvelope(result.body);
      assert.equal(envelope.error.code, scenario.code);
      assert.equal(
        envelope.error.requestId,
        "envelope-test",
        "the request id is echoed so a report can be tied to the log line",
      );
    });
  }

  test("the versioned path and its alias answer the same envelope", async () => {
    const versioned = await get("/api/v1/plans/not-a-number");
    const alias = await get("/api/plans/not-a-number");
    const a = assertEnvelope(versioned.body);
    const b = assertEnvelope(alias.body);
    assert.equal(versioned.status, alias.status);
    assert.equal(a.error.code, b.error.code);
    assert.equal(a.error.message, b.error.message);
  });

  test("an unauthenticated admin request names the missing token, not the resource", async () => {
    const result = await get("/admin/audit-logs");
    const envelope = assertEnvelope(result.body);
    assert.equal(envelope.error.code, "unauthorized");
    // The message is the code's default, not anything about the projection.
    assert.doesNotMatch(envelope.error.message, /audit log/i);
  });
});
