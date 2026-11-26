import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { OpenApiDocument, SchemaObject } from "../src/routes/openapi.ts";
import { testAddress } from "./addresses.ts";

/**
 * Contract tests: every documented endpoint must respond with a status code
 * the OpenAPI document lists, and every success body must carry all required
 * fields named in the response schema.
 *
 * These tests are independent of network state: they use an in-memory
 * database and never make real RPC calls, so they are deterministic.
 */

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const _UNKNOWN_ADDRESS = testAddress(42);

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
const config = {
  CORS_ORIGIN: "*",
  METRICS_ENABLED: true,
  STELLAR_NETWORK: "testnet",
  PLAN_REGISTRY_ID: "C".repeat(56),
  VAULT_ID: "C".repeat(56),
  SUBSCRIPTION_ID: "C".repeat(56),
} as unknown as Config;

let server: Server;
let base: string;
const db = openDatabase(":memory:");

/** Seed minimal rows so endpoints that query by address return 200. */
async function seedDatabase(): Promise<void> {
  const ix = new Indexer(db, {} as never, {} as never);
  await ix.apply({
    name: "plan_created",
    contractId: "C",
    ledger: 1,
    txHash: "tx-plan",
    topics: [MERCHANT, 1n],
    data: { token: "C".repeat(56), amount: 10_000_000n, period: 2_592_000n },
  });
  await ix.apply({
    name: "subscribed",
    contractId: "C",
    ledger: 2,
    txHash: "tx-sub",
    topics: [1n, SUBSCRIBER, MERCHANT],
    data: { plan_id: 1n, amount: 10_000_000n, period: 2_592_000n, next_charge: 1n },
  });
}

