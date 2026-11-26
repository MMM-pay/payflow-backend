import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativeToScVal, rpc } from "@stellar/stellar-sdk";
import type { Server } from "node:http";
import type { Config, NetworkConfig } from "../src/config.ts";
import { createApp } from "../src/app.ts";
import { Indexer, type IndexerRpc } from "../src/indexer.ts";
import { openDatabase } from "../src/lib/db.ts";
import { reindex } from "../src/lib/reindex.ts";
import { MerchantSummaryCache } from "../src/routes/merchants.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const ADMIN_TOKEN = "reindex-integration-admin-token";

function recordedEvents(): rpc.Api.EventResponse[] {
  return [
    {
      ledger: 101,
      ledgerClosedAt: "2025-01-01T00:00:00Z",
      id: "event-plan-1",
      txHash: "tx-plan-1",
      contractId: CONTRACT,
      topic: [
        nativeToScVal("plan_created", { type: "symbol" }),
        nativeToScVal(MERCHANT, { type: "address" }),
        nativeToScVal(1n, { type: "u64" }),
      ],
      value: nativeToScVal(
        { token: CONTRACT, amount: 12_000_000n, period: 2_592_000n, name: "Growth" },
        { type: {
          token: ["symbol", "address"],
          amount: ["symbol", "i128"],
          period: ["symbol", "u64"],
          name: ["symbol", "string"],
        } },
      ),
    },
    {
      ledger: 102,
      ledgerClosedAt: "2025-01-01T00:00:05Z",
      id: "event-sub-1",
      txHash: "tx-sub-1",
      contractId: CONTRACT,
      topic: [
        nativeToScVal("subscribed", { type: "symbol" }),
        nativeToScVal(1n, { type: "u64" }),
        nativeToScVal(SUBSCRIBER, { type: "address" }),
        nativeToScVal(MERCHANT, { type: "address" }),
      ],
      value: nativeToScVal(
        { plan_id: 1n, amount: 12_000_000n, period: 2_592_000n, next_charge: 1_800_000_000n },
        { type: {
          plan_id: ["symbol", "u64"],
          amount: ["symbol", "i128"],
          period: ["symbol", "u64"],
          next_charge: ["symbol", "timepoint"],
        } },
      ),
    },
    {
      ledger: 103,
      ledgerClosedAt: "2025-01-01T00:00:10Z",
      id: "event-charge-1",
      txHash: "tx-charge-1",
      contractId: CONTRACT,
      topic: [
        nativeToScVal("charged", { type: "symbol" }),
        nativeToScVal(1n, { type: "u64" }),
        nativeToScVal(SUBSCRIBER, { type: "address" }),
        nativeToScVal(MERCHANT, { type: "address" }),
      ],
      value: nativeToScVal(
        { amount: 11_880_000n, fee: 120_000n, charges_made: 1, next_charge: 1_802_592_000n },
        { type: {
          amount: ["symbol", "i128"],
          fee: ["symbol", "i128"],
          charges_made: ["symbol", "u32"],
          next_charge: ["symbol", "timepoint"],
        } },
      ),
    },
  ] as unknown as rpc.Api.EventResponse[];
}

function fakeRpc(events: rpc.Api.EventResponse[], latest: number): IndexerRpc {
  return {
    getLatestLedger: async () => ({ sequence: latest }) as never,
    getHealth: async () => ({ oldestLedger: 1, latestLedger: latest }) as never,
    getEvents: async (request: Record<string, unknown>) => {
      const start = (request.startLedger as number | undefined) ?? 0;
      const end = (request.endLedger as number | undefined) ?? Infinity;
      const page = request.cursor === undefined
        ? events.filter((event) => event.ledger >= start && event.ledger < end)
        : [];
      return { events: page, cursor: "end", latestLedger: latest } as never;
    },
  } as unknown as IndexerRpc;
}

