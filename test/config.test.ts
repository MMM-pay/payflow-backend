import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { loadConfig, networkConfigs } from "../src/config.ts";

/** The minimum viable environment: contract ids pass the 56-char check. */
const VALID_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));
const BASE = {
  PLAN_REGISTRY_ID: VALID_CONTRACT_ID,
  VAULT_ID: VALID_CONTRACT_ID,
  SUBSCRIPTION_ID: VALID_CONTRACT_ID,
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

describe("metrics configuration", () => {
  test("is disabled by default and accepts the explicit opt-in", () => {
    assert.equal(loadConfig({ ...BASE }).METRICS_ENABLED, false);
    assert.equal(loadConfig({ ...BASE, METRICS_ENABLED: "true" }).METRICS_ENABLED, true);
    assert.equal(loadConfig({ ...BASE, METRICS_ENABLED: "false" }).METRICS_ENABLED, false);
  });
});

describe("keeper merchants", () => {
  const A = Keypair.random().publicKey();
  const B = Keypair.random().publicKey();

  test("defaults to empty, meaning every merchant", () => {
    assert.deepEqual(loadConfig({ ...BASE }).KEEPER_MERCHANTS, []);
    assert.deepEqual(loadConfig({ ...BASE, KEEPER_MERCHANTS: "" }).KEEPER_MERCHANTS, []);
  });

  test("splits on commas, trimming blanks and duplicates", () => {
    assert.deepEqual(
      loadConfig({ ...BASE, KEEPER_MERCHANTS: ` ${A} ,,${B},${A}` }).KEEPER_MERCHANTS,
      [A, B],
    );
  });

  test("rejects anything that is not an account address", () => {
    assert.throws(() => loadConfig({ ...BASE, KEEPER_MERCHANTS: `${A},nope` }), /KEEPER_MERCHANTS/);
    assert.throws(
      () => loadConfig({ ...BASE, KEEPER_MERCHANTS: VALID_CONTRACT_ID }),
      /KEEPER_MERCHANTS/,
    );
  });
});

describe("keeper channel secrets", () => {
  test("defaults to no channels, so single-key setups are untouched", () => {
    assert.deepEqual(loadConfig({ ...BASE }).KEEPER_CHANNEL_SECRETS, []);
  });

  test("a comma-separated list is split, trimmed and kept in order", () => {
    const a = Keypair.random().secret();
    const b = Keypair.random().secret();
    assert.deepEqual(
      loadConfig({ ...BASE, KEEPER_CHANNEL_SECRETS: ` ${a} , ${b}` }).KEEPER_CHANNEL_SECRETS,
      [a, b],
    );
  });

  test("blanks between commas are dropped", () => {
    const a = Keypair.random().secret();
    assert.deepEqual(
      loadConfig({ ...BASE, KEEPER_CHANNEL_SECRETS: `,${a},` }).KEEPER_CHANNEL_SECRETS,
      [a],
    );
  });

  test("anything that is not a Stellar secret seed is rejected", () => {
    assert.throws(
      () => loadConfig({ ...BASE, KEEPER_CHANNEL_SECRETS: "not-a-secret" }),
      /KEEPER_CHANNEL_SECRETS/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          KEEPER_CHANNEL_SECRETS: `${Keypair.random().secret()},GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH`,
        }),
      /KEEPER_CHANNEL_SECRETS/,
      "a public key is not a signing secret",
    );
  });

  test("a malformed channel secret fails startup without printing the secret", () => {
    // One character off a real seed: the checksum fails, and the error
    // must name the variable, never echo the value.
    const real = Keypair.random().secret();
    const broken = `${real.slice(0, -1)}${real.endsWith("A") ? "B" : "A"}`;
    assert.throws(
      () => loadConfig({ ...BASE, KEEPER_SECRET: real, KEEPER_CHANNEL_SECRETS: broken }),
      (err: Error) => {
        assert.match(err.message, /KEEPER_CHANNEL_SECRETS/);
        assert.ok(!err.message.includes(broken), "the rejected secret is not in the message");
        assert.ok(!err.message.includes(real), "no other secret is in the message either");
        return true;
      },
    );
  });
});

