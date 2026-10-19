import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo, Server } from "node:http";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import { Indexer } from "../src/indexer.ts";
import { getMerchantSummary, getPlanById, getProtocolStats, listMandateCharges } from "../src/lib/queries.ts";
import { PostgresStorage } from "../src/lib/store/postgres.ts";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import type { Storage } from "../src/lib/store/types.ts";
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
