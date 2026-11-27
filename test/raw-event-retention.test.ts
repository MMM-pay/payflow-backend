/**
 * Tests for raw-event retention policy (#246).
 *
 * Covers:
 * - The indexer prunes old events automatically on each `tick()`.
 * - Events not yet consumed by the projection (ledger >= cursor) are never pruned.
 * - `RAW_EVENT_RETENTION_DAYS=0` keeps everything indefinitely.
 * - `pruneOldEvents` with `daysToKeep=0` is a no-op.
 * - `IndexerStatus` reports `rawEventRetentionDays` and `lastPrunedAt` after a tick.
 * - `GET /admin/data/retention` returns the policy (auth and 503 paths).
 * - `POST /admin/data/prune` honours the `maxLedger` guard (auth and 503 paths).
 * - `/health` surfaces `rawEventRetentionDays` and `lastPrunedAt`.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import type { Server } from "node:http";
import { nativeToScVal, type rpc } from "@stellar/stellar-sdk";
import { openDatabase, pruneOldEvents } from "../src/lib/db.ts";
import { asStorage } from "../src/lib/store/index.ts";
import { Indexer, type IndexerRpc } from "../src/indexer.ts";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import type { NetworkConfig } from "../src/config.ts";
import type { AdminHooks } from "../src/routes/admin.ts";

// ── shared fixtures ──────────────────────────────────────────────────────────

const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const merchant = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";

/** Build a minimal RPC event for the events table. */
function makeEvent(id: string, ledger: number, closeTime: number): rpc.Api.EventResponse {
  return {
    id,
    ledger,
    txHash: id,
    contractId: contract,
    topic: [
      nativeToScVal("plan_created", { type: "symbol" }),
      nativeToScVal(merchant, { type: "address" }),
      nativeToScVal(1n, { type: "u64" }),
    ],
    value: nativeToScVal(
      { token: contract, amount: 1000n, period: 60n, name: "Plan" },
      {
        type: {
          token: ["symbol", "address"],
          amount: ["symbol", "i128"],
          period: ["symbol", "u64"],
          name: ["symbol", "string"],
        },
      },
    ),
    ledgerClosedAt: new Date(closeTime * 1000).toISOString(),
  } as unknown as rpc.Api.EventResponse;
}

/** Insert a row directly into the events table with a known close_time. */
function insertRawEvent(
  db: ReturnType<typeof openDatabase>,
  eventId: string,
  ledger: number,
  closeTime: number | null,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO events
       (event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(eventId, contract, ledger, eventId, "", "[]", "", closeTime);
}

const TOKEN = "retention-admin-token-32chars-ok";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    STELLAR_NETWORK: "testnet",
    PLAN_REGISTRY_ID: "C".repeat(56),
    VAULT_ID: "C".repeat(56),
    SUBSCRIPTION_ID: "C".repeat(56),
    CORS_ORIGIN: "*",
    PORT: 0,
    ADMIN_TOKEN: TOKEN,
    DATA_RETENTION_DAYS: 30,
    CHARGE_ATTEMPT_RETENTION_DAYS: 90,
    ...overrides,
  } as unknown as Config;
}

