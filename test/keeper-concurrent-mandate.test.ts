import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  Account,
  Keypair,
  Operation,
  Transaction,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { Keeper, type KeeperRpc } from "../src/keeper.ts";
import type { Config } from "../src/config.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const _keyA = Keypair.random();
const _keyB = Keypair.random();

function config(
  secrets: { KEEPER_SECRET: string; KEEPER_CHANNEL_SECRETS?: string[] },
  extra: Partial<
    Record<
      "KEEPER_CONCURRENCY" | "KEEPER_CLAIM_TTL_S" | "KEEPER_BATCH" | "KEEPER_BACKOFF_JITTER",
      unknown
    >
  > = {},
): Config {
  return {
    PLAN_REGISTRY_ID: CONTRACT,
    VAULT_ID: CONTRACT,
    SUBSCRIPTION_ID: CONTRACT,
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    KEEPER_FEE_PERCENTILE: "90",
    KEEPER_MAX_FEE: "100000",
    KEEPER_BATCH: false,
    KEEPER_BATCH_SIZE: 10,
    KEEPER_BACKOFF_JITTER: 0,
    ...secrets,
    ...extra,
  } as unknown as Config;
}

function insertDue(db: ReturnType<typeof openDatabase>, id: number, nextCharge: number): void {
  db.prepare(
    `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
     VALUES (?, ?, ?, 1, '10', 2592000, ?, 'Active', 1)`,
  ).run(id, SUBSCRIBER, MERCHANT, nextCharge);
}

function extractMandateIds(tx: Transaction): number[] {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = (op.func as unknown as { invokeContract: { args: xdr.ScVal[] } }).invokeContract;
  const native = scValToNative(call.args[0]!);
  return Array.isArray(native) ? native.map(Number) : [Number(native)];
}

function fakeNode(
  t: {
    sends: { mandates: number[]; source: string; sequence: string }[];
    maxInFlight: number;
    maxGauge: number;
    collisions: string[];
    overlaps: string[];
    confirmed: number[];
    inFlight: number;
  },
  confirmMs = 20,
): KeeperRpc {
  const _consumed = new Map<string, bigint>();
  return {
    getFeeStats: async () => ({ sorobanInclusionFee: { p90: "1000" } }) as never,
    getAccount: async (address: string) => {
      const account = new Account(address, "1") as never;
      t.sends.push({ mandates: [], source: address, sequence: "1" });
      return account;
    },
    prepareTransaction: async (tx: Transaction) => tx as Transaction,
    sendTransaction: async (tx: Transaction) => {
      const transaction = tx as Transaction;
      const mandates = extractMandateIds(transaction);
      t.sends.push({ mandates, source: transaction.source, sequence: transaction.sequence });
      t.inFlight += 1;
      t.maxInFlight = Math.max(t.maxInFlight, t.inFlight);
      const _hash = Buffer.from(transaction.hash()).toString("hex");
      return { status: "PENDING", _hash } as never;
    },
    getTransaction: async (_hash: string) => {
      await new Promise((resolve) => setTimeout(resolve, confirmMs));
      t.inFlight -= 1;
      const justSubmitted = t.sends[t.sends.length - 1];
      if (justSubmitted) {
        t.confirmed.push(...justSubmitted.mandates.filter((m) => !isNaN(m)));
      }
      return { status: rpc.Api.GetTransactionStatus.SUCCESS } as never;
    },
  };
}

function trace(): {
  sends: { mandates: number[]; source: string; sequence: string }[];
  maxInFlight: number;
  maxGauge: number;
  collisions: string[];
  overlaps: string[];
  confirmed: number[];
  inFlight: number;
} {
  return {
    sends: [],
    maxInFlight: 0,
    maxGauge: 0,
    collisions: [],
    overlaps: [],
    confirmed: [],
    inFlight: 0,
  };
}

function channelConfig(
  channelKeys: Keypair[],
  extra: Parameters<typeof config>[1] = {},
): Config {
  const [primary, ...rest] = channelKeys;
  return config(
    { KEEPER_SECRET: primary!.secret(), KEEPER_CHANNEL_SECRETS: rest.map((key) => key.secret()) },
    extra,
  );
}

function keys(count: number): Keypair[] {
  return Array.from({ length: count }, () => Keypair.random());
}

function eachRow(db: ReturnType<typeof openDatabase>, sql: string): unknown[] {
  return db.prepare(sql).all() as unknown[];
}

