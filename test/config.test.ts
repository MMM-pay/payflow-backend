import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { loadConfig } from "../src/config.ts";

/** The minimum viable environment: contract ids pass the 56-char check. */
const BASE = {
  PLAN_REGISTRY_ID: "C".repeat(56),
  VAULT_ID: "C".repeat(56),
  SUBSCRIPTION_ID: "C".repeat(56),
};

describe("soroban rpc endpoints", () => {
  test("defaults to the public testnet endpoint when unset", () => {
    assert.deepEqual(loadConfig({ ...BASE }).SOROBAN_RPC_URL, [
      "https://soroban-testnet.stellar.org",
    ]);
  });

  test("a single URL stays a one-element list", () => {
    assert.deepEqual(
      loadConfig({ ...BASE, SOROBAN_RPC_URL: "https://a.example" }).SOROBAN_RPC_URL,
      ["https://a.example"],
    );
  });

  test("a comma-separated list is split, trimmed and deduplicated", () => {
    const env = " https://a.example , https://b.example,https://a.example ";
    assert.deepEqual(loadConfig({ ...BASE, SOROBAN_RPC_URL: env }).SOROBAN_RPC_URL, [
      "https://a.example",
      "https://b.example",
    ]);
  });

  test("blank segments are dropped", () => {
    assert.deepEqual(
      loadConfig({ ...BASE, SOROBAN_RPC_URL: "https://a.example,,https://b.example" })
        .SOROBAN_RPC_URL,
      ["https://a.example", "https://b.example"],
    );
  });

  test("a list is rejected when it contains a non-URL", () => {
    assert.throws(
      () => loadConfig({ ...BASE, SOROBAN_RPC_URL: "https://a.example,not-a-url" }),
      /SOROBAN_RPC_URL/,
    );
  });

  test("non-http(s) schemes are rejected", () => {
    assert.throws(
      () => loadConfig({ ...BASE, SOROBAN_RPC_URL: "ftp://a.example" }),
      /SOROBAN_RPC_URL/,
    );
  });

  test("an empty list is rejected", () => {
    assert.throws(() => loadConfig({ ...BASE, SOROBAN_RPC_URL: "" }), /SOROBAN_RPC_URL/);
    assert.throws(() => loadConfig({ ...BASE, SOROBAN_RPC_URL: " , " }), /SOROBAN_RPC_URL/);
  });
});

describe("keeper order", () => {
  test("KEEPER_ORDER defaults to oldest, today's settled behaviour", () => {
    assert.equal(loadConfig({ ...BASE }).KEEPER_ORDER, "oldest");
  });

  test("KEEPER_ORDER accepts oldest and largest", () => {
    assert.equal(loadConfig({ ...BASE, KEEPER_ORDER: "oldest" }).KEEPER_ORDER, "oldest");
    assert.equal(loadConfig({ ...BASE, KEEPER_ORDER: "largest" }).KEEPER_ORDER, "largest");
  });

  test("KEEPER_ORDER rejects anything else", () => {
    assert.throws(() => loadConfig({ ...BASE, KEEPER_ORDER: "newest" }), /KEEPER_ORDER/);
    assert.throws(() => loadConfig({ ...BASE, KEEPER_ORDER: "" }), /KEEPER_ORDER/);
  });
});