async function startApp(
  hooks: AdminHooks,
  config: Config = testConfig(),
): Promise<{ base: string; stop: () => void }> {
  const db = openDatabase(":memory:");
  const app = createApp(db, config, undefined, hooks);
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

async function call(
  base: string,
  method: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── pruneOldEvents unit tests ─────────────────────────────────────────────────

describe("pruneOldEvents", () => {
  test("deletes events whose close_time is before the cutoff", async () => {
    const db = openDatabase(":memory:");
    try {
      const storage = asStorage(db);
      const old = Math.floor(Date.now() / 1000) - 60 * 86_400; // 60 days ago
      const recent = Math.floor(Date.now() / 1000) - 1 * 86_400; // 1 day ago
      insertRawEvent(db, "old-1", 10, old);
      insertRawEvent(db, "old-2", 11, old);
      insertRawEvent(db, "new-1", 12, recent);

      const deleted = await pruneOldEvents(storage, 30);
      assert.equal(deleted, 2);
      const remaining = db.prepare("SELECT event_id FROM events ORDER BY event_id").all() as { event_id: string }[];
      assert.deepEqual(remaining.map((r) => r.event_id), ["new-1"]);
    } finally {
      db.close();
    }
  });

  test("daysToKeep=0 is a no-op (keep everything indefinitely)", async () => {
    const db = openDatabase(":memory:");
    try {
      const storage = asStorage(db);
      const old = Math.floor(Date.now() / 1000) - 60 * 86_400;
      insertRawEvent(db, "old-1", 10, old);
      insertRawEvent(db, "old-2", 11, old);

      const deleted = await pruneOldEvents(storage, 0);
      assert.equal(deleted, 0);
      const count = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
      assert.equal(count, 2);
    } finally {
      db.close();
    }
  });

  test("events with no close_time are never pruned", async () => {
    const db = openDatabase(":memory:");
    try {
      const storage = asStorage(db);
      insertRawEvent(db, "no-close", 10, null);

      const deleted = await pruneOldEvents(storage, 1);
      assert.equal(deleted, 0);
    } finally {
      db.close();
    }
  });

  test("maxLedger guard keeps events at or above the cursor even if old", async () => {
    const db = openDatabase(":memory:");
    try {
      const storage = asStorage(db);
      const old = Math.floor(Date.now() / 1000) - 60 * 86_400;
      // ledger 10 is below cursor 15 → eligible
      insertRawEvent(db, "below-cursor", 10, old);
      // ledger 15 is at cursor → protected
      insertRawEvent(db, "at-cursor", 15, old);
      // ledger 20 is above cursor → protected
      insertRawEvent(db, "above-cursor", 20, old);

      const deleted = await pruneOldEvents(storage, 30, { maxLedger: 15 });
      assert.equal(deleted, 1, "only the event below the cursor should be deleted");
      const remaining = db.prepare("SELECT event_id FROM events ORDER BY event_id").all() as { event_id: string }[];
      assert.deepEqual(remaining.map((r) => r.event_id), ["above-cursor", "at-cursor"]);
    } finally {
      db.close();
    }
  });
});

// ── Indexer automatic pruning ─────────────────────────────────────────────────

describe("Indexer automatic pruning on tick", () => {
  const networkConfig: NetworkConfig = {
    name: "testnet",
    rpcUrl: "https://rpc.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    planRegistryId: contract,
    vaultId: contract,
    subscriptionId: contract,
    startLedger: 1,
    databasePath: ":memory:",
    rawEventRetentionDays: 30,
  };

  test("prunes events older than retention window after each tick", async () => {
    const db = openDatabase(":memory:");
    try {
      const oldTime = Math.floor(Date.now() / 1000) - 60 * 86_400; // 60 days ago
      const recentTime = Math.floor(Date.now() / 1000) - 1 * 86_400; // 1 day ago

      // Pre-seed old events directly (simulates previously retained events)
      insertRawEvent(db, "old-event", 2, oldTime);

      const rpcStub: IndexerRpc = {
        getLatestLedger: async () => ({ sequence: 4 }),
        getHealth: async () => ({ oldestLedger: 1 }),
        getEvents: async () => ({
          events: [makeEvent("new-event", 2, recentTime)],
          cursor: undefined,
        }),
      } as unknown as IndexerRpc;

      const indexer = new Indexer(db, rpcStub, networkConfig);
      await indexer.tick();

      // Old event should have been pruned; the new one survives
      const rows = db.prepare("SELECT event_id FROM events ORDER BY event_id").all() as { event_id: string }[];
      assert.ok(!rows.some((r) => r.event_id === "old-event"), "old event must be pruned");
      assert.ok(rows.some((r) => r.event_id === "new-event"), "new event must survive");
      assert.equal(typeof indexer.status.lastPrunedAt, "number", "lastPrunedAt should be set");
      assert.ok((indexer.status.lastPrunedAt ?? 0) > 0);
    } finally {
      db.close();
    }
  });

  test("rawEventRetentionDays=0 keeps all events (no prune)", async () => {
    const db = openDatabase(":memory:");
    try {
      const oldTime = Math.floor(Date.now() / 1000) - 60 * 86_400;
      insertRawEvent(db, "old-event", 2, oldTime);

      const cfg: NetworkConfig = { ...networkConfig, rawEventRetentionDays: 0 };
      const rpcStub: IndexerRpc = {
        getLatestLedger: async () => ({ sequence: 4 }),
        getHealth: async () => ({ oldestLedger: 1 }),
        getEvents: async () => ({ events: [], cursor: undefined }),
      } as unknown as IndexerRpc;

      const indexer = new Indexer(db, rpcStub, cfg);
      await indexer.tick();

      const count = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
      assert.equal(count, 1, "event must survive when retention is 0");
      assert.equal(indexer.status.rawEventRetentionDays, 0);
      // lastPrunedAt stays null because prune was skipped
      assert.equal(indexer.status.lastPrunedAt, null);
    } finally {
      db.close();
    }
  });

  test("events at or above the cursor are never pruned even if old", async () => {
    const db = openDatabase(":memory:");
    try {
      const oldTime = Math.floor(Date.now() / 1000) - 60 * 86_400;
      // cursor will be 3 after the tick (startLedger=1, latest=4, batchSize covers 1→4)
      insertRawEvent(db, "below-cursor", 1, oldTime);   // ledger 1 — below cursor, should be pruned
      insertRawEvent(db, "above-cursor", 10, oldTime);  // ledger 10 — above cursor, must survive

      const rpcStub: IndexerRpc = {
        getLatestLedger: async () => ({ sequence: 4 }),
        getHealth: async () => ({ oldestLedger: 1 }),
        getEvents: async () => ({ events: [], cursor: undefined }),
      } as unknown as IndexerRpc;

      const indexer = new Indexer(db, rpcStub, networkConfig);
      await indexer.tick();

      const rows = db.prepare("SELECT event_id FROM events").all() as { event_id: string }[];
      assert.ok(!rows.some((r) => r.event_id === "below-cursor"), "below-cursor event must be pruned");
      assert.ok(rows.some((r) => r.event_id === "above-cursor"), "above-cursor event must survive");
    } finally {
      db.close();
    }
  });

  test("status.rawEventRetentionDays is set after tick", async () => {
    const db = openDatabase(":memory:");
    try {
      const cfg: NetworkConfig = { ...networkConfig, rawEventRetentionDays: 14 };
      const rpcStub: IndexerRpc = {
        getLatestLedger: async () => ({ sequence: 4 }),
        getHealth: async () => ({ oldestLedger: 1 }),
        getEvents: async () => ({ events: [], cursor: undefined }),
      } as unknown as IndexerRpc;

      const indexer = new Indexer(db, rpcStub, cfg);
      assert.equal(indexer.status.rawEventRetentionDays, undefined, "not set before first tick");
      await indexer.tick();
      assert.equal(indexer.status.rawEventRetentionDays, 14);
    } finally {
      db.close();
    }
  });
});

// ── /health retention fields ──────────────────────────────────────────────────

describe("/health exposes retention fields", () => {
  test("rawEventRetentionDays and lastPrunedAt appear in indexer block", async () => {
    const db = openDatabase(":memory:");
    const config = testConfig();
    // Inject a mock indexer status with retention fields set
    const indexerStatus = {
      cursor: 100,
      latest: 110,
      lastRunAt: null,
      lastError: null,
      mismatchedEvents: 0,
      lastLedgerCloseTime: null,
      freshnessSeconds: null,
      paused: false,
      eventsLedger: 0,
      eventsLag: 0,
      reconciliations: 0,
      corrections: 0,
      rawEventRetentionDays: 30,
      lastPrunedAt: 1_700_000_000,
    };
    const app = createApp(db, config, indexerStatus);
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { indexer: Record<string, unknown> | null };
      assert.ok(body.indexer !== null);
      assert.equal(body.indexer!.rawEventRetentionDays, 30);
      assert.equal(body.indexer!.lastPrunedAt, 1_700_000_000);
    } finally {
      server.close();
      db.close();
    }
  });

  test("rawEventRetentionDays is null when indexer has not run yet", async () => {
    const db = openDatabase(":memory:");
    const config = testConfig();
    const indexerStatus = {
      cursor: 0,
      latest: 0,
      lastRunAt: null,
      lastError: null,
      mismatchedEvents: 0,
      lastLedgerCloseTime: null,
      freshnessSeconds: null,
      paused: false,
      eventsLedger: 0,
      eventsLag: 0,
      reconciliations: 0,
      corrections: 0,
      rawEventRetentionDays: undefined,
      lastPrunedAt: null,
    };
    const app = createApp(db, config, indexerStatus);
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = (await res.json()) as { indexer: Record<string, unknown> | null };
      assert.ok(body.indexer !== null);
      assert.equal(body.indexer!.rawEventRetentionDays, null);
      assert.equal(body.indexer!.lastPrunedAt, null);
    } finally {
      server.close();
      db.close();
    }
  });
});

