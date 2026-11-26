import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import { Indexer } from "../src/indexer.ts";
import { getMerchantSummary, getPlanById, getProtocolStats, listChargeAttempts, listMandateCharges, listPlans, listMandates } from "../src/lib/queries.ts";
import { claimCharge, holdClaim, pruneClaims } from "../src/lib/claims.ts";
import {
  DEFAULT_POOL_SETTINGS,
  PostgresStorage,
  explainCheckoutTimeout,
  poolConfigFor,
} from "../src/lib/store/postgres.ts";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import type { Storage } from "../src/lib/store/types.ts";
import { WebhookDispatcher } from "../src/lib/webhooks.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import { asReader, TokenMetadataService } from "../src/lib/tokens.ts";
import { MerchantSummaryCache } from "../src/routes/index.ts";
import { sep10For } from "../src/routes/auth.ts";
import { Keypair, Networks, TransactionBuilder, xdr, type rpc } from "@stellar/stellar-sdk";
import { createHmac } from "node:crypto";

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

test("the PostgreSQL pool is sized and bounded by the configured timeouts (#263)", () => {
  const config = poolConfigFor("postgres://payflow:secret@db.example/payflow", "payflow_testnet", {
    max: 20,
    acquireTimeoutMs: 2_000,
    statementTimeoutMs: 5_000,
  });

  assert.equal(config.max, 20, "the pool holds at most the configured connections");
  assert.equal(config.connectionTimeoutMillis, 2_000, "a checkout cannot wait forever");
  assert.equal(config.statement_timeout, 5_000, "PostgreSQL cancels a runaway statement");
  assert.match(String(config.options), /search_path=payflow_testnet/, "the network's schema is kept");
});

/** The error a pool checkout timeout answers with, restated with the setting's name. */
test("a pool checkout timeout names DATABASE_ACQUIRE_TIMEOUT_MS", () => {
  const err = explainCheckoutTimeout(
    new Error("timeout exceeded when trying to connect"),
    { max: 4, acquireTimeoutMs: 750, statementTimeoutMs: 1_000 },
  );
  assert.ok(err instanceof Error);
  assert.match(err.message, /750 ms/);
  assert.match(err.message, /DATABASE_ACQUIRE_TIMEOUT_MS/);
  assert.match(err.message, /DATABASE_POOL_MAX\)/);
  assert.ok(err.cause instanceof Error, "the driver's error is kept as the cause");

  // Anything else is passed through untouched, so a real query error keeps its own message.
  const query = new Error("duplicate key value violates unique constraint");
  assert.equal(explainCheckoutTimeout(query, DEFAULT_POOL_SETTINGS), query);
  assert.equal(explainCheckoutTimeout("not an error", DEFAULT_POOL_SETTINGS), "not an error");
});

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

test("the server enforces the configured statement timeout (#263)", { skip: !DATABASE_URL }, async () => {
  const storage = await PostgresStorage.open(
    DATABASE_URL!,
    `timeout_${process.pid}_${randomBytes(4).toString("hex")}`,
    { max: 2, acquireTimeoutMs: 5_000, statementTimeoutMs: 1_234 },
  );
  try {
    const [row] = await storage.all<{ statement_timeout: string }>("SHOW statement_timeout");
    assert.equal(row?.statement_timeout, "1234ms", "the startup packet carried the timeout");
  } finally {
    await storage.close();
  }
});

test("a saturated pool fails a query instead of queueing forever (#263)", { skip: !DATABASE_URL }, async () => {
  const storage = await PostgresStorage.open(
    DATABASE_URL!,
    `saturated_${process.pid}_${randomBytes(4).toString("hex")}`,
    { max: 1, acquireTimeoutMs: 200, statementTimeoutMs: 10_000 },
  );
  try {
    const held = storage.transaction(async (tx) => {
      await tx.all("SELECT pg_sleep(0.6)");
    });
    // Let the transaction take the pool's only connection before contending.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(
      storage.all("SELECT 1"),
      /DATABASE_ACQUIRE_TIMEOUT_MS/,
      "the second query times out acquiring the held connection",
    );
    await held;
  } finally {
    await storage.close();
  }
});

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
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
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