describe("keeper channel balance threshold", () => {
  test("defaults to two XLM and accepts up to seven decimal places", () => {
    assert.equal(loadConfig({ ...BASE }).KEEPER_CHANNEL_MIN_XLM, "2");
    assert.equal(
      loadConfig({ ...BASE, KEEPER_CHANNEL_MIN_XLM: "0.0000001" }).KEEPER_CHANNEL_MIN_XLM,
      "0.0000001",
    );
  });

  test("rejects malformed or over-precise XLM balances", () => {
    for (const value of ["-1", "1e2", "0.00000001", "1."]) {
      assert.throws(
        () => loadConfig({ ...BASE, KEEPER_CHANNEL_MIN_XLM: value }),
        /KEEPER_CHANNEL_MIN_XLM/,
      );
    }
  });
});

describe("keeper backoff settings (#248)", () => {
  test("default to 60 s doubling up to 6 h, with 10% jitter", () => {
    const config = loadConfig({ ...BASE });
    assert.deepEqual(
      [config.KEEPER_BACKOFF_BASE_S, config.KEEPER_BACKOFF_MULTIPLIER, config.KEEPER_BACKOFF_MAX_S, config.KEEPER_BACKOFF_JITTER],
      [60, 2, 21_600, 0.1],
    );
  });

  test("accept a valid schedule, a fractional multiplier and jitter turned off", () => {
    const config = loadConfig({
      ...BASE,
      KEEPER_BACKOFF_BASE_S: "30",
      KEEPER_BACKOFF_MULTIPLIER: "1.5",
      KEEPER_BACKOFF_MAX_S: "30",
      KEEPER_BACKOFF_JITTER: "0",
    });
    assert.deepEqual(
      [config.KEEPER_BACKOFF_BASE_S, config.KEEPER_BACKOFF_MULTIPLIER, config.KEEPER_BACKOFF_MAX_S, config.KEEPER_BACKOFF_JITTER],
      [30, 1.5, 30, 0],
    );
  });

  test("an invalid value fails startup with its name", () => {
    const invalid: [Record<string, string>, RegExp][] = [
      [{ KEEPER_BACKOFF_BASE_S: "0" }, /KEEPER_BACKOFF_BASE_S: must be at least 1 second/],
      [{ KEEPER_BACKOFF_BASE_S: "-60" }, /KEEPER_BACKOFF_BASE_S/],
      [{ KEEPER_BACKOFF_BASE_S: "1.5" }, /KEEPER_BACKOFF_BASE_S/],
      [{ KEEPER_BACKOFF_BASE_S: "soon" }, /KEEPER_BACKOFF_BASE_S/],
      [{ KEEPER_BACKOFF_MULTIPLIER: "0.5" }, /KEEPER_BACKOFF_MULTIPLIER: must be at least 1/],
      [{ KEEPER_BACKOFF_MULTIPLIER: "0" }, /KEEPER_BACKOFF_MULTIPLIER/],
      [{ KEEPER_BACKOFF_MAX_S: "0" }, /KEEPER_BACKOFF_MAX_S/],
      [{ KEEPER_BACKOFF_MAX_S: "604801" }, /KEEPER_BACKOFF_MAX_S: must be at most 604800/],
      [{ KEEPER_BACKOFF_JITTER: "-0.1" }, /KEEPER_BACKOFF_JITTER/],
      [{ KEEPER_BACKOFF_JITTER: "0.6" }, /KEEPER_BACKOFF_JITTER: must be between 0 and 0.5/],
    ];
    for (const [env, message] of invalid) {
      assert.throws(() => loadConfig({ ...BASE, ...env }), message, JSON.stringify(env));
    }
  });

  test("a cap below the base delay fails startup", () => {
    assert.throws(
      () => loadConfig({ ...BASE, KEEPER_BACKOFF_BASE_S: "600", KEEPER_BACKOFF_MAX_S: "300" }),
      /KEEPER_BACKOFF_MAX_S=300 is below KEEPER_BACKOFF_BASE_S=600/,
    );
    // Equal is a flat schedule, which is allowed.
    assert.equal(loadConfig({ ...BASE, KEEPER_BACKOFF_BASE_S: "300", KEEPER_BACKOFF_MAX_S: "300" }).KEEPER_BACKOFF_MAX_S, 300);
  });

  test("a cap that outlasts the attempt log fails startup, unless the log is kept forever", () => {
    const env = { ...BASE, KEEPER_BACKOFF_MAX_S: String(2 * 86_400) };
    assert.throws(
      () => loadConfig({ ...env, CHARGE_ATTEMPT_RETENTION_DAYS: "1" }),
      /KEEPER_BACKOFF_MAX_S=172800 outlasts CHARGE_ATTEMPT_RETENTION_DAYS=1/,
    );
    assert.equal(loadConfig({ ...env, CHARGE_ATTEMPT_RETENTION_DAYS: "2" }).KEEPER_BACKOFF_MAX_S, 172_800);
    assert.equal(loadConfig({ ...env, CHARGE_ATTEMPT_RETENTION_DAYS: "0" }).KEEPER_BACKOFF_MAX_S, 172_800);
  });
});

