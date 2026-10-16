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
