import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import { Indexer } from "../src/indexer.ts";
import { getMerchantSummary, getPlanById, getProtocolStats, listMandateCharges, listPlans, listMandates } from "../src/lib/queries.ts";
import { PostgresStorage } from "../src/lib/store/postgres.ts";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import type { Storage } from "../src/lib/store/types.ts";
import { WebhookDispatcher } from "../src/lib/webhooks.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import { asReader, TokenMetadataService } from "../src/lib/tokens.ts";
import { MerchantSummaryCache } from "../src/routes/index.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

type Backend = { name: string; open: () => Promise<Storage> };

const backends: Backend[] = [
  { name: "SQLite", open: async () => SqliteStorage.open(":memory:") },
];
if (DATABASE_URL) {
  backends.push({
    name: "PostgreSQL",
    open: () =>
      PostgresStorage.open(
        DATABASE_URL,
        `test_${process.pid}_${randomBytes(4).toString("hex")}`,
      ),
  });
}

function event(
  name: string,
  topics: unknown[],
  data: Record<string, unknown>,
  txHash: string,
): DecodedEvent {
  return { name, contractId: "C", ledger: 10, txHash, topics, data };
}

async function project(storage: Storage): Promise<Record<string, unknown>> {
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const indexer = new Indexer(storage, {} as never, {} as never);
    await indexer.apply(event("plan_created", [MERCHANT, 1n], {
      name: "Portable",
      token: TOKEN,
      amount: 9_007_199_254_740_993n,
      period: 2_592_000n,
    }, "tx-plan"));
    await indexer.apply(event("subscribed", [1n, SUBSCRIBER, MERCHANT], {
      plan_id: 1n,
      amount: 9_007_199_254_740_993n,
      period: 2_592_000n,
      next_charge: 1_700_000_000n,
      max_charges: 0n,
      fee_bps: 100n,
    }, "tx-subscribe"));
    const charge = event("charged", [1n, SUBSCRIBER, MERCHANT], {
      amount: 9_007_199_254_740_000n,
      fee: 900_719_925_474n,
      charges_made: 1n,
      next_charge: 1_702_592_000n,
    }, "tx-charge");
    await indexer.apply(charge);
    await indexer.apply(charge);
    await storage.run(
      `INSERT INTO cursor (id, last_ledger) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger`,
      [10],
    );
    return JSON.parse(JSON.stringify({
      plan: await getPlanById(storage, 1),
      merchant: await getMerchantSummary(storage, MERCHANT),
      charges: await listMandateCharges(storage, 1, 10),
      stats: await getProtocolStats(storage, 0),
    })) as Record<string, unknown>;
  } finally {
    Date.now = originalNow;
  }
}

async function apiResponses(storage: Storage): Promise<unknown[]> {
  const network: NetworkConfig = {
    name: "testnet",
    rpcUrl: "https://rpc.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    planRegistryId: "C".repeat(56),
    vaultId: "C".repeat(56),
    subscriptionId: "C".repeat(56),
    startLedger: 0,
    databasePath: ":memory:",
  };
  const tokens = new TokenMetadataService(asReader(undefined), {
    networkPassphrase: network.networkPassphrase,
  });
  const app = createApp(
    [{ config: network, db: storage, tokens, summaryCache: new MerchantSummaryCache() }],
    { CORS_ORIGIN: "*" } as Config,
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const paths = [
      "/api/plans",
      "/api/plans/1",
      "/api/mandates",
      "/api/mandates/1/charges",
      "/api/due",
      `/api/merchants/${MERCHANT}/summary`,
      `/api/subscribers/${SUBSCRIBER}/summary`,
      "/api/stats",
    ];
    const responses = await Promise.all(paths.map(async (path) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200, `${path} status`);
      return response.json();
    }));
    return responses;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