/**
 * Issue #262: run the same store contract tests against SQLite and
 * PostgreSQL so the two backends stay behaviourally parallel.
 *
 * The `backends` list above always runs SQLite and optionally PostgreSQL when
 * DATABASE_URL is set; the `skip: !DATABASE_URL` tests compare the two
 * directly. Every store contract below is exercised on both backends.
 */

/** Writes three keeper charge attempts for mandate 1, newest insert last. */
async function recordChargeAttempts(storage: Storage): Promise<void> {
  await storage.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO charge_attempts (mandate_id, attempted_at, result, error_code, tx_hash, shortfall, failures, retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, 1_700_000_000, "settled", null, "tx-a", null, 0, null],
    );
    await tx.run(
      `INSERT INTO charge_attempts (mandate_id, attempted_at, result, error_code, tx_hash, shortfall, failures, retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, 1_700_000_100, "skipped", "insufficient_funds", null, "5000000", 1, 1_700_000_200],
    );
    await tx.run(
      `INSERT INTO charge_attempts (mandate_id, attempted_at, result, error_code, tx_hash, shortfall, failures, retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, 1_700_000_050, "failed", "tx_failed", "tx-b", null, 2, null],
    );
  });
}

for (const backend of backends) {
  test(`${backend.name}: keeper charge attempts are written and read back newest-first`, async () => {
    const storage = await backend.open();
    try {
      await recordChargeAttempts(storage);
      const attempts = await listChargeAttempts(storage, 1, 10);
      assert.equal(attempts.length, 3, "all three attempts are stored");
      // Reads are ordered by id DESC, so the last insert comes back first.
      assert.equal(attempts[0]!.result, "failed");
      assert.equal(attempts[0]!.errorCode, "tx_failed");
      assert.equal(attempts[0]!.txHash, "tx-b");
      assert.equal(attempts[0]!.failures, 2);
      assert.equal(attempts[0]!.retryAt, null);
      assert.equal(attempts[1]!.result, "skipped");
      assert.equal(attempts[1]!.errorCode, "insufficient_funds");
      assert.equal(attempts[1]!.txHash, null);
      assert.equal(attempts[1]!.shortfall, "5000000");
      assert.equal(attempts[1]!.failures, 1);
      assert.equal(attempts[1]!.retryAt, 1_700_000_200);
      assert.equal(attempts[2]!.result, "settled");
      assert.equal(attempts[2]!.errorCode, null);
      assert.equal(attempts[2]!.txHash, "tx-a");
      assert.equal(attempts[2]!.failures, 0);
      assert.equal(attempts[2]!.retryAt, null);
    } finally {
      await storage.close();
    }
  });
}

test("SQLite and PostgreSQL return identical charge attempts", { skip: !DATABASE_URL }, async () => {
  const sqlite = await SqliteStorage.open(":memory:");
  const postgres = await PostgresStorage.open(
    DATABASE_URL!,
    `attempts_${process.pid}_${randomBytes(4).toString("hex")}`,
  );
  try {
    await recordChargeAttempts(sqlite);
    await recordChargeAttempts(postgres);
    assert.deepEqual(
      await listChargeAttempts(sqlite, 1, 10),
      await listChargeAttempts(postgres, 1, 10),
      "both backends return the same attempts",
    );
  } finally {
    await Promise.all([sqlite.close(), postgres.close()]);
  }
});

