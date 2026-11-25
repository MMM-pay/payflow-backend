import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import type { AdminHooks } from "../src/routes/admin.ts";
import type { WebhookDispatcher } from "../src/lib/webhooks.ts";
import { Sep10Auth } from "../src/routes/auth.ts";
import { testAddress } from "./addresses.ts";

/**
 * The error contract of every route.
 *
 * Every non-2xx response is documented to use one envelope:
 *
 * ```json
 * { "error": { "code": "...", "message": "...", "requestId": "..." } }
 * ```
 *
 * with `details` present for `invalid_request` only. This file asserts that
 * contract across the whole surface — the routes that validate a parameter,
 * the ones that can miss a resource, the merchant-only routes that need a
 * proof, the operator routes that need a bearer token, and the optional
 * subsystems — and checks that each condition answers its documented status
 * code rather than a generic 500.
 *
 * The service is built from an in-memory projection and a SEP-10 keypair made
 * in the test, so no request reads the clock, the filesystem or the network.
 * The one response that is deliberately not an `error` envelope is `/ready`:
 * it is a readiness probe whose 503 carries the probe's own body (`status`,
 * `lag`), documented in the README, and it is asserted as such below.
 */

const MERCHANT = testAddress(101);
const SUBSCRIBER = testAddress(102);
const UNKNOWN_MERCHANT = testAddress(103);
/** A well-formed contract id whose metadata cannot be read without an RPC. */
const UNREADABLE_TOKEN = "C".repeat(56);
const ADMIN_TOKEN = "error-envelope-operator-token";
const NOW = Math.floor(Date.now() / 1000);
/** 64 bytes of base64: the right shape, the wrong signer. */
const WRONG_SIGNATURE = Buffer.alloc(64, 7).toString("base64");

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

/** A rate limit high enough that the full route sweep never trips it. */
const config = {
  CORS_ORIGIN: "*",
  API_RATE_LIMIT_MAX: 100_000,
  ADMIN_TOKEN,
  KEEPER_ENABLED: true,
} as unknown as Config;

const ev = (name: string, topics: unknown[], data: Record<string, unknown>, tx = "t"): DecodedEvent => ({
  name,
  contractId: "C",
  ledger: 1,
  txHash: tx,
  topics,
  data,
});

/** SEP-10 without a network: the challenge is built locally and the account loader never runs. */
function testAuth(): Sep10Auth {
  return new Sep10Auth({
    signingKey: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).secret(),
    jwtSecret: "x".repeat(32),
    homeDomain: "payflow.test",
    webAuthDomain: "payflow.test",
    networkPassphrase: testnet.networkPassphrase,
    issuer: "https://payflow.test/api/testnet/auth",
    tokenTtlS: 3_600,
    loadAccount: async () => null,
  });
}

/** Only the proof failure paths are reached here; no delivery is ever made. */
const webhookDispatcher = {
  isPublicTarget: async () => false,
  register: async () => null,
  listForMerchant: async () => [],
  deactivate: async () => false,
  rotateSecret: async () => null,
  ping: async () => null,
  history: async () => null,
} as unknown as WebhookDispatcher;

const adminHooks: AdminHooks = {
  reindex: async () => ({ applied: 0 }),
  keeperPass: async () => [],
  keeperBackoff: () => [],
  keeperHistory: () => [],
  pauseIndexer: () => null,
  resumeIndexer: () => null,
};

const db = openDatabase(":memory:");
let server: Server;
let base = "";

before(async () => {
  const ix = new Indexer(db, {} as never, {} as never);
  // Plan 1 is open; plan 2 was deactivated, so it answers 410 rather than 404.
  await ix.apply(ev("plan_created", [MERCHANT, 1n], {
    token: "C",
    amount: 10_000_000n,
    period: 2_592_000n,
    name: "Monthly",
  }, "plan-1"));
  await ix.apply(ev("plan_created", [MERCHANT, 2n], {
    token: "C",
    amount: 5_000_000n,
    period: 2_592_000n,
    name: "Retired",
  }, "plan-2"));
  await ix.apply(ev("plan_status_changed", [MERCHANT, 2n], { active: false }, "plan-2-off"));
  // Mandate 1 exists, so an id test distinguishes "found" from "not found".
  await ix.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n,
    amount: 10_000_000n,
    period: 2_592_000n,
    next_charge: BigInt(NOW - 60),
    fee_bps: 100n,
  }, "mandate-1"));
  ix.status.cursor = 100;
  ix.status.latest = 100;

  const app = createApp(
    [
      {
        config: testnet,
        db,
        indexer: ix.status,
        events: ix.events,
        webhooks: webhookDispatcher,
        auth: testAuth(),
      },
    ],
    config,
    adminHooks,
  );

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

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string | null;
    details?: { path: string; message: string }[];
  };
}