describe("keeper concurrency cap (KEEPER_CONCURRENCY)", () => {
  const primary = Keypair.random().secret();
  const channelB = Keypair.random().secret();
  const channelC = Keypair.random().secret();

  test("unset or blank means one transaction per channel", () => {
    assert.equal(loadConfig({ ...BASE }).KEEPER_CONCURRENCY, undefined);
    assert.equal(loadConfig({ ...BASE, KEEPER_CONCURRENCY: "" }).KEEPER_CONCURRENCY, undefined);
  });

  test("accepts a cap up to the number of channel accounts", () => {
    const env = { ...BASE, KEEPER_SECRET: primary, KEEPER_CHANNEL_SECRETS: `${channelB},${channelC}` };
    assert.equal(loadConfig({ ...env, KEEPER_CONCURRENCY: "1" }).KEEPER_CONCURRENCY, 1);
    assert.equal(loadConfig({ ...env, KEEPER_CONCURRENCY: "3" }).KEEPER_CONCURRENCY, 3);
  });

  test("zero, negative, fractional and non-numeric caps are rejected", () => {
    for (const bad of ["0", "-1", "1.5", "two"]) {
      assert.throws(
        () => loadConfig({ ...BASE, KEEPER_SECRET: primary, KEEPER_CONCURRENCY: bad }),
        /KEEPER_CONCURRENCY/,
        `KEEPER_CONCURRENCY=${bad} is rejected`,
      );
    }
  });

  test("a cap above the channel count is rejected at startup, naming counts but no secret", () => {
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          KEEPER_SECRET: primary,
          KEEPER_CHANNEL_SECRETS: channelB,
          KEEPER_CONCURRENCY: "3",
        }),
      (err: Error) => {
        assert.match(err.message, /KEEPER_CONCURRENCY=3 exceeds the 2 keeper channel account/);
        for (const secret of [primary, channelB]) {
          assert.ok(!err.message.includes(secret), "no secret is printed");
        }
        return true;
      },
    );
  });

  test("duplicate and standby keys do not count as extra channels", () => {
    // KEEPER_SECRET_NEXT is a standby inside the primary channel, and a
    // repeated channel key collapses, exactly as the keeper builds them.
    const next = Keypair.random().secret();
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          KEEPER_SECRET: primary,
          KEEPER_SECRET_NEXT: next,
          KEEPER_CHANNEL_SECRETS: `${primary},${next},${channelB},${channelB}`,
          KEEPER_CONCURRENCY: "3",
        }),
      /exceeds the 2 keeper channel account/,
    );
  });

  test("KEEPER_CLAIM_TTL_S defaults to five minutes and refuses less than a minute", () => {
    assert.equal(loadConfig({ ...BASE }).KEEPER_CLAIM_TTL_S, 300);
    assert.equal(loadConfig({ ...BASE, KEEPER_CLAIM_TTL_S: "120" }).KEEPER_CLAIM_TTL_S, 120);
    assert.throws(() => loadConfig({ ...BASE, KEEPER_CLAIM_TTL_S: "10" }), /KEEPER_CLAIM_TTL_S/);
  });
});