for (const backend of backends) {
  test(`${backend.name}: duplicate charge write is idempotent`, async () => {
    const storage = await backend.open();
    try {
      await storage.run(
        `INSERT INTO charges (tx_hash, mandate_id, subscriber, merchant, amount, fee, charges_made, next_charge, ledger, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tx_hash, mandate_id) DO NOTHING`,
        ["tx-1", 1, SUBSCRIBER, MERCHANT, "100", "10", 1, 200, 10, 1000],
      );
      await storage.run(
        `INSERT INTO charges (tx_hash, mandate_id, subscriber, merchant, amount, fee, charges_made, next_charge, ledger, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tx_hash, mandate_id) DO NOTHING`,
        ["tx-1", 1, SUBSCRIBER, MERCHANT, "100", "10", 1, 200, 10, 1000],
      );
      const rows = await storage.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM charges WHERE tx_hash = ? AND mandate_id = ?",
        ["tx-1", 1],
      );
      assert.equal(rows[0]!.n, 1, "replayed charge keeps a single row");
    } finally {
      await storage.close();
    }
  });

  test(`${backend.name}: duplicate mandate_events write is idempotent`, async () => {
    const storage = await backend.open();
    try {
      await storage.run(
        `INSERT OR IGNORE INTO mandate_events (mandate_id, slot, merchant, kind, at, ledger) VALUES (?, ?, ?, ?, ?, ?)`,
        [1, "start", MERCHANT, "started", 1_700_000_000, 10],
      );
      await storage.run(
        `INSERT OR IGNORE INTO mandate_events (mandate_id, slot, merchant, kind, at, ledger) VALUES (?, ?, ?, ?, ?, ?)`,
        [1, "start", MERCHANT, "started", 1_700_000_000, 10],
      );
      const rows = await storage.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM mandate_events WHERE mandate_id = ? AND slot = ?",
        [1, "start"],
      );
      assert.equal(rows[0]!.n, 1, "replayed churn event keeps a single row");
    } finally {
      await storage.close();
    }
  });

  test(`${backend.name}: raw duplicate primary key insert is rejected`, async () => {
    const storage = await backend.open();
    try {
      await storage.run(
        `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [1, MERCHANT, "Plan", TOKEN, "100", 60, 1, 10],
      );
      await assert.rejects(
        storage.run(
          `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [1, MERCHANT, "Plan", TOKEN, "100", 60, 1, 10],
        ),
        (err: unknown) => /duplicate|unique|constraint/i.test(String((err as Error)?.message ?? err)),
        "duplicate primary key is rejected",
      );
    } finally {
      await storage.close();
    }
  });
}

const JWT_SECRET = "a-jwt-secret-that-is-at-least-32-characters";

/** Sign a SEP-10 challenge envelope with the client's keys, as a wallet does. */
function signTx(envelope: string, ...keys: Keypair[]): string {
  const tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
  tx.sign(...keys);
  return tx.toXDR();
}