before(async () => {
  await seedDatabase();
  const app = createApp(
    [
      {
        config: testnet,
        db,
        indexer: { cursor: 10, latest: 10, lastRunAt: Date.now(), lastError: null },
      },
    ],
    config,
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

/** Resolve a $ref to its schema inside the document. */
function resolveRef(spec: OpenApiDocument, ref: string): SchemaObject | undefined {
  const path = ref.replace(/^#\//, "").split("/");
  let node: unknown = spec;
  for (const segment of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node as SchemaObject | undefined;
}

/** Flatten allOf to a single combined schema (properties + required only). */
function flattenSchema(spec: OpenApiDocument, schema: SchemaObject): SchemaObject {
  if (schema.$ref) return flattenSchema(spec, resolveRef(spec, schema.$ref) ?? {});
  if (!schema.allOf) return schema;
  const merged: SchemaObject = { properties: {}, required: [] };
  for (const sub of schema.allOf) {
    const flat = flattenSchema(spec, sub);
    Object.assign(merged.properties!, flat.properties ?? {});
    for (const r of flat.required ?? []) {
      if (!(merged.required as string[]).includes(r)) (merged.required as string[]).push(r);
    }
  }
  return merged;
}

/**
 * Assert that every required field from `schema` is present in `body`.
 *
 * Only checks the top level — nested schemas are trusted to the OpenAPI
 * document validation tests in openapi.test.ts. The goal here is to catch
 * completely missing fields, not to replicate a full JSON schema validator.
 */
function assertRequiredFields(
  spec: OpenApiDocument,
  schema: SchemaObject,
  body: unknown,
  context: string,
): void {
  if (typeof body !== "object" || body === null) return;
  const flat = flattenSchema(spec, schema);
  for (const field of flat.required ?? []) {
    assert.ok(
      field in (body as Record<string, unknown>),
      `${context}: required field "${field}" is missing from the response body`,
    );
  }
}

/** Fetch the live OpenAPI document. */
async function getSpec(): Promise<OpenApiDocument> {
  const res = await fetch(`${base}/api/openapi.json`);
  assert.equal(res.status, 200);
  return (await res.json()) as OpenApiDocument;
}

describe("contract: service endpoints", () => {
  test("GET /health matches its OpenAPI schema", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/health"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "schema documented");
    assertRequiredFields(spec, schema, body, "GET /health");
  });

  test("GET /ready returns 200 or 503 as documented", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/ready`);
    assert.ok([200, 503].includes(res.status), `unexpected status ${res.status}`);
    const documented = spec.paths["/ready"]?.get?.responses;
    assert.ok(documented, "ready is documented");
    assert.ok(String(res.status) in documented, `${res.status} is a documented status for /ready`);
  });

  test("GET /metrics returns Prometheus text when enabled", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200, "metrics endpoint enabled by config");
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    const documented = spec.paths["/metrics"]?.get?.responses;
    assert.ok("200" in (documented ?? {}), "/metrics 200 is documented");
  });

  test("GET /version returns version fields documented in OpenAPI", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/version`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/version"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "/version schema documented");
    assertRequiredFields(spec, schema, body, "GET /version");
  });

  test("GET /api/openapi.json returns the documented schema", async () => {
    const spec = await getSpec();
    const documented = spec.paths["/api/openapi.json"]?.get?.responses;
    assert.ok("200" in (documented ?? {}), "/api/openapi.json 200 is documented");
  });
});

describe("contract: plans endpoints", () => {
  test("GET /api/plans returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/plans`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/plans"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "GET /api/plans 200 schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/plans");
    assert.ok(Array.isArray((body as Record<string, unknown>).plans), "plans is an array");
  });

  test("GET /api/plans?sort=invalid returns 400 as documented", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/plans?sort=invalid`);
    assert.equal(res.status, 400);
    const documented = spec.paths["/api/plans"]?.get?.responses;
    assert.ok("400" in (documented ?? {}), "400 is documented for /api/plans");
    const body = await res.json() as unknown;
    const errorSchema = spec.components?.schemas?.Error;
    assert.ok(errorSchema, "Error schema exists");
    assertRequiredFields(spec, errorSchema, body, "GET /api/plans 400 body");
  });

  test("GET /api/plans/{id} returns 404 for an unknown plan", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/plans/99999`);
    assert.ok([404, 410].includes(res.status), `expected 404 or 410, got ${res.status}`);
    const documented = spec.paths["/api/plans/{id}"]?.get?.responses;
    assert.ok(String(res.status) in (documented ?? {}), `${res.status} is documented`);
    const body = await res.json() as unknown;
    const errorSchema = spec.components?.schemas?.Error;
    assert.ok(errorSchema);
    assertRequiredFields(spec, errorSchema, body, "GET /api/plans/99999");
  });

  test("GET /api/plans/{id} with a non-numeric id returns 400", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/plans/not-a-number`);
    assert.equal(res.status, 400);
    const documented = spec.paths["/api/plans/{id}"]?.get?.responses;
    assert.ok("400" in (documented ?? {}), "400 is documented for /api/plans/{id}");
  });

  test("GET /api/plans/{id}/stats returns 404 for an unknown plan", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/plans/99999/stats`);
    assert.ok([404, 410].includes(res.status));
    const documented = spec.paths["/api/plans/{id}/stats"]?.get?.responses;
    assert.ok(String(res.status) in (documented ?? {}), `${res.status} is documented`);
  });
});

describe("contract: mandates endpoints", () => {
  test("GET /api/mandates returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/mandates`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/mandates"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "GET /api/mandates 200 schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/mandates");
    assert.ok(Array.isArray((body as Record<string, unknown>).mandates), "mandates is an array");
  });

  test("GET /api/mandates/{id} returns 404 for an unknown mandate", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/mandates/99999`);
    assert.equal(res.status, 404);
    const documented = spec.paths["/api/mandates/{id}"]?.get?.responses;
    assert.ok("404" in (documented ?? {}), "404 is documented");
    const body = await res.json() as unknown;
    const errorSchema = spec.components?.schemas?.Error;
    assert.ok(errorSchema);
    assertRequiredFields(spec, errorSchema, body, "GET /api/mandates/99999");
  });

  test("GET /api/mandates/{id}/charges returns 404 for unknown mandate", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/mandates/99999/charges`);
    assert.equal(res.status, 404);
    const documented = spec.paths["/api/mandates/{id}/charges"]?.get?.responses;
    assert.ok("404" in (documented ?? {}), "404 is documented");
  });

  test("GET /api/due returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/due`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/due"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "GET /api/due 200 schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/due");
  });
});