/**
 * Assert the shared envelope and return the parsed body.
 *
 * The checks are deliberately structural rather than a subset match: an extra
 * top-level key, a missing `requestId`, a `requestId` that does not echo the
 * `X-Request-Id` header, or `details` on a condition other than
 * `invalid_request` all fail, because each would break a consumer that reads
 * the documented contract.
 */
async function assertErrorEnvelope(
  res: Response,
  expected: { status: number; code?: string; detailPath?: string },
  context: string,
): Promise<ErrorEnvelope> {
  assert.equal(res.status, expected.status, `${context}: status code`);

  const contentType = res.headers.get("content-type") ?? "";
  assert.match(contentType, /application\/json/, `${context}: content type ${contentType}`);

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    assert.fail(`${context}: the body is not JSON: ${text.slice(0, 200)}`);
  }
  assert.ok(parsed !== null && typeof parsed === "object", `${context}: body is not an object`);
  assert.deepEqual(Object.keys(parsed as object), ["error"], `${context}: top-level keys`);

  const err = (parsed as ErrorEnvelope).error;
  assert.ok(err !== null && typeof err === "object", `${context}: error is not an object`);
  assert.deepEqual(
    Object.keys(err).filter((key) => key !== "details").sort(),
    ["code", "message", "requestId"],
    `${context}: error keys`,
  );

  assert.equal(typeof err.code, "string", `${context}: code`);
  assert.match(err.code, /^[a-z][a-z0-9_]*$/, `${context}: code ${err.code} is not a stable token`);
  assert.equal(typeof err.message, "string", `${context}: message`);
  assert.ok(err.message.trim().length > 0, `${context}: message is empty`);

  const header = res.headers.get("x-request-id");
  assert.ok(header !== null && header.length > 0, `${context}: X-Request-Id is missing`);
  assert.equal(err.requestId, header, `${context}: requestId does not echo X-Request-Id`);

  if ("details" in err) {
    assert.equal(err.code, "invalid_request", `${context}: details is only documented for invalid_request`);
    assert.ok(Array.isArray(err.details) && err.details.length > 0, `${context}: details must be non-empty`);
    for (const detail of err.details) {
      assert.deepEqual(Object.keys(detail).sort(), ["message", "path"], `${context}: detail keys`);
      assert.ok(typeof detail.path === "string" && detail.path.length > 0, `${context}: detail path`);
      assert.ok(typeof detail.message === "string" && detail.message.length > 0, `${context}: detail message`);
    }
  }

  if (expected.code !== undefined) {
    assert.equal(err.code, expected.code, `${context}: error code`);
  }
  if (expected.detailPath !== undefined) {
    assert.equal(err.details?.[0]?.path, expected.detailPath, `${context}: first detail path`);
  }

  return parsed as ErrorEnvelope;
}