describe("keeper inclusion fee configuration", () => {
  test("uses the default percentile and cap", () => {
    const config = loadConfig(env());
    assert.equal(config.KEEPER_FEE_PERCENTILE, "90");
    assert.equal(config.KEEPER_MAX_FEE, 100_000n);
  });

  test("rejects unsupported percentiles and fees below BASE_FEE", () => {
    assert.throws(() => loadConfig(env({ KEEPER_FEE_PERCENTILE: "85" })), /KEEPER_FEE_PERCENTILE/);
    assert.throws(() => loadConfig(env({ KEEPER_MAX_FEE: "1" })), /KEEPER_MAX_FEE/);
  });
});

describe("keeper dry-run configuration", () => {
  test("KEEPER_DRY_RUN defaults to off: a normal pass submits", () => {
    assert.equal(loadConfig({ ...BASE }).KEEPER_DRY_RUN, false);
    assert.equal(loadConfig({ ...BASE, KEEPER_DRY_RUN: "false" }).KEEPER_DRY_RUN, false);
  });

  test("KEEPER_DRY_RUN=true turns the rehearsal on", () => {
    assert.equal(loadConfig({ ...BASE, KEEPER_DRY_RUN: "true" }).KEEPER_DRY_RUN, true);
  });
});

describe("required credentials", () => {
  test("refuses to enable the keeper without its signing secret", () => {
    assert.throws(
      () => loadConfig(env({ KEEPER_ENABLED: "true" })),
      /KEEPER_ENABLED=true requires KEEPER_SECRET to be set/,
    );
  });

  test("starts the keeper when its secret is present", () => {
    const secret = Keypair.random().secret();
    assert.equal(
      loadConfig(env({ KEEPER_ENABLED: "true", KEEPER_SECRET: secret })).KEEPER_ENABLED,
      true,
    );
  });

  test("refuses to configure SEP-10 without its JWT secret and home domain", () => {
    assert.throws(
      () => loadConfig(env({ SEP10_SIGNING_KEY: Keypair.random().secret() })),
      /SEP10_SIGNING_KEY requires SEP10_JWT_SECRET and SEP10_HOME_DOMAIN to be set/,
    );
  });

  test("starts SEP-10 when all required credentials are present", () => {
    assert.doesNotThrow(() =>
      loadConfig(env({
        SEP10_SIGNING_KEY: Keypair.random().secret(),
        SEP10_JWT_SECRET: "a".repeat(32),
        SEP10_HOME_DOMAIN: "example.com",
      })),
    );
  });
});

const ID = VALID_CONTRACT_ID;

