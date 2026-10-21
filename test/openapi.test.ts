import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { OpenApiDocument, SchemaObject } from "../src/routes/openapi.ts";

/**
 * The OpenAPI description of the API.
 *
 * The document is only useful if it matches the service: a route that is not
 * in it is a route no client generator knows about, and a path in it that the
 * service does not serve is a promise the service does not keep. The test
 * therefore compares the document with the routes Express actually registers.
 */

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";

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
const mainnet: NetworkConfig = { ...testnet, name: "mainnet" };
const config = { CORS_ORIGIN: "*" } as unknown as Config;

let server: Server;
let base = "";
let app: Express;
const db = openDatabase(":memory:");
const mainnetDb = openDatabase(":memory:");

/** A route Express registered, as the method and the path pattern. */
interface DiscoveredRoute {
  method: string;
  path: string;
}

/**
 * Every route Express registered, wherever it is mounted.
 *
 * Express 5 keeps a mounted router's path in the layer's matcher and not in
 * a readable field, so the mount prefix is not recovered here: the paths are
 * compared by their tail instead (see `documentsRoute`).
 */
function collectRoutes(stack: unknown[]): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];
  for (const layer of stack as {
    route?: { path: string | string[]; methods: Record<string, boolean> };
    handle?: { stack?: unknown[] };
  }[]) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const method of Object.keys(layer.route.methods)) {
        if (method === "_all") continue;
        for (const path of paths) found.push({ method: method.toUpperCase(), path });
      }
      continue;
    }
    const nested = layer.handle?.stack;
    if (nested) found.push(...collectRoutes(nested));
  }
  return found;
}

/** The router stack of an Express app. */
function appRoutes(app: Express): DiscoveredRoute[] {
  const router = (app as unknown as { router?: { stack?: unknown[] } }).router;
  return collectRoutes(router?.stack ?? []);
}

/** Express writes `:id`; OpenAPI writes `{id}`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/**
 * Whether the document describes a discovered route.
 *
 * The document holds the full path (`/api/plans/{id}`) while the discovery
 * only knows the route's own pattern (`/plans/:id`), so the pattern is
 * matched against the tail of every documented path.
 */
function documentsRoute(spec: OpenApiDocument, route: DiscoveredRoute): boolean {
  const pattern = toOpenApiPath(route.path);
  return Object.entries(spec.paths).some(([path, item]) => {
    const operation = item[route.method.toLowerCase()];
    if (!operation) return false;
    return path === pattern || path.endsWith(pattern);
  });
}

/** Every schema in the document, including the ones nested in properties. */
function allSchemas(spec: OpenApiDocument): SchemaObject[] {
  const found: SchemaObject[] = [];
  const walk = (schema: SchemaObject | undefined): void => {
    if (!schema) return;
    found.push(schema);
    for (const child of Object.values(schema.properties ?? {})) walk(child);
    for (const child of schema.allOf ?? []) walk(child);
    if (schema.items) walk(schema.items);
  };
  for (const item of Object.values(spec.paths)) {
    for (const operation of Object.values(item)) {
      for (const response of Object.values(operation.responses)) {
        for (const content of Object.values(response.content ?? {})) walk(content.schema);
      }
    }
  }
  for (const schema of Object.values(spec.components?.schemas ?? {})) walk(schema);
  return found;
}