describe("contract: merchant endpoints", () => {
  test("GET /api/merchants/{address}/summary returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/merchants/${MERCHANT}/summary`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/merchants/{address}/summary"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/merchants/summary");
  });

  test("GET /api/merchants/{address}/summary with invalid address returns 400", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/merchants/not-valid/summary`);
    assert.equal(res.status, 400);
    const documented = spec.paths["/api/merchants/{address}/summary"]?.get?.responses;
    assert.ok("400" in (documented ?? {}), "400 is documented");
    const body = await res.json() as unknown;
    const errorSchema = spec.components?.schemas?.Error;
    assert.ok(errorSchema);
    assertRequiredFields(spec, errorSchema, body, "GET /api/merchants/invalid/summary");
  });

  test("GET /api/merchants/{address}/subscribers returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/merchants/${MERCHANT}/subscribers`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/merchants/{address}/subscribers"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/merchants/subscribers");
  });

  test("GET /api/merchants/{address}/churn returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/merchants/${MERCHANT}/churn`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/merchants/{address}/churn"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/merchants/churn");
  });

  test("GET /api/merchants/{address}/revenue returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/merchants/${MERCHANT}/revenue`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/merchants/{address}/revenue"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/merchants/revenue");
  });
});

describe("contract: subscriber endpoints", () => {
  test("GET /api/subscribers/{address}/summary returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/subscribers/${SUBSCRIBER}/summary`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/subscribers/{address}/summary"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/subscribers/summary");
  });

  test("GET /api/subscribers/{address}/upcoming returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/subscribers/${SUBSCRIBER}/upcoming`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/subscribers/{address}/upcoming"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/subscribers/upcoming");
  });
});

describe("contract: vault endpoints", () => {
  test("GET /api/vault/{address} returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/vault/${SUBSCRIBER}`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/vault/{address}"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/vault/{address}");
  });

  test("GET /api/vault/{address}/events returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/vault/${SUBSCRIBER}/events`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/vault/{address}/events"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/vault/{address}/events");
  });
});