interface ErrorCase {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  status: number;
  code: string;
  /** The parameter the first `details` entry must name. */
  detailPath?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const ids101 = Array.from({ length: 101 }, (_, index) => index + 1).join(",");

/**
 * Every route's error conditions, one row each.
 *
 * A row asserts the status the README's table prescribes and the stable
 * `code`; `detailPath` additionally pins which parameter an
 * `invalid_request` blames. Grouped by resource so a new route has an
 * obvious place to add its own.
 */
const CASES: ErrorCase[] = [
  // Plans: validation, a missing id and a deactivated plan.
  { method: "GET", path: "/api/v1/plans?merchant=not-a-strkey", status: 400, code: "invalid_request", detailPath: "merchant" },
  { method: "GET", path: "/api/v1/plans?limit=0", status: 400, code: "invalid_request", detailPath: "limit" },
  { method: "GET", path: "/api/v1/plans?sort=alphabetical", status: 400, code: "invalid_request", detailPath: "sort" },
  { method: "GET", path: "/api/v1/plans?cursor=not-a-cursor", status: 400, code: "invalid_request", detailPath: "cursor" },
  { method: "GET", path: "/api/v1/plans/not-an-id", status: 400, code: "invalid_request", detailPath: "id" },
  { method: "GET", path: "/api/plans/not-an-id", status: 400, code: "invalid_request", detailPath: "id" },
  { method: "GET", path: "/api/v1/plans/999999", status: 404, code: "plan_not_found" },
  { method: "GET", path: "/api/v1/plans/2", status: 410, code: "plan_gone" },
  { method: "GET", path: "/api/v1/plans/999999/stats", status: 404, code: "plan_not_found" },
  { method: "GET", path: "/api/v1/plans/2/stats", status: 410, code: "plan_gone" },

  // Mandates: filters, batch ids, absent ids and the date range.
  { method: "GET", path: "/api/v1/mandates?status=Garbage", status: 400, code: "invalid_request", detailPath: "status" },
  { method: "GET", path: "/api/v1/mandates?ids=1,nope", status: 400, code: "invalid_ids" },
  { method: "GET", path: `/api/v1/mandates?ids=${ids101}`, status: 400, code: "too_many_ids" },
  { method: "GET", path: "/api/v1/mandates/not-an-id", status: 400, code: "invalid_request", detailPath: "id" },
  { method: "GET", path: "/api/v1/mandates/999999", status: 404, code: "mandate_not_found" },
  { method: "GET", path: "/api/v1/mandates/999999/timeline", status: 404, code: "mandate_not_found" },
  { method: "GET", path: "/api/v1/mandates/999999/charges", status: 404, code: "mandate_not_found" },
  { method: "GET", path: "/api/v1/mandates/999999/attempts", status: 404, code: "mandate_not_found" },
  { method: "GET", path: "/api/v1/mandates/1/charges?from=2026-10-02&to=2026-10-01", status: 400, code: "invalid_request", detailPath: "from" },
  { method: "GET", path: "/api/v1/mandates/1/charges?from=yesterday", status: 400, code: "invalid_request", detailPath: "from" },
  { method: "GET", path: "/api/v1/mandates/1/charges?limit=0", status: 400, code: "invalid_request", detailPath: "limit" },
  { method: "GET", path: "/api/v1/mandates/1/attempts?limit=0", status: 400, code: "invalid_request", detailPath: "limit" },

  // Merchants: addresses, limits, buckets, ranges and the signed proof.
  { method: "GET", path: "/api/v1/merchants/not-a-strkey/summary", status: 400, code: "invalid_request", detailPath: "address" },
  { method: "GET", path: `/api/v1/merchants/${UNKNOWN_MERCHANT}/profile`, status: 404, code: "profile_not_found" },
  { method: "GET", path: `/api/v1/merchants/${MERCHANT}/unpaid?limit=0`, status: 400, code: "invalid_request", detailPath: "limit" },
  { method: "GET", path: `/api/v1/merchants/${MERCHANT}/subscribers?limit=0`, status: 400, code: "invalid_request", detailPath: "limit" },
  { method: "GET", path: `/api/v1/merchants/${MERCHANT}/churn?bucket=year`, status: 400, code: "invalid_request", detailPath: "bucket" },
  { method: "GET", path: `/api/v1/merchants/${MERCHANT}/cohorts?limit=0`, status: 400, code: "invalid_request", detailPath: "limit" },
  { method: "GET", path: `/api/v1/merchants/${MERCHANT}/revenue?from=1.5`, status: 400, code: "invalid_request", detailPath: "from" },
  { method: "GET", path: `/api/v1/merchants/${MERCHANT}/forecast?days=0`, status: 400, code: "invalid_request", detailPath: "days" },
  { method: "GET", path: `/api/v1/merchants/${MERCHANT}/charges.csv?from=1.5`, status: 400, code: "invalid_request", detailPath: "from" },
  { method: "GET", path: `/api/v1/merchants/${MERCHANT}/notification-preferences`, status: 400, code: "invalid_request", detailPath: "query" },
  {
    method: "GET",
    path: `/api/v1/merchants/${MERCHANT}/notification-preferences?timestamp=${NOW}&signature=${encodeURIComponent(WRONG_SIGNATURE)}`,
    status: 401,
    code: "unauthorized",
  },
  { method: "PUT", path: `/api/v1/merchants/${MERCHANT}/notification-preferences`, status: 400, code: "invalid_request", detailPath: "body" },
  {
    method: "PUT",
    path: `/api/v1/merchants/${MERCHANT}/notification-preferences`,
    status: 401,
    code: "unauthorized",
    body: { events: [], timestamp: NOW, signature: "not-a-signature" },
  },

  // Subscribers: validation, and the export that always needs a sign-in.
  { method: "GET", path: "/api/v1/subscribers/not-a-strkey/summary", status: 400, code: "invalid_request", detailPath: "address" },
  { method: "GET", path: `/api/v1/subscribers/${SUBSCRIBER}/charges.csv?to=1.5`, status: 400, code: "invalid_request", detailPath: "to" },
  { method: "GET", path: `/api/v1/subscribers/${SUBSCRIBER}/upcoming?days=0`, status: 400, code: "invalid_request", detailPath: "days" },
  { method: "GET", path: `/api/v1/subscribers/${SUBSCRIBER}/export`, status: 401, code: "unauthorized" },
  { method: "GET", path: "/api/v1/subscribers/not-a-strkey/export", status: 400, code: "invalid_request", detailPath: "address" },
  {
    method: "GET",
    path: `/api/v1/subscribers/${SUBSCRIBER}/export`,
    status: 401,
    code: "unauthorized",
    headers: { authorization: "Bearer not.a.jwt" },
  },

  // Vault and raw events.
  { method: "GET", path: "/api/v1/vault/not-a-strkey", status: 400, code: "invalid_request", detailPath: "address" },
  { method: "GET", path: `/api/v1/vault/${SUBSCRIBER}/events?limit=0`, status: 400, code: "invalid_request", detailPath: "limit" },
  { method: "GET", path: "/api/v1/events?unknown=1", status: 400, code: "invalid_request" },
  { method: "GET", path: "/api/v1/events?after=not-a-cursor", status: 400, code: "invalid_request" },

  // Tokens: a malformed id and a contract that cannot be read.
  { method: "GET", path: "/api/v1/tokens/not-a-token", status: 400, code: "invalid_token_id" },
  { method: "GET", path: `/api/v1/tokens/${UNREADABLE_TOKEN}`, status: 502, code: "token_metadata_unavailable" },

  // Protocol fees and the event stream filter.
  { method: "GET", path: "/api/v1/protocol/fees?bucket=year", status: 400, code: "invalid_request", detailPath: "bucket" },
  { method: "GET", path: "/api/v1/protocol/fees?limit=0", status: 400, code: "invalid_request", detailPath: "limit" },
  { method: "GET", path: "/api/v1/stream?merchant=not-a-strkey", status: 400, code: "invalid_request", detailPath: "merchant" },

  // SEP-10: a bad account, an unsupported memo and a non-challenge transaction.
  { method: "GET", path: "/api/v1/auth?account=not-a-strkey", status: 400, code: "invalid_request", detailPath: "query" },
  { method: "GET", path: `/api/v1/auth?account=${MERCHANT}&memo=1`, status: 400, code: "invalid_request", detailPath: "memo" },
  { method: "GET", path: `/api/v1/auth?account=${MERCHANT}&home_domain=evil.example`, status: 400, code: "invalid_request", detailPath: "home_domain" },
  { method: "POST", path: "/api/v1/auth", status: 400, code: "invalid_request", body: {} },
  { method: "POST", path: "/api/v1/auth", status: 400, code: "invalid_request", detailPath: "transaction", body: { transaction: "not-an-xdr" } },

  // Webhooks: registration, listing, deletion, rotation, test and deliveries.
  { method: "POST", path: "/api/v1/webhooks", status: 400, code: "invalid_request", detailPath: "body" },
  {
    method: "POST",
    path: "/api/v1/webhooks",
    status: 400,
    code: "invalid_request",
    detailPath: "signature",
    body: { merchant: MERCHANT, url: "https://payflow.example/hook", timestamp: NOW, signature: "short" },
  },
  { method: "GET", path: "/api/v1/webhooks", status: 400, code: "invalid_request", detailPath: "query" },
  {
    method: "GET",
    path: `/api/v1/webhooks?merchant=${MERCHANT}&timestamp=${NOW}&signature=${encodeURIComponent(WRONG_SIGNATURE)}`,
    status: 401,
    code: "unauthorized",
  },
  { method: "DELETE", path: "/api/v1/webhooks/not-an-id", status: 400, code: "invalid_request", detailPath: "id" },
  { method: "DELETE", path: "/api/v1/webhooks/1", status: 400, code: "invalid_request", detailPath: "query" },
  {
    method: "DELETE",
    path: `/api/v1/webhooks/1?merchant=${MERCHANT}&timestamp=${NOW}&signature=${encodeURIComponent(WRONG_SIGNATURE)}`,
    status: 401,
    code: "unauthorized",
  },
  { method: "POST", path: "/api/v1/webhooks/1/rotate", status: 400, code: "invalid_request", detailPath: "body" },
  { method: "POST", path: "/api/v1/webhooks/1/test", status: 400, code: "invalid_request", detailPath: "body" },
  { method: "GET", path: "/api/v1/webhooks/1/deliveries", status: 400, code: "invalid_request", detailPath: "query" },
  {
    method: "GET",
    path: `/api/v1/webhooks/1/deliveries?merchant=${MERCHANT}&timestamp=1&signature=x`,
    status: 401,
    code: "unauthorized",
  },

  // Operator routes: authentication comes before anything else.
  { method: "POST", path: "/admin/reindex", status: 401, code: "unauthorized" },
  {
    method: "POST",
    path: "/admin/keeper/run",
    status: 401,
    code: "unauthorized",
    headers: { authorization: "Bearer not-the-token" },
  },

  // Anything that names no route or method.
  { method: "GET", path: "/api/v1/no-such-route", status: 404, code: "not_found" },
  { method: "POST", path: "/api/v1/plans", status: 404, code: "not_found" },
];

async function call(row: ErrorCase): Promise<Response> {
  const headers: Record<string, string> = { ...row.headers };
  if (row.body !== undefined) headers["content-type"] = "application/json";
  return fetch(base + row.path, {
    method: row.method,
    headers,
    ...(row.body !== undefined ? { body: JSON.stringify(row.body) } : {}),
  });
}

describe("route error responses", () => {
  for (const row of CASES) {
    test(`${row.method} ${row.path} answers ${row.status} ${row.code}`, async () => {
      const res = await call(row);
      await assertErrorEnvelope(res, row, `${row.method} ${row.path}`);
    });
  }

  test("the alias and versioned prefixes answer with the same envelope", async () => {
    const bodies: ErrorEnvelope[] = [];
    for (const path of ["/api/mandates/999999", "/api/v1/mandates/999999"]) {
      const res = await fetch(base + path);
      bodies.push(await assertErrorEnvelope(res, { status: 404, code: "mandate_not_found" }, path));
    }
    // Identical copy, not just identical codes: the alias is the same router.
    assert.equal(bodies[0]?.error.message, bodies[1]?.error.message);
  });

  test("a caller-supplied X-Request-Id is echoed in the envelope", async () => {
    const res = await fetch(`${base}/api/v1/mandates/999999`, {
      headers: { "X-Request-Id": "envelope-test" },
    });
    assert.equal(res.headers.get("x-request-id"), "envelope-test");
    const body = await assertErrorEnvelope(
      res,
      { status: 404, code: "mandate_not_found" },
      "supplied request id",
    );
    assert.equal(body.error.requestId, "envelope-test");
  });

  test("an unauthenticated admin request names the missing token, not the resource", async () => {
    const res = await fetch(`${base}/admin/audit-logs`);
    const body = await assertErrorEnvelope(res, { status: 401, code: "unauthorized" }, "GET /admin/audit-logs");
    // The default copy for the code, never anything about the projection.
    assert.doesNotMatch(body.error.message, /audit log/i);
  });
});

/**
 * A structural sweep over the instance's own OpenAPI document: every path it
 * publishes must answer a method it does not support with the same envelope,
 * never an HTML or empty error. `openapi.test.ts` already pins the document to
 * the routes Express registers, so covering its paths covers the surface.
 */
describe("every documented route", () => {
  test("answers an unsupported method with the shared envelope", async () => {
    const document = await fetch(`${base}/api/openapi.json`).then(
      (res) => res.json() as Promise<{ paths: Record<string, Record<string, unknown>> }>,
    );
    const paths = Object.keys(document.paths);
    assert.ok(paths.length > 100, `the document describes only ${paths.length} paths`);

    for (const path of paths) {
      const item = document.paths[path] ?? {};
      const concrete = path.replace("{address}", MERCHANT).replace("{id}", "not-an-id");
      const res = await fetch(base + concrete, { method: "DELETE" });

      // Admin routes authenticate every method under /admin before routing.
      // The one documented DELETE handler validates its id before any proof.
      const expected =
        path.startsWith("/admin")
          ? { status: 401, code: "unauthorized" }
          : item.delete !== undefined
            ? { status: 400, code: "invalid_request" }
            : { status: 404, code: "not_found" };
      await assertErrorEnvelope(res, expected, `DELETE ${path}`);
    }
  });
});

/** The optional subsystems answer their documented "not available" codes. */
describe("unavailable subsystems", () => {
  test("answer 503 with the envelope and Retry-After, or 404 when the route is absent", async () => {
    const localDb = openDatabase(":memory:");
    const app = createApp(
      localDb,
      { CORS_ORIGIN: "*", ADMIN_TOKEN } as unknown as Config,
      undefined,
      {} as AdminHooks,
    );
    const local: Server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const addr = local.address();
    const localBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      const reindex = await fetch(`${localBase}/admin/reindex`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      await assertErrorEnvelope(reindex, { status: 503, code: "reindex_unavailable" }, "POST /admin/reindex");
      assert.equal(reindex.headers.get("retry-after"), "30", "reindex_unavailable Retry-After");

      const keeper = await fetch(`${localBase}/admin/keeper/run`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      await assertErrorEnvelope(keeper, { status: 503, code: "keeper_unavailable" }, "POST /admin/keeper/run");
      assert.equal(keeper.headers.get("retry-after"), "30", "keeper_unavailable Retry-After");

      // Without KEEPER_ENABLED or METRICS_ENABLED the paths do not exist at
      // all, so they fall through to the same not_found envelope as any typo.
      const history = await fetch(`${localBase}/api/keeper`);
      await assertErrorEnvelope(history, { status: 404, code: "not_found" }, "GET /api/keeper");

      const metrics = await fetch(`${localBase}/metrics`);
      await assertErrorEnvelope(metrics, { status: 404, code: "not_found" }, "GET /metrics");
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
      localDb.close();
    }
  });
});

/** Rate limiting is part of the error contract too. */
describe("rate-limited requests", () => {
  test("answer 429 rate_limited with Retry-After in the same envelope", async () => {
    const localDb = openDatabase(":memory:");
    const app = createApp(localDb, {
      CORS_ORIGIN: "*",
      API_RATE_LIMIT_MAX: 1,
      API_RATE_LIMIT_WINDOW_MS: 60_000,
    } as unknown as Config);
    const local: Server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const addr = local.address();
    const localBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      const allowed = await fetch(`${localBase}/api/plans`);
      assert.equal(allowed.status, 200);
      await allowed.arrayBuffer();

      const refused = await fetch(`${localBase}/api/plans`);
      await assertErrorEnvelope(refused, { status: 429, code: "rate_limited" }, "GET /api/plans (over the limit)");
      assert.match(refused.headers.get("retry-after") ?? "", /^\d+$/, "rate_limited Retry-After");
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
      localDb.close();
    }
  });
});

/** An unhandled failure is still the same envelope, with fixed copy. */
describe("unhandled failures", () => {
  test("answer 500 internal_error without echoing the failure", async () => {
    const res = await fetch(`${base}/api/v1/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"merchant":"GB343X',
    });
    const body = await assertErrorEnvelope(res, { status: 500, code: "internal_error" }, "truncated JSON body");
    assert.equal(body.error.message, "An internal error occurred.");
    assert.ok(!JSON.stringify(body).includes("GB343X"), "the caller's payload reached the error body");
  });

  test("the readiness probe is the one documented non-envelope 503", async () => {
    const localDb = openDatabase(":memory:");
    const app = createApp(localDb, { CORS_ORIGIN: "*" } as unknown as Config);
    const local: Server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const addr = local.address();
    const localBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      const res = await fetch(`${localBase}/ready`);
      assert.equal(res.status, 503);
      // `/ready` is a probe, not an error: its body is the probe's own
      // `{ status, lag }`, documented in the README's API table.
      const body = (await res.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["lag", "status"]);
      assert.equal(body.status, "starting");
      assert.equal(body.lag, null);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
      localDb.close();
    }
  });
});