/** An HS256 JWT signed with `secret`, for forging tampered tokens. */
function forgeToken(claims: Record<string, unknown>, secret = JWT_SECRET): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/** Build an API serving SEP-10 sign-in and merchant webhook routes over `storage`. */
async function makeAuthApp(storage: Storage): Promise<{ server: Server; base: string }> {
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
  const serverKey = Keypair.random();
  const config = {
    CORS_ORIGIN: "*",
    SEP10_SIGNING_KEY: serverKey.secret(),
    SEP10_JWT_SECRET: JWT_SECRET,
    SEP10_HOME_DOMAIN: "payflow.example",
    SEP10_WEB_AUTH_DOMAIN: "api.payflow.example",
    SEP10_JWT_TTL_S: 900,
    SEP10_REFRESH_TTL_S: 604_800,
  } as unknown as Config;
  // No account exists on the fake RPC, so a master-key signature is enough to sign in.
  const fakeRpc = {
    getLedgerEntries: async (..._keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse> =>
      ({ entries: [], latestLedger: 1 } as never),
  };
  const auth = sep10For(config, network, fakeRpc, storage)!;
  const dispatcher = new WebhookDispatcher({
    db: storage,
    fetchImpl: async () => new Response("ok", { status: 200 }),
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  const app = createApp(
    [{ config: network, db: storage, tokens, webhooks: dispatcher, auth }],
    config,
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

for (const backend of backends) {
  test(`${backend.name}: SEP-10 sign-in and bearer-token merchant routes`, async () => {
    const storage = await backend.open();
    let server: Server | undefined;
    try {
      const { server: http, base } = await makeAuthApp(storage);
      server = http;

      const challenge = async (account: string): Promise<string> => {
        const res = await fetch(`${base}/api/auth?account=${account}`);
        assert.equal(res.status, 200, `${account} challenge`);
        return ((await res.json()) as { transaction: string }).transaction;
      };
      const exchange = async (transaction: string) => {
        const res = await fetch(`${base}/api/auth`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transaction }),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const signIn = async (key: Keypair): Promise<string> => {
        const res = await exchange(signTx(await challenge(key.publicKey()), key));
        assert.equal(res.status, 200, "sign-in");
        return res.body.token as string;
      };

      const merchant = Keypair.random();
      const token = await signIn(merchant);

      // A bearer token registers a webhook for the token's account.
      const registered = await fetch(`${base}/api/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: "https://merchant.example/hooks" }),
      });
      assert.equal(registered.status, 200, "register webhook with bearer token");
      const hook = (await registered.json()) as { id: number; merchant: string };
      assert.equal(hook.merchant, merchant.publicKey(), "the merchant is the token's account");

      // The same token lists that merchant's webhooks.
      const listed = await fetch(`${base}/api/webhooks?merchant=${merchant.publicKey()}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(listed.status, 200, "list webhooks with bearer token");
      const listedBody = (await listed.json()) as { merchant: string; webhooks: Array<{ id: number }> };
      assert.equal(listedBody.merchant, merchant.publicKey());
      assert.ok(listedBody.webhooks.some((w) => w.id === hook.id));

      // A token for one account cannot act for another.
      const other = Keypair.random();
      const refused = await fetch(`${base}/api/webhooks?merchant=${other.publicKey()}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(refused.status, 401, "cross-account merchant refused");

      // A token signed with another secret is refused (the HMAC no longer verifies).
      const claims = JSON.parse(
        Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const foreign = forgeToken(claims, "another-secret-that-is-also-32-characters");
      const bad = await fetch(`${base}/api/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${foreign}` },
        body: JSON.stringify({ url: "https://merchant.example/hooks" }),
      });
      assert.equal(bad.status, 401, "foreign-secret token refused");
    } finally {
      await storage.close();
      const httpServer = server;
      if (httpServer) {
        await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
      }
    }
  });
}

/**
 * Issue #249: the keeper's claim upsert is the only thing standing between
 * two keeper processes and a double settlement, so it is checked on both
 * backends with two *separate* connections racing for the same due charges.
 */
type ClaimPair = { name: string; skip: boolean; open: () => Promise<[Storage, Storage, () => Promise<void>]> };

const claimPairs: ClaimPair[] = [
  {
    name: "SQLite",
    skip: false,
    open: async () => {
      const dir = mkdtempSync(join(tmpdir(), "payflow-claims-store-"));
      const path = join(dir, "payflow.db");
      const left = SqliteStorage.open(path);
      const right = SqliteStorage.open(path);
      return [left, right, async () => {
        await left.close();
        await right.close();
        rmSync(dir, { recursive: true, force: true });
      }];
    },
  },
  {
    name: "PostgreSQL",
    skip: !DATABASE_URL,
    open: async () => {
      const network = `claims_${process.pid}_${randomBytes(4).toString("hex")}`;
      // Opened one after the other: each open creates the schema if missing.
      const left = await PostgresStorage.open(DATABASE_URL!, network);
      const right = await PostgresStorage.open(DATABASE_URL!, network);
      return [left, right, async () => {
        await left.close();
        await right.close();
      }];
    },
  },
];

for (const pair of claimPairs) {
  test(`${pair.name}: two connections racing for the same due charges claim each exactly once`, { skip: pair.skip }, async () => {
    const [left, right, close] = await pair.open();
    try {
      const ids = Array.from({ length: 40 }, (_, i) => i + 1);
      const request = (mandateId: number, owner: string) => ({
        mandateId,
        dueAt: 1_000 + mandateId,
        owner,
        now: 10_000,
        ttlSeconds: 300,
      });
      const outcomes = await Promise.all(
        ids.flatMap((id) => [
          claimCharge(left, request(id, "keeper-a")).then((won) => ({ id, won })),
          claimCharge(right, request(id, "keeper-b")).then((won) => ({ id, won })),
        ]),
      );
      for (const id of ids) {
        assert.equal(
          outcomes.filter((outcome) => outcome.id === id && outcome.won).length,
          1,
          `due charge ${id} has exactly one winner`,
        );
      }

      // A claim past its expiry is taken over by the other connection.
      assert.equal(await claimCharge(right, { ...request(1, "keeper-c"), now: 10_299 }), false);
      assert.equal(await claimCharge(right, { ...request(1, "keeper-c"), now: 10_300 }), true);
      // Re-timing only touches the owner's own claim.
      await holdClaim(left, { mandateId: 1, dueAt: 1_001, owner: "keeper-a", until: 0 });
      assert.equal(await claimCharge(left, { ...request(1, "keeper-a"), now: 10_301 }), false);

      await pruneClaims(left, 100_000);
      assert.deepEqual(await right.all("SELECT mandate_id FROM keeper_claims"), []);
    } finally {
      await close();
    }
  });
}