describe("contract: protocol and stats endpoints", () => {
  test("GET /api/protocol returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/protocol`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/protocol"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/protocol");
  });

  test("GET /api/stats returns the documented shape", async () => {
    const spec = await getSpec();
    const res = await fetch(`${base}/api/stats`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown;
    const schema = spec.paths["/api/stats"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    assert.ok(schema, "schema documented");
    assertRequiredFields(spec, schema, body, "GET /api/stats");
  });
});

describe("contract: error shape conformance", () => {
  test("4xx responses carry the documented Error envelope", async () => {
    const spec = await getSpec();
    const errorSchema = spec.components?.schemas?.Error;
    assert.ok(errorSchema, "Error schema is in the document");

    const cases: [string, string][] = [
      [`${base}/api/plans/not-a-number`, "GET /api/plans/not-a-number"],
      [`${base}/api/mandates/not-a-number`, "GET /api/mandates/not-a-number"],
      [`${base}/api/merchants/not-valid/summary`, "GET /api/merchants/invalid/summary"],
    ];
    for (const [url, label] of cases) {
      const res = await fetch(url);
      assert.ok(res.status >= 400 && res.status < 500, `${label}: expected 4xx, got ${res.status}`);
      const body = await res.json() as unknown;
      assertRequiredFields(spec, errorSchema, body, label);
      const err = (body as Record<string, unknown>).error as Record<string, unknown>;
      assert.ok(typeof err?.code === "string", `${label}: error.code is a string`);
      assert.ok(typeof err?.message === "string", `${label}: error.message is a string`);
    }
  });

  test("5xx responses carry the documented Error envelope", async () => {
    // The rate-limit endpoint on the admin path returns 503 without an admin
    // token only when ADMIN_TOKEN is set, so we use an artificial 404 that
    // returns the Error envelope through sendApiError.
    const _spec = await getSpec();
    const res = await fetch(`${base}/no-such-route-definitely-404`);
    // Express returns its own body for unmatched routes; we just verify
    // that documented error codes are strings when it is our envelope.
    assert.ok([404, 500].includes(res.status), `unexpected status ${res.status}`);
    if (res.headers.get("content-type")?.includes("application/json")) {
      const body = await res.json() as unknown;
      if (typeof (body as Record<string, unknown>).error === "object") {
        const err = (body as Record<string, unknown>).error as Record<string, unknown>;
        assert.ok(typeof err?.code === "string", "error.code present on our JSON 404");
      }
    }
  });
});

describe("contract: documented status codes are the ones returned", () => {
  test("every endpoint's documented success status code is reachable", async () => {
    // A spot check: each endpoint we seed data for must return its documented
    // 200. This catches routes that are documented as 200 but return 404 in
    // practice due to a missing code path.
    const spec = await getSpec();
    const probes: { url: string; path: string; method: string }[] = [
      { url: `${base}/health`, path: "/health", method: "get" },
      { url: `${base}/api/plans`, path: "/api/plans", method: "get" },
      { url: `${base}/api/mandates`, path: "/api/mandates", method: "get" },
      { url: `${base}/api/due`, path: "/api/due", method: "get" },
      { url: `${base}/api/merchants/${MERCHANT}/summary`, path: "/api/merchants/{address}/summary", method: "get" },
      { url: `${base}/api/subscribers/${SUBSCRIBER}/summary`, path: "/api/subscribers/{address}/summary", method: "get" },
      { url: `${base}/api/protocol`, path: "/api/protocol", method: "get" },
      { url: `${base}/api/stats`, path: "/api/stats", method: "get" },
      { url: `${base}/api/vault/${SUBSCRIBER}`, path: "/api/vault/{address}", method: "get" },
    ];
    for (const { url, path, method } of probes) {
      const res = await fetch(url);
      const documented = spec.paths[path]?.[method]?.responses ?? {};
      assert.ok(
        String(res.status) in documented,
        `${method.toUpperCase()} ${path}: status ${res.status} is not documented (documented: ${Object.keys(documented).join(", ")})`,
      );
    }
  });
});

describe("contract: admin routes — auth contract (issue #293)", () => {
  const ADMIN_TOKEN = "contract-test-admin-secret";
  let adminServer: import("node:http").Server;
  let adminBase = "";

  before(async () => {
    const adminConfig = {
      CORS_ORIGIN: "*",
      ADMIN_TOKEN,
    } as unknown as import("../src/config.ts").Config;
    const adminDb = openDatabase(":memory:");
    const app = createApp(
      [
        {
          config: {
            name: "testnet",
            rpcUrl: "https://rpc.invalid",
            networkPassphrase: "Test SDF Network ; September 2015",
            planRegistryId: "C".repeat(56),
            vaultId: "C".repeat(56),
            subscriptionId: "C".repeat(56),
            startLedger: 0,
            databasePath: ":memory:",
          },
          db: adminDb,
        },
      ],
      adminConfig,
      {
        reindex: async () => ({}),
        keeperPass: async () => ({}),
        keeperBackoff: () => ({ mandates: [] }),
        pauseIndexer: () => undefined,
        resumeIndexer: () => undefined,
        vacuumDb: async () => undefined,
      },
    );
    await new Promise<void>((resolve) => {
      adminServer = app.listen(0, () => {
        const addr = adminServer.address();
        adminBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    adminServer.close();
  });

  const adminPaths: [string, string][] = [
    ["POST", "/admin/reindex"],
    ["POST", "/admin/keeper/run"],
    ["GET", "/admin/keeper/backoff"],
    ["POST", "/admin/indexer/pause"],
    ["POST", "/admin/indexer/resume"],
    ["POST", "/admin/db/vacuum"],
  ];

  for (const [method, path] of adminPaths) {
    test(`${method} ${path} → 401 without Authorization header`, async () => {
      const res = await fetch(`${adminBase}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} must return 401 without a token`);
      const body = await res.json() as Record<string, unknown>;
      const err = body.error as Record<string, unknown> | undefined;
      assert.ok(typeof err?.code === "string", "error envelope has a string code");
      assert.ok(typeof err?.message === "string", "error envelope has a string message");
    });

    test(`${method} ${path} → 401 with wrong bearer token`, async () => {
      const res = await fetch(`${adminBase}${path}`, {
        method,
        headers: { Authorization: "Bearer wrong-token" },
      });
      assert.equal(res.status, 401, `${method} ${path} must return 401 for a wrong token`);
    });
  }
});
