import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { nativeToScVal, type rpc } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { asStorage } from "../src/lib/store/index.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import { metrics, MetricsRegistry, publishBusinessMetrics } from "../src/lib/metrics.ts";
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
/** A second merchant. Addresses are stored as text and never validated here. */
const SECOND_MERCHANT = "G" + "2".repeat(55);
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
      "payflow_active_mandates",
      "payflow_active_merchants",
      "payflow_mrr",
      "payflow_events_applied_total",
      "payflow_charges_settled_total",
      "payflow_charges_failed_total",
      "payflow_keeper_passes_total",
    ]) {
      assert.ok(body.includes(name), `${name} is published`);
    }
  });

  test("the business gauges are refreshed from the projection before the render", async () => {
    const body = await (await fetch(`${base}/metrics`)).text();
    // This network's database holds no mandates, and the scrape still
    // carries a sample per gauge — not just the family's HELP line.
    assert.match(body, /payflow_active_mandates\{network="testnet"\} 0/);
    assert.match(body, /payflow_active_merchants\{network="testnet"\} 0/);
    assert.match(body, /payflow_mrr\{network="testnet"\} 0/);
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

/**
 * A projection with two merchants' mandates, written directly: these gauges
 * only read the `mandates` table, so the indexer's event writer is not in
 * the way of an exact expected value.
 *
 * Mandate 3's figure is deliberate: its MRR is 2^53 + 1, which a JavaScript
 * number cannot hold — a gauge that stored it as a number would publish a
 * rounded digit string.
 */
function seededBusinessDb(): DatabaseSync {
  const db = openDatabase(":memory:");
  insertMandate(db, 1, MERCHANT, "1000", 2_592_000, "Active"); // mrr 1000
  insertMandate(db, 2, MERCHANT, "2000", 1_296_000, "Active"); // mrr 4000
  insertMandate(db, 3, SECOND_MERCHANT, "9007199254740993", 2_592_000, "Active"); // mrr 2^53 + 1
  insertMandate(db, 4, SECOND_MERCHANT, "7777", 2_592_000, "Cancelled"); // neither active nor recurring
  insertMandate(db, 5, SECOND_MERCHANT, "500", 0, "Active"); // active, but billed with no period
  return db;
}

/** One mandate row: the gauges' only input. */
function insertMandate(
  db: DatabaseSync,
  id: number,
  merchant: string,
  amount: string,
  period: number,
  status: string,
): void {
  db.prepare(
    `INSERT INTO mandates
       (id, subscriber, merchant, plan_id, amount, period, next_charge,
        last_charge, charges_made, max_charges, fee_bps, status, ledger)
     VALUES (?, ?, ?, 1, ?, ?, 0, 0, 0, 0, 0, ?, 10)`,
  ).run(id, SUBSCRIBER, merchant, amount, period, status);
}

/** The seeded projection's MRR: 1000 + 4000 + (2^53 + 1). */
const SEEDED_MRR = "9007199254745993";

describe("the business gauges", () => {
  test("active mandates, active merchants and MRR are read from the projection", async () => {
    metrics.reset();
    await publishBusinessMetrics(asStorage(seededBusinessDb()), "testnet");
    assert.equal(metrics.value("active_mandates", { network: "testnet" }), 4);
    assert.equal(metrics.value("active_merchants", { network: "testnet" }), 2);
    assert.equal(metrics.value("mrr", { network: "testnet" }), SEEDED_MRR);
    metrics.reset();
  });

  test("MRR is an amount: the exact decimal string, never a JavaScript number", async () => {
    metrics.reset();
    await publishBusinessMetrics(asStorage(seededBusinessDb()), "testnet");
    const mrr = metrics.value("mrr", { network: "testnet" });
    assert.equal(typeof mrr, "string");
    assert.equal(mrr, SEEDED_MRR);
    // A number would round this figure: 2^53 + 1 is odd, so its nearest
    // double is 2 digits away and the published digits would be wrong.
    assert.notEqual(String(Number(mrr)), mrr);
    assert.match(
      metrics.render(),
      /^payflow_mrr\{network="testnet"\} 9007199254745993$/m,
    );
    metrics.reset();
  });

  test("cardinality stays bounded: no per-merchant labels, one sample per network", async () => {
    metrics.reset();
    const db = seededBusinessDb();
    await publishBusinessMetrics(asStorage(db), "testnet");
    // The business grows: ten more merchants, each with an active mandate.
    for (let i = 0; i < 10; i += 1) {
      insertMandate(db, 100 + i, `GM${i}`, "1000", 2_592_000, "Active");
    }
    await publishBusinessMetrics(asStorage(db), "testnet");
    await publishBusinessMetrics(asStorage(db), "mainnet");

    const rendered = metrics.render();
    const businessLines = rendered
      .split("\n")
      .filter((line) => /^payflow_(active_mandates|active_merchants|mrr)/.test(line));
    // Three metrics × two networks: growth adds no series, and a merchant's
    // address is never a label — it would multiply cardinality by merchants.
    assert.equal(businessLines.length, 6);
    for (const line of businessLines) {
      assert.match(line, /^\S+\{network="(testnet|mainnet)"\} \S+$/);
    }
    assert.ok(!rendered.includes(SECOND_MERCHANT));
    assert.equal(metrics.value("active_merchants", { network: "testnet" }), 12);
    metrics.reset();
  });

  test("a projection that cannot be read keeps the last gauges instead of throwing", async () => {
    metrics.reset();
    await publishBusinessMetrics(asStorage(seededBusinessDb()), "testnet");
    const closed = openDatabase(":memory:");
    closed.close();
    // The read fails (a closed, locked or corrupt database): the failure is
    // logged, the previously published values survive, and the next pass
    // retries — a business-metrics failure never takes the loop down.
    await publishBusinessMetrics(asStorage(closed), "testnet");
    assert.equal(metrics.value("active_mandates", { network: "testnet" }), 4);
    assert.equal(metrics.value("active_merchants", { network: "testnet" }), 2);
    assert.equal(metrics.value("mrr", { network: "testnet" }), SEEDED_MRR);
    metrics.reset();
  });

  test("an indexer pass refreshes the business gauges", async () => {
    metrics.reset();
    const db = openDatabase(":memory:");
    const indexer = new Indexer(db, fakeRpc(20_000, 1, [rawPlanEvent(10)]), testnet);
    // The constructor publishes the starting state: an empty projection.
    await indexer.ready;
    assert.equal(metrics.value("active_mandates", { network: "testnet" }), 0);
    assert.equal(metrics.value("active_merchants", { network: "testnet" }), 0);
    assert.equal(metrics.value("mrr", { network: "testnet" }), "0");

    insertMandate(db, 7, MERCHANT, "1000", 2_592_000, "Active");
    await indexer.tick();
    assert.equal(metrics.value("active_mandates", { network: "testnet" }), 1);
    assert.equal(metrics.value("active_merchants", { network: "testnet" }), 1);
    assert.equal(metrics.value("mrr", { network: "testnet" }), "1000");

    // A second pass replays nothing and accumulates nothing: the gauges are
    // re-read from the projection, so an idempotent pass leaves them as they
    // stand.
    await indexer.tick();
    assert.equal(metrics.value("active_mandates", { network: "testnet" }), 1);
    assert.equal(metrics.value("mrr", { network: "testnet" }), "1000");
    metrics.reset();
  });
});