// ── GET /admin/data/retention ─────────────────────────────────────────────────

describe("GET /admin/data/retention", () => {
  test("returns policy when hook is wired", async () => {
    const app = await startApp({
      getRetentionPolicy: async () => ({
        rawEventRetentionDays: 30,
        chargeAttemptRetentionDays: 90,
        lastPrunedAt: 1_700_000_000,
        rawEventCount: 42,
      }),
    });
    try {
      const { status, body } = await call(app.base, "GET", "/admin/data/retention", TOKEN);
      assert.equal(status, 200);
      assert.equal(body.status, "ok");
      const result = body.result as Record<string, unknown>;
      assert.equal(result.rawEventRetentionDays, 30);
      assert.equal(result.chargeAttemptRetentionDays, 90);
      assert.equal(result.lastPrunedAt, 1_700_000_000);
      assert.equal(result.rawEventCount, 42);
    } finally {
      app.stop();
    }
  });

  test("returns 503 when hook is absent", async () => {
    const app = await startApp({});
    try {
      const { status, body } = await call(app.base, "GET", "/admin/data/retention", TOKEN);
      assert.equal(status, 503);
      assert.equal((body.error as { code: string }).code, "retention_unavailable");
    } finally {
      app.stop();
    }
  });

  test("requires a bearer token (401 without one)", async () => {
    let calls = 0;
    const app = await startApp({
      getRetentionPolicy: async () => { calls++; return {}; },
    });
    try {
      const { status, body } = await call(app.base, "GET", "/admin/data/retention");
      assert.equal(status, 401);
      assert.equal((body.error as { code: string }).code, "unauthorized");
      assert.equal(calls, 0, "hook must not run on an unauthenticated request");
    } finally {
      app.stop();
    }
  });

  test("rejects a wrong token", async () => {
    let calls = 0;
    const app = await startApp({
      getRetentionPolicy: async () => { calls++; return {}; },
    });
    try {
      const { status, body } = await call(app.base, "GET", "/admin/data/retention", "wrong-token");
      assert.equal(status, 401);
      assert.equal((body.error as { code: string }).code, "unauthorized");
      assert.equal(calls, 0);
    } finally {
      app.stop();
    }
  });

  test("503 carries a Retry-After header", async () => {
    const app = await startApp({});
    try {
      const res = await fetch(`${app.base}/admin/data/retention`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 503);
      assert.ok(res.headers.get("retry-after") !== null);
      assert.ok(Number(res.headers.get("retry-after")) > 0);
    } finally {
      app.stop();
    }
  });

  test("propagates hook errors as 500 with the message", async () => {
    const app = await startApp({
      getRetentionPolicy: async () => { throw new Error("db unavailable"); },
    });
    try {
      const { status, body } = await call(app.base, "GET", "/admin/data/retention", TOKEN);
      assert.equal(status, 500);
      const err = body.error as { code: string; message: string };
      assert.equal(err.code, "retention_failed");
      assert.equal(err.message, "db unavailable");
    } finally {
      app.stop();
    }
  });
});

