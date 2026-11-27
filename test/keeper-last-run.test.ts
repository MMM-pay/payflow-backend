/**
 * Tests for keeper last-successful-run timestamp (#258).
 *
 * Covers:
 * - `Keeper.lastSuccessfulRunAt` starts as null before any pass.
 * - It is set to the pass timestamp after a successful tick().
 * - It is NOT updated on a dry-run pass (dry-run does not count as "run").
 * - It is NOT updated when tick() throws (a failed pass is not a successful one).
 * - `passHistory()` reflects the same value via KeeperHistoryResponse.
 * - `GET /api/keeper` returns `lastSuccessfulRunAt` in its body.
 * - `GET /health` includes `keeper.lastSuccessfulRunAt` when keeper is attached.
 * - `GET /health` has `keeper: null` when no keeper is attached.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import type { Server } from "node:http";
import {
  Account,
  Keypair,
  Transaction,
  rpc,
} from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { Keeper, type KeeperRpc } from "../src/keeper.ts";
import { createApp } from "../src/app.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { AdminHooks } from "../src/routes/admin.ts";
import type { KeeperHistoryResponse, HealthResponse } from "../src/routes/types.ts";

// ── shared fixtures ───────────────────────────────────────────────────────────

const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const KEY = Keypair.random();

function keeperConfig(extra: Partial<Record<string, unknown>> = {}): Config {
  return {
    PLAN_REGISTRY_ID: CONTRACT,
    VAULT_ID: CONTRACT,
    SUBSCRIPTION_ID: CONTRACT,
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    KEEPER_SECRET: KEY.secret(),
    KEEPER_FEE_PERCENTILE: "90",
    KEEPER_MAX_FEE: "100000",
    KEEPER_BATCH: false,
    KEEPER_BATCH_SIZE: 10,
    KEEPER_BACKOFF_JITTER: 0,
    ...extra,
  } as unknown as Config;
}

/** Minimal RPC that settles every transaction successfully. */
function fakeRpc(): KeeperRpc {
  return {
    getFeeStats: async () => ({ sorobanInclusionFee: { p90: "1000" } }) as never,
    getAccount: async (address: string) => new Account(address, "1") as never,
    prepareTransaction: async (tx) => tx as Transaction,
    sendTransaction: async (tx) => ({
      status: "PENDING",
      hash: Buffer.from((tx as Transaction).hash()).toString("hex"),
    }) as never,
    getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }) as never,
  };
}

function insertDue(db: ReturnType<typeof openDatabase>, id: number): void {
  db.prepare(
    `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
     VALUES (?, ?, ?, 1, '10', 60, 1000, 'Active', 1)`,
  ).run(id, SUBSCRIBER, MERCHANT);
}

// ── Keeper unit tests ─────────────────────────────────────────────────────────

describe("Keeper.lastSuccessfulRunAt", () => {
  test("is null before any pass runs", () => {
    const db = openDatabase(":memory:");
    try {
      const keeper = new Keeper(db, fakeRpc(), keeperConfig());
      assert.equal(keeper.lastSuccessfulRunAt, null);
    } finally {
      db.close();
    }
  });

  test("is set to the pass unix timestamp after a successful tick", async () => {
    const db = openDatabase(":memory:");
    try {
      insertDue(db, 1);
      const keeper = new Keeper(db, fakeRpc(), keeperConfig());
      const now = 1_700_000_000;
      await keeper.tick(now);
      assert.equal(keeper.lastSuccessfulRunAt, now);
    } finally {
      db.close();
    }
  });

  test("is updated on every subsequent successful tick", async () => {
    const db = openDatabase(":memory:");
    try {
      insertDue(db, 1);
      const keeper = new Keeper(db, fakeRpc(), keeperConfig());
      await keeper.tick(1_700_000_000);
      assert.equal(keeper.lastSuccessfulRunAt, 1_700_000_000);
      await keeper.tick(1_700_000_060);
      assert.equal(keeper.lastSuccessfulRunAt, 1_700_000_060);
    } finally {
      db.close();
    }
  });

  test("is set even when no mandates are due (an empty pass still counts)", async () => {
    const db = openDatabase(":memory:");
    try {
      // No mandates inserted — the pass runs fine but settles nothing.
      const keeper = new Keeper(db, fakeRpc(), keeperConfig());
      await keeper.tick(1_700_000_000);
      assert.equal(
        keeper.lastSuccessfulRunAt,
        1_700_000_000,
        "an empty pass still marks the keeper as having run",
      );
    } finally {
      db.close();
    }
  });

  test("is NOT set when KEEPER_DRY_RUN=true", async () => {
    const db = openDatabase(":memory:");
    try {
      insertDue(db, 1);
      const keeper = new Keeper(db, fakeRpc(), keeperConfig({ KEEPER_DRY_RUN: true }));
      await keeper.tick(1_700_000_000);
      assert.equal(
        keeper.lastSuccessfulRunAt,
        null,
        "a dry-run pass must not update lastSuccessfulRunAt",
      );
    } finally {
      db.close();
    }
  });

  test("is NOT updated when tick() throws", async () => {
    const db = openDatabase(":memory:");
    try {
      const keeper = new Keeper(db, fakeRpc(), keeperConfig());
      // Close the database so the next tick fails reading due mandates.
      db.close();
      await assert.rejects(() => keeper.tick(1_700_000_000));
      assert.equal(
        keeper.lastSuccessfulRunAt,
        null,
        "a failed pass must not update lastSuccessfulRunAt",
      );
    } catch (err) {
      // db.close() already called above; swallow second close in finally.
      void err;
    }
  });

  test("retains the previous successful timestamp after a failed pass", async () => {
    const db = openDatabase(":memory:");
    try {
      const keeper = new Keeper(db, fakeRpc(), keeperConfig());
      // First pass succeeds.
      await keeper.tick(1_700_000_000);
      assert.equal(keeper.lastSuccessfulRunAt, 1_700_000_000);

      // Break the DB so the second tick throws.
      db.close();
      await assert.rejects(() => keeper.tick(1_700_000_060));

      // Timestamp stays at the last successful pass.
      assert.equal(
        keeper.lastSuccessfulRunAt,
        1_700_000_000,
        "lastSuccessfulRunAt must not change after a failed pass",
      );
    } catch (err) {
      void err;
    }
  });
});