/** Environment holding only what the default network needs. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PLAN_REGISTRY_ID: ID,
    VAULT_ID: ID,
    SUBSCRIPTION_ID: ID,
    ...overrides,
  };
}

describe("reconciliation", () => {
  test("defaults to a ten-minute interval and a 25-mandate sample", () => {
    const config = loadConfig(env());
    assert.equal(config.RECONCILE_INTERVAL_MS, 600_000);
    assert.equal(config.RECONCILE_SAMPLE_SIZE, 25);
  });

  test("rejects a non-positive interval and sample size", () => {
    assert.throws(() => loadConfig(env({ RECONCILE_INTERVAL_MS: "0" })), /RECONCILE_INTERVAL_MS/);
    assert.throws(() => loadConfig(env({ RECONCILE_INTERVAL_MS: "-1" })), /RECONCILE_INTERVAL_MS/);
    assert.throws(() => loadConfig(env({ RECONCILE_SAMPLE_SIZE: "0" })), /RECONCILE_SAMPLE_SIZE/);
  });
});

describe("network configs", () => {
  test("with no NETWORKS there is exactly the default network", () => {
    const config = loadConfig(env());
    const networks = networkConfigs(config, env());
    assert.equal(networks.length, 1);
    assert.equal(networks[0]!.name, "testnet");
    assert.equal(networks[0]!.databasePath, "./payflow.db");
  });

  test("DATABASE_URL selects PostgreSQL for every configured network", () => {
    const overrides = {
      DATABASE_URL: "postgres://payflow:secret@db.example/payflow",
      NETWORKS: "mainnet",
      MAINNET_SOROBAN_RPC_URL: "https://mainnet.sorobanrpc.example",
      MAINNET_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      MAINNET_PLAN_REGISTRY_ID: VALID_CONTRACT_ID,
      MAINNET_VAULT_ID: VALID_CONTRACT_ID,
      MAINNET_SUBSCRIPTION_ID: VALID_CONTRACT_ID,
    };
    const config = loadConfig({ ...BASE, ...overrides });
    const networks = networkConfigs(config, { ...BASE, ...overrides });
    assert.deepEqual(networks.map((network) => network.databaseUrl), [overrides.DATABASE_URL, overrides.DATABASE_URL]);
  });

  test("DATABASE_URL gives every network the same pool sizing and timeouts (#263)", () => {
    const overrides = {
      DATABASE_URL: "postgres://payflow:secret@db.example/payflow",
      DATABASE_POOL_MAX: "20",
      DATABASE_ACQUIRE_TIMEOUT_MS: "2000",
      DATABASE_STATEMENT_TIMEOUT_MS: "5000",
      NETWORKS: "mainnet",
      MAINNET_SOROBAN_RPC_URL: "https://mainnet.sorobanrpc.example",
      MAINNET_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      MAINNET_PLAN_REGISTRY_ID: VALID_CONTRACT_ID,
      MAINNET_VAULT_ID: VALID_CONTRACT_ID,
      MAINNET_SUBSCRIPTION_ID: VALID_CONTRACT_ID,
    };
    const networks = networkConfigs(loadConfig(env(overrides)), env(overrides));
    assert.equal(networks.length, 2);
    for (const network of networks) {
      assert.deepEqual(network.pool, {
        max: 20,
        acquireTimeoutMs: 2_000,
        statementTimeoutMs: 5_000,
      });
    }
  });

  test("the pool defaults are bounded: 10 connections, 10 s to acquire, 30 s per statement", () => {
    const config = loadConfig(env());
    assert.equal(config.DATABASE_POOL_MAX, 10);
    assert.equal(config.DATABASE_ACQUIRE_TIMEOUT_MS, 10_000);
    assert.equal(config.DATABASE_STATEMENT_TIMEOUT_MS, 30_000);
  });

  test("a pool of zero, more than 100, or a zero timeout is rejected", () => {
    assert.throws(() => loadConfig(env({ DATABASE_POOL_MAX: "0" })), /DATABASE_POOL_MAX/);
    assert.throws(() => loadConfig(env({ DATABASE_POOL_MAX: "101" })), /DATABASE_POOL_MAX/);
    assert.throws(
      () => loadConfig(env({ DATABASE_ACQUIRE_TIMEOUT_MS: "0" })),
      /DATABASE_ACQUIRE_TIMEOUT_MS/,
    );
    assert.throws(
      () => loadConfig(env({ DATABASE_STATEMENT_TIMEOUT_MS: "-1" })),
      /DATABASE_STATEMENT_TIMEOUT_MS/,
    );
  });

  test("DATABASE_URL must use PostgreSQL protocol", () => {
    assert.throws(
      () => loadConfig({ ...BASE, DATABASE_URL: "https://db.example/payflow" }),
      /DATABASE_URL: must use a postgres URL/,
    );
    assert.equal(loadConfig({ ...BASE, DATABASE_URL: "" }).DATABASE_URL, undefined);
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

  test("every network carries the indexer progress cadence, 10,000 ledgers by default", () => {
    assert.equal(loadConfig(env()).INDEXER_PROGRESS_LEDGERS, 10_000);
    assert.equal(networkConfigs(loadConfig(env()), env())[0]!.progressLedgers, 10_000);
    const overrides = { INDEXER_PROGRESS_LEDGERS: "0" };
    assert.equal(networkConfigs(loadConfig(env(overrides)), env(overrides))[0]!.progressLedgers, 0);
    assert.throws(() => loadConfig(env({ INDEXER_PROGRESS_LEDGERS: "-1" })), /INDEXER_PROGRESS_LEDGERS/);
  });

  test("every network carries the indexing batch size and poll interval (#241)", () => {
    const defaults = loadConfig(env());
    assert.equal(defaults.INDEXER_BATCH_SIZE, 8_000, "the RPC's own getEvents window");
    assert.equal(defaults.INDEXER_INTERVAL_MS, 10_000);
    const [network] = networkConfigs(defaults, env());
    assert.equal(network!.batchSize, 8_000);
    assert.equal(network!.indexerIntervalMs, 10_000);

    const tuned = { INDEXER_BATCH_SIZE: "1000", INDEXER_INTERVAL_MS: "2500" };
    const [tunedNetwork] = networkConfigs(loadConfig(env(tuned)), env(tuned));
    assert.equal(tunedNetwork!.batchSize, 1_000);
    assert.equal(tunedNetwork!.indexerIntervalMs, 2_500);
  });

  test("a network overrides the batch size and poll interval with its own prefix (#241)", () => {
    const overrides = {
      NETWORKS: "mainnet",
      MAINNET_SOROBAN_RPC_URL: "https://mainnet.sorobanrpc.example",
      MAINNET_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      MAINNET_PLAN_REGISTRY_ID: VALID_CONTRACT_ID,
      MAINNET_VAULT_ID: VALID_CONTRACT_ID,
      MAINNET_SUBSCRIPTION_ID: VALID_CONTRACT_ID,
      MAINNET_INDEXER_BATCH_SIZE: "1000",
      MAINNET_INDEXER_INTERVAL_MS: "2500",
    };
    const networks = networkConfigs(loadConfig(env(overrides)), env(overrides));
    const mainnet = networks.find((network) => network.name === "mainnet")!;
    const testnet = networks.find((network) => network.name !== "mainnet")!;
    assert.equal(mainnet.batchSize, 1_000);
    assert.equal(mainnet.indexerIntervalMs, 2_500);
    assert.equal(testnet.batchSize, 8_000, "the other network keeps the default");
    assert.equal(testnet.indexerIntervalMs, 10_000);

    assert.throws(
      () => networkConfigs(loadConfig(env({ ...overrides, MAINNET_INDEXER_BATCH_SIZE: "8001" })), env({ ...overrides, MAINNET_INDEXER_BATCH_SIZE: "8001" })),
      /MAINNET_INDEXER_BATCH_SIZE/,
    );
  });

  test("rejects a batch size outside 1-8000 and a non-positive poll interval", () => {
    assert.throws(() => loadConfig(env({ INDEXER_BATCH_SIZE: "0" })), /INDEXER_BATCH_SIZE/);
    assert.throws(() => loadConfig(env({ INDEXER_BATCH_SIZE: "8001" })), /INDEXER_BATCH_SIZE/);
    assert.throws(() => loadConfig(env({ INDEXER_BATCH_SIZE: "many" })), /INDEXER_BATCH_SIZE/);
    assert.throws(() => loadConfig(env({ INDEXER_INTERVAL_MS: "0" })), /INDEXER_INTERVAL_MS/);
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

describe("optional variables left blank", () => {
  test("an empty OTLP endpoint means tracing is off, not a bad URL", () => {
    // The shipped .env.example leaves the variable blank, and a container
    // that reads that file must still start.
    assert.equal(
      loadConfig(env({ OTEL_EXPORTER_OTLP_ENDPOINT: "" })).OTEL_EXPORTER_OTLP_ENDPOINT,
      undefined,
    );
    assert.equal(loadConfig(env()).OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  });

  test("a real endpoint is kept and a malformed one is rejected", () => {
    assert.equal(
      loadConfig(env({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }))
        .OTEL_EXPORTER_OTLP_ENDPOINT,
      "http://localhost:4318",
    );
    assert.throws(
      () => loadConfig(env({ OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url" })),
      /OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
  });
});

describe("the shipped .env.example", () => {
  test("is a configuration the service can start with", () => {
    // The file a new contributor copies is the one a container reads, so a
    // blank value in it must not stop the process from starting.
    const contents = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const config = loadConfig(parseEnv(contents));
    assert.equal(
      config.PLAN_REGISTRY_ID,
      "CDQ5EJTVXXX2CBMHWP3BGGUDHSK6D4I25IF5XXH3QGL2TNTBMJUOFKDB",
    );
    assert.equal(config.KEEPER_ENABLED, false);
    assert.equal(config.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  });
});

describe("Stellar identifier validation", () => {
  test("accepts a valid contract id and secret seed", () => {
    const secret = Keypair.random().secret();
    const config = loadConfig({ ...BASE, KEEPER_SECRET: secret });
    assert.equal(config.PLAN_REGISTRY_ID, VALID_CONTRACT_ID);
    assert.equal(config.KEEPER_SECRET, secret);
  });

  test("rejects a public key where a contract id is required", () => {
    const publicKey = Keypair.random().publicKey();
    assert.throws(
      () => loadConfig({ ...BASE, PLAN_REGISTRY_ID: publicKey }),
      /PLAN_REGISTRY_ID: must be a valid Stellar contract ID/,
    );
  });

  test("rejects a malformed contract id and names the variable", () => {
    assert.throws(
      () => loadConfig({ ...BASE, VAULT_ID: "C".repeat(56) }),
      /VAULT_ID: must be a valid Stellar contract ID/,
    );
  });

  test("rejects malformed keeper secrets without echoing them", () => {
    const secret = "S".repeat(56);
    assert.throws(
      () => loadConfig({ ...BASE, KEEPER_SECRET: secret }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /KEEPER_SECRET: must be a valid Stellar secret seed/);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  });

  test("rejects non-string identifiers without including their values", () => {
    assert.throws(
      () => loadConfig({ ...BASE, SUBSCRIPTION_ID: 123 as unknown as string }),
      /SUBSCRIPTION_ID: Invalid input/,
    );
  });
});

// zod 4 replaced `z.string().url()` with the top-level `z.url()` format
// validator, which validates through the WHATWG URL parser. This pins what the
// migration accepts and rejects at startup.
describe("zod 4 url validation", () => {
  test("z.url() accepts the otel endpoint and names it when rejected", () => {
    assert.equal(
      loadConfig({ ...BASE, OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }).OTEL_EXPORTER_OTLP_ENDPOINT,
      "http://localhost:4318",
    );
    assert.throws(
      () => loadConfig({ ...BASE, OTEL_EXPORTER_OTLP_ENDPOINT: "definitely not a url" }),
      /OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
  });
});