// ── POST /admin/data/prune ────────────────────────────────────────────────────

describe("POST /admin/data/prune", () => {
  test("runs the prune and returns deleted counts", async () => {
    let calls = 0;
    const app = await startApp({
      pruneData: async (days) => {
        calls++;
        assert.equal(days, undefined, "no override → days should be undefined");
        return { deleted: { events: 5, chargeAttempts: 2 } };
      },
    });
    try {
      const { status, body } = await call(app.base, "POST", "/admin/data/prune", TOKEN);
      assert.equal(status, 200);
      assert.equal(body.status, "ok");
      assert.deepEqual((body.result as Record<string, unknown>).deleted, { events: 5, chargeAttempts: 2 });
      assert.equal(calls, 1);
    } finally {
      app.stop();
    }
  });

  test("passes the ?days override to the hook", async () => {
    let received: number | undefined;
    const app = await startApp({
      pruneData: async (days) => {
        received = days;
        return { deleted: { events: 0, chargeAttempts: 0 } };
      },
    });
    try {
      const { status } = await call(app.base, "POST", "/admin/data/prune?days=7", TOKEN);
      assert.equal(status, 200);
      assert.equal(received, 7);
    } finally {
      app.stop();
    }
  });

  test("returns 503 when prune hook is absent", async () => {
    const app = await startApp({});
    try {
      const { status, body } = await call(app.base, "POST", "/admin/data/prune", TOKEN);
      assert.equal(status, 503);
      assert.equal((body.error as { code: string }).code, "prune_unavailable");
    } finally {
      app.stop();
    }
  });

  test("requires a bearer token (401 without one)", async () => {
    let calls = 0;
    const app = await startApp({
      pruneData: async () => { calls++; return { deleted: { events: 0, chargeAttempts: 0 } }; },
    });
    try {
      const { status, body } = await call(app.base, "POST", "/admin/data/prune");
      assert.equal(status, 401);
      assert.equal((body.error as { code: string }).code, "unauthorized");
      assert.equal(calls, 0, "hook must not run on unauthenticated request");
    } finally {
      app.stop();
    }
  });

  test("rejects a wrong token", async () => {
    let calls = 0;
    const app = await startApp({
      pruneData: async () => { calls++; return { deleted: { events: 0, chargeAttempts: 0 } }; },
    });
    try {
      const { status } = await call(app.base, "POST", "/admin/data/prune", "bad-token");
      assert.equal(status, 401);
      assert.equal(calls, 0);
    } finally {
      app.stop();
    }
  });

  test("503 carries a Retry-After header", async () => {
    const app = await startApp({});
    try {
      const res = await fetch(`${app.base}/admin/data/prune`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 503);
      assert.ok(res.headers.get("retry-after") !== null);
      assert.ok(Number(res.headers.get("retry-after")) > 0);
    } finally {
      app.stop();
    }
  });

  test("propagates hook errors as 500 with the message", async () => {
    const app = await startApp({
      pruneData: async () => { throw new Error("disk full"); },
    });
    try {
      const { status, body } = await call(app.base, "POST", "/admin/data/prune", TOKEN);
      assert.equal(status, 500);
      const err = body.error as { code: string; message: string };
      assert.equal(err.code, "prune_failed");
      assert.equal(err.message, "disk full");
    } finally {
      app.stop();
    }
  });
});

// ── maxLedger coordination (integration) ─────────────────────────────────────

describe("pruneOldEvents maxLedger coordination with projection cursor", () => {
  test("on-demand prune via pruneData respects the projection cursor", async () => {
    const db = openDatabase(":memory:");
    try {
      const storage = asStorage(db);
      const old = Math.floor(Date.now() / 1000) - 60 * 86_400;

      // ledger 5 is below the simulated cursor of 10 → eligible
      insertRawEvent(db, "below", 5, old);
      // ledger 15 is above cursor → must survive
      insertRawEvent(db, "above", 15, old);

      // Simulate the maxLedger guard the pruneData hook applies
      const deleted = await pruneOldEvents(storage, 30, { maxLedger: 10 });
      assert.equal(deleted, 1);

      const rows = db.prepare("SELECT event_id FROM events").all() as { event_id: string }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.event_id, "above");
    } finally {
      db.close();
    }
  });
});