describe("environment schema", () => {
  test("loadConfig fills in the documented defaults", () => {
    const config = loadConfig({ ...BASE });
    assert.equal(config.STELLAR_NETWORK, "testnet");
    assert.deepEqual(config.SOROBAN_RPC_URL, ["https://soroban-testnet.stellar.org"]);
    assert.equal(config.NETWORK_PASSPHRASE, "Test SDF Network ; September 2015");
    assert.equal(config.KEEPER_ENABLED, false);
    assert.equal(config.KEEPER_INTERVAL_MS, 60_000);
    assert.equal(config.INDEXER_INTERVAL_MS, 10_000);
    assert.equal(config.INDEXER_START_LEDGER, 0);
    assert.equal(config.INDEXER_FETCH_CONCURRENCY, 4);
    assert.equal(config.PORT, 8080);
    assert.equal(config.DATABASE_PATH, "./payflow.db");
    assert.equal(config.CORS_ORIGIN, "*");
    assert.equal(config.LOG_LEVEL, "info");
    assert.equal(config.SHUTDOWN_TIMEOUT_MS, 15_000);
    assert.equal(config.TOKEN_ID, undefined);
    assert.equal(config.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  });

  test("numeric variables are coerced from their env strings", () => {
    const config = loadConfig({
      ...BASE,
      PORT: "9000",
      KEEPER_INTERVAL_MS: "1500",
      INDEXER_FETCH_CONCURRENCY: "1",
      SHUTDOWN_TIMEOUT_MS: "500",
    });
    assert.equal(config.PORT, 9000);
    assert.equal(config.KEEPER_INTERVAL_MS, 1500);
    assert.equal(config.INDEXER_FETCH_CONCURRENCY, 1);
    assert.equal(config.SHUTDOWN_TIMEOUT_MS, 500);
  });

  test("KEEPER_ENABLED is a boolean, not the string 'false'", () => {
    assert.equal(loadConfig({ ...BASE }).KEEPER_ENABLED, false);
    assert.equal(
      loadConfig({ ...BASE, KEEPER_ENABLED: "true", KEEPER_SECRET: "S".repeat(56) })
        .KEEPER_ENABLED,
      true,
    );
  });

  /** Runs loadConfig and returns the thrown message, or null when it succeeds. */
  function failure(env: Record<string, string>): string | null {
    try {
      loadConfig(env);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }

  test("a missing contract id is named in the error", () => {
    const message = failure({ PLAN_REGISTRY_ID: "C".repeat(56), VAULT_ID: "C".repeat(56) });
    assert.ok(message !== null);
    assert.match(message, /^Invalid environment configuration:/);
    assert.match(message, /SUBSCRIPTION_ID/);
  });

  test("a malformed contract id is rejected with its length", () => {
    const message = failure({ ...BASE, VAULT_ID: "too-short" });
    assert.ok(message !== null);
    assert.match(message, /VAULT_ID/);
    // Same meaning as zod 3's "String must contain at least 56 character(s)".
    assert.match(message, /56/);
  });

  test("a bare host is rejected as an rpc url", () => {
    const message = failure({ ...BASE, SOROBAN_RPC_URL: "soroban.local" });
    assert.ok(message !== null);
    assert.match(message, /SOROBAN_RPC_URL/);
    assert.match(message, /URL/);
  });

  // zod 4 replaced `z.string().url()` with the top-level `z.url()` format
  // validator, which validates through the WHATWG URL parser. This pins what
  // the migration actually accepts and rejects at startup.
  test("z.url() validates the otel endpoint and names it when rejected", () => {
    assert.equal(
      loadConfig({ ...BASE, OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" })
        .OTEL_EXPORTER_OTLP_ENDPOINT,
      "http://localhost:4318",
    );
    const message = failure({ ...BASE, OTEL_EXPORTER_OTLP_ENDPOINT: "definitely not a url" });
    assert.ok(message !== null);
    assert.match(message, /OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  test("non-numeric, non-integer and out-of-range numbers are rejected", () => {
    const cases: [string, string][] = [
      ["PORT", "not-a-port"],
      ["PORT", "0"],
      ["PORT", "-1"],
      ["INDEXER_INTERVAL_MS", "1.5"],
      ["INDEXER_START_LEDGER", "-1"],
      ["INDEXER_FETCH_CONCURRENCY", "0"],
      ["INDEXER_FETCH_CONCURRENCY", "17"],
      ["SHUTDOWN_TIMEOUT_MS", "soon"],
    ];
    for (const [key, value] of cases) {
      const message = failure({ ...BASE, [key]: value });
      assert.ok(message !== null, `${key}=${value} should be rejected`);
      assert.match(message, new RegExp(key));
    }
  });

  test("the error names variables but never their values", () => {
    const secret = "SABCdef456SECRETvalue";
    const message = failure({
      ...BASE,
      KEEPER_SECRET: secret,
      PORT: "-1",
      SOROBAN_RPC_URL: "https://user:password@soroban.local,not-a-url",
    });
    assert.ok(message !== null);
    assert.ok(message.includes("PORT"));
    assert.ok(!message.includes(secret), "the keeper secret must never be echoed");
    assert.ok(!message.includes("-1"), "the offending value must not be echoed");
    assert.ok(!message.includes("password"), "url credentials must not be echoed");
  });

  test("enabling the keeper without a secret fails", () => {
    const message = failure({ ...BASE, KEEPER_ENABLED: "true" });
    assert.equal(message, "KEEPER_ENABLED=true requires KEEPER_SECRET to be set");
  });
});