async function serve(db: ReturnType<typeof openDatabase>, config: Config, reindexHook?: () => Promise<unknown>) {
  const app = createApp(
    db,
    config,
    undefined,
    new MerchantSummaryCache(),
    undefined,
    reindexHook ? { reindex: reindexHook } : undefined,
  );
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    base,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

async function apiSnapshot(base: string): Promise<Array<{ path: string; status: number; body: unknown }>> {
  const paths = [
    `/api/plans?merchant=${MERCHANT}`,
    "/api/plans/1",
    "/api/plans/1/stats",
    `/api/mandates?merchant=${MERCHANT}`,
    "/api/mandates/1",
    "/api/mandates/1/charges",
    "/api/mandates/1/timeline",
    `/api/merchants/${MERCHANT}/summary`,
    `/api/merchants/${MERCHANT}/revenue?bucket=day&from=1735689600&to=1735776000`,
    `/api/subscribers/${SUBSCRIBER}/summary`,
    "/api/stats",
    "/api/plans/not-a-number",
    "/api/plans/999999",
    "/api/mandates/999999",
  ];
  const snapshot = [];
  for (const path of paths) {
    const response = await fetch(base + path);
    snapshot.push({
      path,
      status: response.status,
      body: withoutRequestIds(await response.json() as unknown),
    });
  }
  return snapshot;
}

function withoutRequestIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRequestIds);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "requestId")
        .map(([key, entry]) => [key, withoutRequestIds(entry)]),
    );
  }
  return value;
}

test("projection rebuild rolls back a mid-replay failure, resumes after repair, and survives a full reindex", async () => {
  const directory = mkdtempSync(join(tmpdir(), "payflow-api-reindex-"));
  const databasePath = join(directory, "payflow.db");
  const network: NetworkConfig = {
    name: "testnet",
    rpcUrl: "https://rpc.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    planRegistryId: CONTRACT,
    vaultId: CONTRACT,
    subscriptionId: CONTRACT,
    startLedger: 100,
    databasePath,
  };
  const config = {
    STELLAR_NETWORK: network.name,
    PLAN_REGISTRY_ID: CONTRACT,
    VAULT_ID: CONTRACT,
    SUBSCRIPTION_ID: CONTRACT,
    CORS_ORIGIN: "*",
    ADMIN_TOKEN,
  } as unknown as Config;
  const rpc = fakeRpc(recordedEvents(), 104);
  let db: ReturnType<typeof openDatabase> | undefined;
  let app: Awaited<ReturnType<typeof serve>> | undefined;

  try {
    const initial = await reindex(network, rpc, new Date("2026-01-01T00:00:00Z"));
    assert.equal(initial.backup, null);
    assert.equal(initial.events, 3);

    db = openDatabase(databasePath);
    const indexer = new Indexer(db, rpc, network);
    await indexer.ready;
    let rebuildCalls = 0;
    app = await serve(db, config, async () => {
      rebuildCalls += 1;
      return indexer.rebuildProjections();
    });
    const before = await apiSnapshot(app.base);

    const missingAuth = await fetch(`${app.base}/admin/reindex`, { method: "POST" });
    assert.equal(missingAuth.status, 401);
    const wrongAuth = await fetch(`${app.base}/admin/reindex`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(wrongAuth.status, 401);
    assert.equal(rebuildCalls, 0, "unauthorized requests do not start a rebuild");

    db.prepare(`INSERT INTO events
      (event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time)
      VALUES ('corrupt-event', ?, 104, 'tx-corrupt', '', '["not-xdr"]', 'not-xdr', NULL)`)
      .run(CONTRACT);
    const failedRebuild = await fetch(`${app.base}/admin/reindex`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(failedRebuild.status, 500);
    assert.equal(((await failedRebuild.json()) as { error: { code: string } }).error.code, "reindex_failed");
    assert.deepEqual(await apiSnapshot(app.base), before, "a failed rebuild rolls back the live projection");
    assert.equal(rebuildCalls, 1);

    db.prepare("DELETE FROM events WHERE event_id = 'corrupt-event'").run();
    const rebuilt = await fetch(`${app.base}/admin/reindex`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(rebuilt.status, 200);
    assert.equal(((await rebuilt.json()) as { result: number }).result, 3);
    assert.deepEqual(await apiSnapshot(app.base), before, "API data is unchanged after replaying retained events");
    assert.equal(rebuildCalls, 2);

    await app.close();
    app = undefined;
    db.close();
    db = undefined;

    const fresh = await reindex(network, rpc, new Date("2026-01-02T00:00:00Z"));
    assert.equal(fresh.events, 3);
    assert.ok(fresh.backup, "the prior database is retained as a backup");

    db = openDatabase(databasePath);
    app = await serve(db, config);
    assert.deepEqual(await apiSnapshot(app.base), before, "API data is unchanged after a full reindex from the start ledger");
  } finally {
    await app?.close();
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
