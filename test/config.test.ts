import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { loadConfig, networkConfigs } from "../src/config.ts";

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

const ID = "C".repeat(56);

/** Environment holding only what the default network needs. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PLAN_REGISTRY_ID: ID,
    VAULT_ID: ID,
    SUBSCRIPTION_ID: ID,
    ...overrides,
  };
}

describe("network configs", () => {
  test("with no NETWORKS there is exactly the default network", () => {
    const config = loadConfig(env());
    const networks = networkConfigs(config, env());
    assert.equal(networks.length, 1);
    assert.equal(networks[0]!.name, "testnet");
    assert.equal(networks[0]!.databasePath, "./payflow.db");
  });

  test("an extra network is built from its prefixed variables", () => {
    const overrides = {
      NETWORKS: "mainnet",
      DATABASE_PATH: "/data/payflow.db",
      MAINNET_SOROBAN_RPC_URL: "https://mainnet.sorobanrpc.example",
      MAINNET_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      MAINNET_PLAN_REGISTRY_ID: ID,
      MAINNET_VAULT_ID: ID,
      MAINNET_SUBSCRIPTION_ID: ID,
      MAINNET_INDEXER_START_LEDGER: "5110418",
    };
    const config = loadConfig(env(overrides));
    const networks = networkConfigs(config, env(overrides));

    assert.deepEqual(networks.map((n) => n.name), ["testnet", "mainnet"]);
    const mainnet = networks[1]!;
    assert.equal(mainnet.rpcUrl, overrides.MAINNET_SOROBAN_RPC_URL);
    assert.equal(mainnet.startLedger, 5_110_418);
    // The default path is a template so both databases sit side by side.
    assert.equal(mainnet.databasePath, "/data/payflow-mainnet.db");
  });

  test("naming the default network in NETWORKS does not duplicate it", () => {
    const overrides = { NETWORKS: "testnet, testnet" };
    const config = loadConfig(env(overrides));
    const networks = networkConfigs(config, env(overrides));
    assert.equal(networks.length, 1);
  });

  test("a missing variable names the network and the variable", () => {
    const overrides = { NETWORKS: "mainnet" };
    const config = loadConfig(env(overrides));
    assert.throws(
      () => networkConfigs(config, env(overrides)),
      /Invalid configuration for network "mainnet"[\s\S]*MAINNET_VAULT_ID/,
    );
  });

  test("a name that is not a URL-safe segment is rejected", () => {
    const overrides = { NETWORKS: "main net" };
    const config = loadConfig(env(overrides));
    assert.throws(
      () => networkConfigs(config, env(overrides)),
      /Invalid network name "main net"/,
    );
  });
});