for (const backend of backends) {
  test(`${backend.name} preserves projection, query, and replay behavior`, async () => {
    const storage = await backend.open();
    try {
      const response = await project(storage);
      const plan = response.plan as { amount: string };
      const merchant = response.merchant as { totalCollected: string; chargeCount: number };
      const charges = response.charges as unknown[];
      const stats = response.stats as { volumeAllTime: string; lastIndexedLedger: number };
      assert.equal(plan.amount, "9007199254740993");
      assert.equal(merchant.totalCollected, "9007199254740000");
      assert.equal(merchant.chargeCount, 1);
      assert.equal(charges.length, 1);
      assert.equal(stats.volumeAllTime, "9008099974665474");
      assert.equal(stats.lastIndexedLedger, 10);

      await assert.rejects(
        storage.transaction(async (transaction) => {
          await transaction.run(
            `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [2, MERCHANT, "rollback", TOKEN, "1", 60, 1, 11],
          );
          await transaction.run(
            `INSERT INTO cursor (id, last_ledger) VALUES (1, ?)
             ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger`,
            [11],
          );
          throw new Error("rollback check");
        }),
        /rollback check/,
      );
      assert.equal(await storage.get("SELECT id FROM plans WHERE id = ?", [2]), undefined);
      const cursor = await storage.get<{ last_ledger: number }>(
        "SELECT last_ledger FROM cursor WHERE id = 1",
      );
      assert.equal(cursor?.last_ledger, 10);
    } finally {
      await storage.close();
    }
  });
}

test("SQLite and PostgreSQL return identical projection responses", { skip: !DATABASE_URL }, async () => {
  const sqlite = await SqliteStorage.open(":memory:");
  const postgres = await PostgresStorage.open(
    DATABASE_URL!,
    `parity_${process.pid}_${randomBytes(4).toString("hex")}`,
  );
  try {
    assert.deepEqual(await project(postgres), await project(sqlite));
    assert.deepEqual(await apiResponses(postgres), await apiResponses(sqlite));
  } finally {
    await Promise.all([sqlite.close(), postgres.close()]);
  }
});

/**
 * Issue #362: SQLite and PostgreSQL must return lists in the same deterministic
 * order so clients see stable results regardless of which backend is active.
 *
 * The tests below run on SQLite (always available) and optionally on PostgreSQL
 * when DATABASE_URL is set, then assert both return identical ordering.
 */

async function seedOrderingFixture(storage: Storage): Promise<void> {
  // Insert plans in a non-sequential order to verify the query re-orders them.
  for (const id of [3, 1, 4, 2]) {
    await storage.run(
      `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, MERCHANT, `Plan ${id}`, TOKEN, "100", 2592000, 1, id],
    );
  }
  for (const id of [5, 2, 8, 1]) {
    await storage.run(
      `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
       VALUES (?, ?, ?, 1, ?, 60, ?, 'Active', 1)`,
      [id, SUBSCRIBER, MERCHANT, "10", id * 1000],
    );
  }
}

for (const backend of backends) {
  test(`${backend.name}: listPlans returns newest-first order (id DESC)`, async () => {
    const storage = await backend.open();
    try {
      await seedOrderingFixture(storage);
      const { rows } = await listPlans(storage, { limit: 10 });
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "plans are ordered by id DESC");
    } finally {
      await storage.close();
    }
  });

  test(`${backend.name}: listMandates returns newest-first order (id DESC)`, async () => {
    const storage = await backend.open();
    try {
      await seedOrderingFixture(storage);
      const { rows } = await listMandates(storage, { limit: 10 });
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "mandates are ordered by id DESC");
    } finally {
      await storage.close();
    }
  });

  test(`${backend.name}: cursor pagination returns consistent pages`, async () => {
    const storage = await backend.open();
    try {
      await seedOrderingFixture(storage);
      // Fetch page 1 (newest 2).
      const page1 = await listPlans(storage, { limit: 2 });
      assert.equal(page1.rows.length, 2);
      assert.ok(page1.nextCursorId !== null, "there should be a next page");
      // Fetch page 2 using the cursor from page 1.
      const page2 = await listPlans(storage, { limit: 2, cursor: page1.nextCursorId! });
      // All ids from page 2 must be less than the minimum id on page 1.
      const minPage1 = Math.min(...page1.rows.map((r) => r.id));
      assert.ok(
        page2.rows.every((r) => r.id < minPage1),
        "cursor page must not repeat or skip rows",
      );
      // Pages must not share any ids.
      const page1Ids = new Set(page1.rows.map((r) => r.id));
      const overlap = page2.rows.filter((r) => page1Ids.has(r.id));
      assert.equal(overlap.length, 0, "pages must not overlap");
    } finally {
      await storage.close();
    }
  });
}

test("SQLite and PostgreSQL return identical list ordering", { skip: !DATABASE_URL }, async () => {
  const sqlite = await SqliteStorage.open(":memory:");
  const postgres = await PostgresStorage.open(
    DATABASE_URL!,
    `ordering_${process.pid}_${randomBytes(4).toString("hex")}`,
  );
  try {
    await seedOrderingFixture(sqlite);
    await seedOrderingFixture(postgres);
    const [sqlitePlans, postgresPlanss] = await Promise.all([
      listPlans(sqlite, { limit: 10 }),
      listPlans(postgres, { limit: 10 }),
    ]);
    assert.deepEqual(
      sqlitePlans.rows.map((r) => r.id),
      postgresPlanss.rows.map((r) => r.id),
      "SQLite and PostgreSQL return plans in the same order",
    );
    const [sqliteMandates, postgresMandates] = await Promise.all([
      listMandates(sqlite, { limit: 10 }),
      listMandates(postgres, { limit: 10 }),
    ]);
    assert.deepEqual(
      sqliteMandates.rows.map((r) => r.id),
      postgresMandates.rows.map((r) => r.id),
      "SQLite and PostgreSQL return mandates in the same order",
    );
  } finally {
    await Promise.all([sqlite.close(), postgres.close()]);
  }
});

test("PostgreSQL stores and delivers webhook events", { skip: !DATABASE_URL }, async () => {
  const storage = await PostgresStorage.open(
    DATABASE_URL!,
    `webhook_${process.pid}_${randomBytes(4).toString("hex")}`,
  );
  try {
    const dispatcher = new WebhookDispatcher({
      db: storage,
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    const registration = await dispatcher.register(MERCHANT, "https://payflow.example/hook", "secret");
    assert.ok(registration.id > 0);

    await dispatcher.onApplied(event("charged", [1n, SUBSCRIBER, MERCHANT], {
      amount: 100n,
      fee: 1n,
      charges_made: 1n,
      next_charge: 11n,
    }, "tx-webhook"));

    assert.equal(await dispatcher.pendingCount(registration.id), 0);
    const deliveries = await dispatcher.deliveries(registration.id);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "delivered");
  } finally {
    await storage.close();
  }
});