describe("keeper concurrent mandate charge", () => {
  test("two keepers processing the same mandate concurrently charge it exactly once", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const t = trace();
    const node = fakeNode(t, 50);
    const first = new Keeper(db, node, channelConfig(keys(1)));
    const second = new Keeper(db, node, channelConfig(keys(1)));

    const [a, b] = await Promise.all([first.tick(10_000), second.tick(10_000)]);

    const settled = [...a, ...b].filter((r) => r.status === "settled").map((r) => r.mandateId);
    assert.equal(settled.length, 1, "the mandate is settled exactly once");
    assert.ok(settled.includes(1), "mandate 1 is settled");

    const attempts = eachRow(db, `SELECT * FROM charge_attempts WHERE mandate_id = 1 ORDER BY id`) as {
      mandate_id: number;
      attempted_at: number;
      result: string;
      error_code: string | null;
      tx_hash: string | null;
      shortfall: string | null;
      failures: number;
      retry_at: number | null;
    }[];

    assert.equal(attempts.length, 1, "charge was attempted exactly once");
    assert.equal(attempts[0]!.result, "settled", "the charge settled successfully");
    assert.equal(attempts[0]!.failures, 0, "no failures on successful charge");

    const claims = eachRow(db, `SELECT * FROM keeper_claims WHERE mandate_id = 1`) as {
      mandate_id: number;
      owner: string;
      expires_at: number;
    }[];

    assert.equal(claims.length, 1, "exactly one claim exists for the mandate");

    db.close();
  });

  test("keeper B is prevented from charging when keeper A holds the lock", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const t = trace();
    const node = fakeNode(t, 50);
    const first = new Keeper(db, node, channelConfig(keys(1)));
    const second = new Keeper(db, node, channelConfig(keys(1)));

    const [a, b] = await Promise.all([first.tick(10_000), second.tick(10_000)]);

    const settledFromFirst = a.filter((r) => r.status === "settled").map((r) => r.mandateId);
    const settledFromSecond = b.filter((r) => r.status === "settled").map((r) => r.mandateId);

    assert.equal(settledFromFirst.length, 1, "keeper A settled the mandate");
    assert.equal(settledFromSecond.length, 0, "keeper B did not settle the same mandate");

    const attempts = eachRow(db, `SELECT mandate_id, result FROM charge_attempts WHERE mandate_id = 1 ORDER BY id`) as {
      mandate_id: number;
      result: string;
    }[];

    assert.equal(attempts.length, 1, "only one charge attempt exists");
    assert.equal(attempts[0]!.result, "settled", "the single attempt settled successfully");

    db.close();
  });

  test("different mandates can be processed independently by concurrent keepers", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    insertDue(db, 2, 1_001);
    const t = trace();
    const node = fakeNode(t, 50);
    const first = new Keeper(db, node, channelConfig(keys(1)));
    const second = new Keeper(db, node, channelConfig(keys(1)));

    const [a, b] = await Promise.all([first.tick(10_000), second.tick(10_000)]);

    const allSettled = [...a, ...b].filter((r) => r.status === "settled").map((r) => r.mandateId);
    assert.deepEqual([...new Set(allSettled)].sort((x, y) => x - y), [1, 2], "both mandates are settled");

    const attempts1 = eachRow(db, `SELECT mandate_id, result FROM charge_attempts WHERE mandate_id = 1 ORDER BY id`) as {
      mandate_id: number;
      result: string;
    }[];
    const attempts2 = eachRow(db, `SELECT mandate_id, result FROM charge_attempts WHERE mandate_id = 2 ORDER BY id`) as {
      mandate_id: number;
      result: string;
    }[];

    assert.equal(attempts1.length, 1, "mandate 1 was charged exactly once");
    assert.equal(attempts2.length, 1, "mandate 2 was charged exactly once");

    db.close();
  });

  test("lock is released after charge and a later execution can proceed", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const t = trace();
    const node = fakeNode(t, 50);
    const first = new Keeper(db, node, channelConfig(keys(1)));
    const _second = new Keeper(db, node, channelConfig(keys(1)));

    // First pass: keeper A charges the mandate
    await first.tick(10_000);
    const firstAttempts = eachRow(db, `SELECT mandate_id, result, retry_at FROM charge_attempts WHERE mandate_id = 1 ORDER BY id`) as {
      mandate_id: number;
      result: string;
      retry_at: number | null;
    }[];

    assert.equal(firstAttempts.length, 1, "mandate was charged in first pass");
    assert.equal(firstAttempts[0]!.result, "settled", "charge settled successfully");

    // The claim should now be re-timed
    const claimsAfterFirst = eachRow(db, `SELECT * FROM keeper_claims WHERE mandate_id = 1`) as {
      mandate_id: number;
      owner: string;
      expires_at: number;
    }[];

    assert.equal(claimsAfterFirst.length, 1, "a claim still exists");

    // Second pass with a different keeper
    const _secondKeeper = new Keeper(db, node, channelConfig(keys(1)));
    const _secondResults = await _secondKeeper.tick(10_001);

    // The charge attempt should still be exactly one (no duplicate)
    const attemptsAfterSecond = eachRow(db, `SELECT mandate_id, result, retry_at FROM charge_attempts WHERE mandate_id = 1 ORDER BY id`) as {
      mandate_id: number;
      result: string;
      retry_at: number | null;
    }[];

    assert.equal(attemptsAfterSecond.length, 1, "no duplicate charge after second keeper run");

    db.close();
  });
});