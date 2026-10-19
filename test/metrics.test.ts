import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { nativeToScVal, type rpc } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import { metrics, MetricsRegistry } from "../src/lib/metrics.ts";
import type { Config, NetworkConfig } from "../src/config.ts";

/**
 * Prometheus metrics.
 *
 * The endpoint is opt-in, and the numbers it publishes are the ones an
 * operator alerts on: how far the indexer has got, how far behind it is, and
 * whether the keeper is settling anything.
 */

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const TOKEN = "CDQ5EJTVXXX2CBMHWP3BGGUDHSK6D4I25IF5XXH3QGL2TNTBMJUOFKDB";

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
const config = { CORS_ORIGIN: "*" } as unknown as Config;

const db = openDatabase(":memory:");

/** A plan_created event, as the RPC hands it over. */
function rawPlanEvent(ledger: number): rpc.Api.EventResponse {
  return {
    ledger,
    txHash: `tx-${ledger}`,
    topic: [
      nativeToScVal("plan_created", { type: "symbol" }),
      nativeToScVal(MERCHANT, { type: "address" }),
      nativeToScVal(1n, { type: "u64" }),
    ],
    value: nativeToScVal(
      { token: TOKEN, amount: 10n, period: 60n, name: "p1" },
      {
        type: {
          token: ["symbol", "address"],
          amount: ["symbol", "i128"],
          period: ["symbol", "u64"],
          name: ["symbol", "string"],
        },
      },
    ),
  } as unknown as rpc.Api.EventResponse;
}

/** A node with one event in it, so a pass has something to apply. */
function fakeRpc(latest: number, oldest: number, events: rpc.Api.EventResponse[]) {
  return {
    getLatestLedger: async () => ({ sequence: latest }) as never,
    getHealth: async () => ({ oldestLedger: oldest, latestLedger: latest }) as never,
    getEvents: async (req: Record<string, unknown>) => {
      const start = (req.startLedger as number | undefined) ?? 0;
      const end = (req.endLedger as number | undefined) ?? Number.MAX_SAFE_INTEGER;
      const page = events.filter((event) => event.ledger >= start && event.ledger < end);
      // No cursor: one page is the whole window.
      return { events: page } as never;
    },
  } as never;
}

describe("the metrics registry", () => {
  test("renders counters and gauges in the Prometheus text format", () => {
    const registry = new MetricsRegistry();
    registry.set("indexer_cursor", 1_000, { network: "testnet" });
    registry.increment("events_applied", 3, { network: "testnet" });

    const text = registry.render();
    assert.match(text, /^# HELP payflow_indexer_cursor /m);
    assert.match(text, /^# TYPE payflow_indexer_cursor gauge$/m);
    assert.match(text, /^payflow_indexer_cursor\{network="testnet"\} 1000$/m);
    assert.match(text, /^# TYPE payflow_events_applied_total counter$/m);
    assert.match(text, /^payflow_events_applied_total\{network="testnet"\} 3$/m);
  });

  test("a counter only goes up", () => {
    const registry = new MetricsRegistry();
    registry.increment("charges_settled");
    registry.increment("charges_settled", 2);
    registry.increment("charges_settled", -5);
    assert.equal(registry.value("charges_settled"), 3);
  });

  test("a gauge takes the value it is given", () => {
    const registry = new MetricsRegistry();
    registry.set("indexer_lag", 10);
    registry.set("indexer_lag", 4);
    assert.equal(registry.value("indexer_lag"), 4);
  });

  test("samples with different labels are counted apart", () => {
    const registry = new MetricsRegistry();
    registry.set("indexer_cursor", 1, { network: "testnet" });
    registry.set("indexer_cursor", 2, { network: "mainnet" });
    assert.equal(registry.value("indexer_cursor", { network: "testnet" }), 1);
    assert.equal(registry.value("indexer_cursor", { network: "mainnet" }), 2);
  });

  test("an unknown metric is ignored rather than throwing", () => {
    const registry = new MetricsRegistry();
    registry.increment("nope");
    registry.set("nope", 1);
    assert.equal(registry.value("nope"), undefined);
    assert.equal(registry.render().includes("nope"), false);
  });
});

describe("GET /metrics", () => {
  let server: Server;
  let base = "";

  before(async () => {
    const app = createApp(
      [
        {
          config: testnet,
          db,
          indexer: { cursor: 1_000, latest: 1_010, lastRunAt: null, lastError: null },
        },
      ],
      { ...config, METRICS_ENABLED: true } as Config,
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
  });

  test("is not served unless it is enabled", async () => {
    const app = createApp(db, config);
    const local = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const addr = local.address();
      const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      const res = await fetch(`${url}/metrics`);
      assert.equal(res.status, 404);
    } finally {
      local.close();
    }
  });

  test("serves the Prometheus text format", async () => {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    const body = await res.text();
    assert.match(body, /# HELP payflow_indexer_cursor/);
    assert.match(body, /# TYPE payflow_indexer_cursor gauge/);
  });

  test("publishes the gauges and counters the operator alerts on", async () => {
    const body = await (await fetch(`${base}/metrics`)).text();
    for (const name of [
      "payflow_indexer_cursor",
      "payflow_indexer_latest_ledger",
      "payflow_indexer_lag",
      "payflow_events_applied_total",
      "payflow_charges_settled_total",
      "payflow_charges_failed_total",
      "payflow_keeper_passes_total",
    ]) {
      assert.ok(body.includes(name), `${name} is published`);
    }
  });

  test("the gauges carry the indexer's own numbers", async () => {
    const body = await (await fetch(`${base}/metrics`)).text();
    assert.match(body, /payflow_indexer_cursor\{network="testnet"\} 1000/);
    assert.match(body, /payflow_indexer_latest_ledger\{network="testnet"\} 1010/);
    assert.match(body, /payflow_indexer_lag\{network="testnet"\} 10/);
  });
});

describe("the metrics the loops publish", () => {
  test("an indexer pass publishes the cursor, the latest ledger and the lag", async () => {
    metrics.reset();
    const indexer = new Indexer(db, fakeRpc(20_000, 1, [rawPlanEvent(10)]), testnet);
    await indexer.tick();

    assert.equal(metrics.value("indexer_cursor", { network: "testnet" }), 8_001);
    assert.equal(metrics.value("indexer_latest_ledger", { network: "testnet" }), 20_000);
    assert.equal(metrics.value("indexer_lag", { network: "testnet" }), 11_999);
    assert.equal(metrics.value("events_applied", { network: "testnet" }), 1);
    metrics.reset();
  });
});