before(async () => {
  app = createApp(
    [
      { config: testnet, db, indexer: { cursor: 1, latest: 1, lastRunAt: null, lastError: null } },
      { config: mainnet, db: mainnetDb },
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
  mainnetDb.close();
});

const getSpec = async (): Promise<OpenApiDocument> => {
  const res = await fetch(`${base}/api/openapi.json`);
  assert.equal(res.status, 200);
  return (await res.json()) as OpenApiDocument;
};

describe("the OpenAPI document", () => {
  test("is served as an OpenAPI 3.1 document", async () => {
    const res = await fetch(`${base}/api/openapi.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const spec = (await res.json()) as OpenApiDocument;
    assert.equal(spec.openapi, "3.1.0");
    assert.equal(spec.info.title, "Payflow API");
    assert.ok(spec.info.version.length > 0);
  });

  test("covers every route Express serves", async () => {
    const spec = await getSpec();
    const routes = appRoutes(app);
    assert.ok(routes.length > 0, "the app has routes to check");
    // The discovery itself is checked first: a helper that found nothing
    // would make the comparison below pass without proving anything.
    const patterns = new Set(routes.map((route) => route.path));
    for (const known of [
      "/health",
      "/ready",
      "/plans",
      "/mandates/:id",
      "/due",
      "/api/openapi.json",
    ]) {
      assert.ok(patterns.has(known), `the route discovery found ${known}`);
    }
    for (const route of routes) {
      assert.ok(
        documentsRoute(spec, route),
        `${route.method} ${route.path} is missing from the OpenAPI document`,
      );
    }
  });

  test("covers /health and the routes beside the API", async () => {
    const spec = await getSpec();
    for (const path of ["/health", "/ready", "/metrics", "/api/openapi.json"]) {
      assert.ok(path in spec.paths, `${path} is missing from the OpenAPI document`);
    }
  });

  test("covers the API's routes for every network the instance serves", async () => {
    const spec = await getSpec();
    for (const path of [
      "/api/plans",
      "/api/plans/{id}",
      "/api/plans/{id}/stats",
      "/api/mandates",
      "/api/mandates/{id}",
      "/api/mandates/{id}/charges",
      "/api/due",
      "/api/merchants/{address}/summary",
      "/api/merchants/{address}/subscribers",
      "/api/merchants/{address}/churn",
      "/api/merchants/{address}/revenue",
      "/api/merchants/{address}/forecast",
      "/api/subscribers/{address}/summary",
      "/api/subscribers/{address}/upcoming",
      "/api/vault/{address}",
      "/api/vault/{address}/events",
      "/api/tokens/{id}",
      "/api/protocol",
      "/api/stats",
      "/api/stream",
      "/api/keeper",
    ]) {
      assert.ok(path in spec.paths, `${path} is missing from the OpenAPI document`);
    }
    // The second network's routes are the same ones under its own segment.
    assert.ok("/api/mainnet/plans" in spec.paths);
    assert.ok("/api/mainnet/merchants/{address}/summary" in spec.paths);
  });

  test("documents the operator routes behind their bearer token", async () => {
    const spec = await getSpec();
    for (const path of [
      "/admin/reindex",
      "/admin/keeper/run",
      "/admin/keeper/backoff",
      "/admin/indexer/pause",
      "/admin/indexer/resume",
    ]) {
      assert.ok(path in spec.paths, `${path} is missing from the OpenAPI document`);
      const item = spec.paths[path] ?? {};
      const operations = Object.values(item);
      assert.equal(operations.length, 1, `${path} has one operation`);
      assert.deepEqual(operations[0]?.security, [{ bearerAuth: [] }]);
    }
    assert.ok(spec.components?.securitySchemes?.bearerAuth);
  });

  test("gives every operation an id, a summary and a response", async () => {
    const spec = await getSpec();
    const ids = new Set<string>();
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        assert.ok(operation.summary.length > 0, `${method} ${path} has no summary`);
        assert.ok(operation.operationId.length > 0, `${method} ${path} has no operationId`);
        assert.ok(
          !ids.has(operation.operationId),
          `${operation.operationId} is used twice; operation ids must be unique`,
        );
        ids.add(operation.operationId);
        assert.ok(
          Object.keys(operation.responses).length > 0,
          `${method} ${path} documents no response`,
        );
      }
    }
  });

  test("documents amounts as decimal strings in the token's smallest unit", async () => {
    const spec = await getSpec();
    const amount = spec.components?.schemas?.AmountString;
    assert.ok(amount, "the document has a shared amount schema");
    assert.equal(amount.type, "string");
    assert.match(amount.description ?? "", /smallest unit/);
    assert.match(amount.description ?? "", /decimal string/i);

    // Every money field points at that schema, so no amount can be documented
    // as a JSON number.
    const money = [
      "amount",
      "fee",
      "balance",
      "gross",
      "mrr",
      "arr",
      "totalCollected",
      "totalPaid",
      "totalUpcoming",
      "totalFees",
      "volume24h",
      "volumeAllTime",
      "forecast",
      "required",
      "shortfall",
    ];
    for (const schema of allSchemas(spec)) {
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        if (!money.includes(name)) continue;
        assert.equal(
          property.$ref,
          "#/components/schemas/AmountString",
          `${name} is not documented as an amount string`,
        );
      }
    }

    // `net` is money in the revenue report and a count of mandates in the
    // churn report, so it is checked where it is known.
    const revenue = spec.components?.schemas?.RevenueBucket;
    assert.equal(revenue?.properties?.net?.$ref, "#/components/schemas/AmountString");
    assert.equal(revenue?.properties?.gross?.$ref, "#/components/schemas/AmountString");
    assert.equal(revenue?.properties?.fee?.$ref, "#/components/schemas/AmountString");
    const churn = spec.components?.schemas?.ChurnBucket;
    assert.equal(churn?.properties?.net?.type, "integer", "the churn net counts mandates");
  });

  test("documents the due list's funded flag", async () => {
    const spec = await getSpec();
    const due = spec.components?.schemas?.DueMandate;
    assert.ok(due);
    assert.equal(due.properties?.funded?.type, "boolean");
    assert.match(due.properties?.funded?.description ?? "", /balance/);
  });

  test("is JSON that a client can read without the service running", async () => {
    const spec = await getSpec();
    // The document is plain JSON: no functions, no undefined.
    const roundTripped = JSON.parse(JSON.stringify(spec)) as OpenApiDocument;
    assert.deepEqual(roundTripped.paths, spec.paths);
    assert.equal(roundTripped.paths[`/api/merchants/{address}/summary`]?.get?.operationId.startsWith("getMerchantSummary"), true);
  });

  test("the routes it documents are the ones the service answers", async () => {
    // A spot check that the documented paths are the ones in use: the
    // addresses in the README's examples resolve against them.
    const res = await fetch(`${base}/api/merchants/${MERCHANT}/summary`);
    assert.equal(res.status, 200);
    const sub = await fetch(`${base}/api/subscribers/${SUBSCRIBER}/summary`);
    assert.equal(sub.status, 200);
  });
});

describe("the OpenAPI document of a single-network instance", () => {
  test("does not mention networks it does not serve", async () => {
    const single = createApp(db, config);
    const local = await new Promise<Server>((resolve) => {
      const s = single.listen(0, () => resolve(s));
    });
    try {
      const addr = local.address();
      const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      const spec = (await (await fetch(`${url}/api/openapi.json`)).json()) as OpenApiDocument;
      assert.ok("/api/plans" in spec.paths);
      assert.ok("/api/testnet/plans" in spec.paths, "the default network answers under its own name too");
      assert.ok(!("/api/mainnet/plans" in spec.paths));
    } finally {
      local.close();
    }
  });
});

/**
 * The API changelog and the deprecation policy it carries.
 *
 * An integrator who reads only the OpenAPI document has to be able to find
 * what changed between releases and how long a deprecated field stays. The
 * link travels in the document's `externalDocs`, so a generated client carries
 * it too. The file behind the link is read here rather than trusted: a link to
 * a missing file is worse than no link, and a policy nobody can find is not a
 * policy.
 */
describe("the API changelog", () => {
  const CHANGELOG_URL = "https://github.com/MMM-pay/payflow-backend/blob/main/API_CHANGELOG.md";

  /** A file from the repository root, read from disk instead of over HTTP. */
  const repoFile = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

  test("is linked from the OpenAPI description", async () => {
    const spec = await getSpec();
    assert.equal(spec.externalDocs?.url, CHANGELOG_URL);
    assert.match(spec.info.description ?? "", /API_CHANGELOG\.md/);
  });

  test("records how long a deprecated field or route remains", () => {
    const changelog = repoFile("API_CHANGELOG.md");
    assert.match(changelog, /^# API changelog/m);
    assert.match(changelog, /^## Deprecation policy$/m);
    assert.match(changelog, /Deprecation/);
    assert.match(changelog, /Sunset/);
  });

  test("is linked from the README", () => {
    assert.match(repoFile("README.md"), /\[API_CHANGELOG\.md\]\(API_CHANGELOG\.md\)/);
  });
});