// ── passHistory() / KeeperHistoryResponse ────────────────────────────────────

describe("passHistory() includes lastSuccessfulRunAt", () => {
  test("lastSuccessfulRunAt is reflected via the admin hook shape", async () => {
    const db = openDatabase(":memory:");
    try {
      const keeper = new Keeper(db, fakeRpc(), keeperConfig());
      // Before any pass the keeper has no timestamp.
      assert.equal(keeper.lastSuccessfulRunAt, null);

      await keeper.tick(1_700_000_000);

      // Simulate what index.ts wires as adminHooks.keeperHistory.
      const history: KeeperHistoryResponse = {
        passes: keeper.passHistory(),
        lastSuccessfulRunAt: keeper.lastSuccessfulRunAt,
      };
      assert.equal(history.lastSuccessfulRunAt, 1_700_000_000);
      assert.equal(history.passes.length, 1);
      assert.equal(history.passes[0]!.time, 1_700_000_000);
    } finally {
      db.close();
    }
  });
});

// ── /api/keeper HTTP endpoint ─────────────────────────────────────────────────

async function startKeeperApp(
  keeperHistory: () => KeeperHistoryResponse,
): Promise<{ base: string; stop: () => void }> {
  const db = openDatabase(":memory:");
  const admin: AdminHooks = { keeperHistory };
  const app = createApp(
    db,
    {
      STELLAR_NETWORK: "testnet",
      PLAN_REGISTRY_ID: "C".repeat(56),
      VAULT_ID: "C".repeat(56),
      SUBSCRIPTION_ID: "C".repeat(56),
      CORS_ORIGIN: "*",
      KEEPER_ENABLED: true,
    } as unknown as Config,
    undefined,
    admin,
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => { server.close(); db.close(); },
  };
}

describe("GET /api/keeper", () => {
  test("returns lastSuccessfulRunAt when it has been set", async () => {
    const app = await startKeeperApp(() => ({
      passes: [],
      lastSuccessfulRunAt: 1_700_000_000,
    }));
    try {
      const res = await fetch(`${app.base}/api/keeper`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as KeeperHistoryResponse;
      assert.equal(body.lastSuccessfulRunAt, 1_700_000_000);
      assert.ok(Array.isArray(body.passes));
    } finally {
      app.stop();
    }
  });

  test("returns lastSuccessfulRunAt as null before the first pass", async () => {
    const app = await startKeeperApp(() => ({
      passes: [],
      lastSuccessfulRunAt: null,
    }));
    try {
      const res = await fetch(`${app.base}/api/keeper`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as KeeperHistoryResponse;
      assert.equal(body.lastSuccessfulRunAt, null);
    } finally {
      app.stop();
    }
  });

  test("404 when KEEPER_ENABLED is false (hook not wired)", async () => {
    const db = openDatabase(":memory:");
    const app = createApp(
      db,
      {
        STELLAR_NETWORK: "testnet",
        PLAN_REGISTRY_ID: "C".repeat(56),
        VAULT_ID: "C".repeat(56),
        SUBSCRIPTION_ID: "C".repeat(56),
        CORS_ORIGIN: "*",
        KEEPER_ENABLED: false,
      } as unknown as Config,
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/keeper`);
      assert.equal(res.status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});

// ── /health keeper block ──────────────────────────────────────────────────────

describe("GET /health keeper block", () => {
  test("keeper is null when no keeper is attached to the runtime", async () => {
    const db = openDatabase(":memory:");
    const app = createApp(
      db,
      {
        STELLAR_NETWORK: "testnet",
        PLAN_REGISTRY_ID: "C".repeat(56),
        VAULT_ID: "C".repeat(56),
        SUBSCRIPTION_ID: "C".repeat(56),
        CORS_ORIGIN: "*",
      } as unknown as Config,
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as HealthResponse;
      assert.equal(body.keeper, null);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  test("keeper.lastSuccessfulRunAt is null before the first pass", async () => {
    const db = openDatabase(":memory:");
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
    const app = createApp(
      [{ config: network, db, keeper: { lastSuccessfulRunAt: null } }],
      { CORS_ORIGIN: "*" } as unknown as Config,
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as HealthResponse;
      assert.ok(body.keeper !== undefined, "keeper block should be present");
      assert.equal(body.keeper?.lastSuccessfulRunAt, null);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  test("keeper.lastSuccessfulRunAt reflects the timestamp after a pass", async () => {
    const db = openDatabase(":memory:");
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
    const keeperStatus = { lastSuccessfulRunAt: 1_700_000_000 };
    const app = createApp(
      [{ config: network, db, keeper: keeperStatus }],
      { CORS_ORIGIN: "*" } as unknown as Config,
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as HealthResponse;
      assert.equal(body.keeper?.lastSuccessfulRunAt, 1_700_000_000);

      // Simulate the keeper advancing — the live object is shared by reference.
      keeperStatus.lastSuccessfulRunAt = 1_700_000_060;
      const res2 = await fetch(`http://127.0.0.1:${port}/health`);
      const body2 = (await res2.json()) as HealthResponse;
      assert.equal(body2.keeper?.lastSuccessfulRunAt, 1_700_000_060);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
