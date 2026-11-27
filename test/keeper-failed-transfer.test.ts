import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { Account, Keypair, Operation, Transaction, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { Keeper, type KeeperRpc } from "../src/keeper.ts";
import type { Config } from "../src/config.ts";

/**
 * Issue #256: a charge that fails — on chain or before it gets there — must
 * leave the mandate due and unadvanced. Only the indexer moves `next_charge`
 * (from a `charged` event), so the keeper must never touch the mandate row,
 * and once the backoff lapses the very same due charge is picked up again.
 *
 * Every RPC answer is scripted; nothing here talks to a network.
 */

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const NOW = 10_000;
const DUE_AT = 1_000;
/** `KEEPER_BACKOFF_BASE_S` default: the first retry waits this long. */
const BASE_S = 60;

type Db = ReturnType<typeof openDatabase>;

function config(extra: Record<string, unknown> = {}): Config {
  return {
    PLAN_REGISTRY_ID: CONTRACT,
    VAULT_ID: CONTRACT,
    SUBSCRIPTION_ID: CONTRACT,
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    KEEPER_SECRET: Keypair.random().secret(),
    KEEPER_FEE_PERCENTILE: "90",
    KEEPER_MAX_FEE: "100000",
    KEEPER_BATCH: false,
    KEEPER_BATCH_SIZE: 10,
    // Exact retry times; the jitter has its own tests.
    KEEPER_BACKOFF_JITTER: 0,
    ...extra,
  } as unknown as Config;
}

function insertDue(db: Db, id: number, nextCharge = DUE_AT, chargesMade = 0): void {
  db.prepare(
    `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger, charges_made)
     VALUES (?, ?, ?, 1, '10', 2592000, ?, 'Active', 1, ?)`,
  ).run(id, SUBSCRIBER, MERCHANT, nextCharge, chargesMade);
}

/** The whole mandate row: any column the keeper changed would show here. */
function mandateRow(db: Db, id: number): Record<string, unknown> {
  return { ...(db.prepare("SELECT * FROM mandates WHERE id = ?").get(id) as Record<string, unknown>) };
}

function attempts(db: Db): { mandate_id: number; result: string; error_code: string | null; retry_at: number | null }[] {
  return db
    .prepare("SELECT mandate_id, result, error_code, retry_at FROM charge_attempts ORDER BY id")
    .all() as unknown as { mandate_id: number; result: string; error_code: string | null; retry_at: number | null }[];
}

function claimOf(db: Db, id: number): { due_at: number; expires_at: number } | undefined {
  return db.prepare("SELECT due_at, expires_at FROM keeper_claims WHERE mandate_id = ?").get(id) as
    | { due_at: number; expires_at: number }
    | undefined;
}

/** The mandate ids a `charge` or `charge_many` transaction carries. */
function mandatesOf(tx: Transaction): number[] {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = (op.func as unknown as { invokeContract: { args: xdr.ScVal[] } }).invokeContract;
  const native: unknown = scValToNative(call.args[0]!);
  return Array.isArray(native) ? native.map(Number) : [Number(native)];
}

/** How a scripted submission ends. */
type Failure =
  | "onChainFailed"
  | "sendError"
  | "contractRefused"
  | "authRefused"
  | "badAuth"
  | "networkDown"
  | "neverConfirmed";

/**
 * A node that settles every mandate except the ones `failing` names, which
 * fail the way the scripted `Failure` says. `failing` is read on every call,
 * so a test can let a mandate recover.
 */
function scriptedNode(failing: Map<number, Failure>): KeeperRpc & { sends: number[][] } {
  const sends: number[][] = [];
  const fate = new Map<string, Failure | undefined>();
  const failureFor = (tx: Transaction): Failure | undefined =>
    mandatesOf(tx).map((id) => failing.get(id)).find((f) => f !== undefined);
  return {
    sends,
    getFeeStats: async () => ({ sorobanInclusionFee: { p90: "1000" } }) as never,
    getAccount: async (address: string) => new Account(address, "1") as never,
    prepareTransaction: async (tx) => {
      const failure = failureFor(tx as Transaction);
      if (failure === "contractRefused") throw new Error("HostError: Error(Contract, #3)");
      if (failure === "authRefused") throw new Error("HostError: Error(Auth, InvalidAction)");
      return tx as Transaction;
    },
    sendTransaction: async (tx) => {
      const transaction = tx as Transaction;
      sends.push(mandatesOf(transaction));
      const failure = failureFor(transaction);
      if (failure === "networkDown") throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
      if (failure === "sendError") return { status: "ERROR", errorResult: "tx rejected" } as never;
      if (failure === "badAuth") {
        return { status: "ERROR", errorResult: { result: { type: "txBadAuth" } } } as never;
      }
      const hash = Buffer.from(transaction.hash()).toString("hex");
      fate.set(hash, failure);
      return { status: "PENDING", hash } as never;
    },
    getTransaction: async (hash: string) => {
      const failure = fate.get(hash);
      if (failure === "onChainFailed") return { status: rpc.Api.GetTransactionStatus.FAILED } as never;
      if (failure === "neverConfirmed") return { status: rpc.Api.GetTransactionStatus.NOT_FOUND } as never;
      return { status: rpc.Api.GetTransactionStatus.SUCCESS } as never;
    },
  };
}

/** Collapse the confirmation poll's waits so a NOT_FOUND gives up at once. */
function instantTimers(t: TestContext): void {
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void) => {
    queueMicrotask(callback);
    return 0 as never;
  });
}

const cases: { failure: Failure; label: string; errorCode: string }[] = [
  { failure: "onChainFailed", label: "the transaction lands on chain as FAILED", errorCode: "FAILED" },
  { failure: "sendError", label: "the node rejects the submission", errorCode: "ERROR" },
  { failure: "contractRefused", label: "the contract refuses the charge in simulation", errorCode: "Error(Contract, #3)" },
  { failure: "authRefused", label: "authorization is refused in simulation", errorCode: "Error(Auth, InvalidAction)" },
  { failure: "badAuth", label: "the network refuses the keeper's signature (txBadAuth)", errorCode: "txBadAuth" },
  { failure: "networkDown", label: "the RPC cannot be reached", errorCode: "SUBMIT_FAILED" },
  { failure: "neverConfirmed", label: "the transaction is never confirmed (NOT_FOUND)", errorCode: "NOT_FOUND" },
];

describe("a failed transfer does not advance the mandate's due date (#256)", () => {
  for (const { failure, label, errorCode } of cases) {
    test(`when ${label}, the mandate stays due at the same next_charge`, async (t) => {
      if (failure === "neverConfirmed") instantTimers(t);
      const db = openDatabase(":memory:");
      insertDue(db, 1);
      const before = mandateRow(db, 1);
      const keeper = new Keeper(db, scriptedNode(new Map([[1, failure]])), config());

      const [result] = await keeper.tick(NOW);

      assert.equal(result?.status, "failed");
      assert.equal(result?.errorCode, errorCode);
      assert.deepEqual(mandateRow(db, 1), before, "the mandate row is untouched");
      const [attempt] = attempts(db);
      assert.equal(attempt?.result, "failed");
      assert.equal(attempt?.error_code, errorCode);
      assert.ok((attempt?.retry_at ?? 0) > NOW, "the failure schedules a retry instead of moving the due date");
      assert.deepEqual(
        (await keeper.findDue(attempt!.retry_at!)).map((row) => ({ ...row })),
        [{ id: 1, subscriber: SUBSCRIBER, merchant: MERCHANT, next_charge: DUE_AT, amount: "10", plan_id: 1 }],
        "once the backoff lapses, the same due charge is due again",
      );
      db.close();
    });
  }

  test("the failed charge is retried at its original due date, and only the indexer advances it", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1);
    const failing = new Map<number, Failure>([[1, "onChainFailed"]]);
    const node = scriptedNode(failing);
    const keeper = new Keeper(db, node, config());

    await keeper.tick(NOW);
    assert.deepEqual(await keeper.tick(NOW + 1), [], "it backs off rather than resubmitting at once");
    assert.equal(claimOf(db, 1)?.due_at, DUE_AT, "the claim still names the unadvanced due date");
    assert.equal(claimOf(db, 1)?.expires_at, NOW + BASE_S, "and holds it until the retry");

    // A second failure grows the backoff; the due date still does not move.
    const second = await keeper.tick(NOW + BASE_S);
    assert.equal(second[0]?.status, "failed");
    assert.equal(mandateRow(db, 1).next_charge, DUE_AT);
    assert.equal(mandateRow(db, 1).charges_made, 0);

    // The chain recovers: the retry settles the same period, and still the
    // keeper leaves next_charge for the indexer to advance from the event.
    failing.clear();
    const third = await keeper.tick(NOW + BASE_S + 2 * BASE_S);
    assert.equal(third[0]?.status, "settled");
    assert.deepEqual(node.sends, [[1], [1], [1]], "the same mandate was submitted each time");
    assert.equal(mandateRow(db, 1).next_charge, DUE_AT);
    assert.equal(mandateRow(db, 1).charges_made, 0);
    db.close();
  });

  test("a charge_many that fails on chain leaves the failing mandate due and unadvanced", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, DUE_AT);
    insertDue(db, 2, DUE_AT + 5, 3);
    insertDue(db, 3, DUE_AT + 9);
    const before = [1, 2, 3].map((id) => mandateRow(db, id));
    const node = scriptedNode(new Map([[1, "onChainFailed"]]));
    const keeper = new Keeper(db, node, config({ KEEPER_BATCH: true }));

    const results = await keeper.tick(NOW);

    assert.deepEqual(node.sends[0], [1, 2, 3], "the three were submitted together first");
    // The batch failed as a whole, so nothing was charged by it; the keeper
    // falls back to single charges and only the one that fails again fails.
    assert.deepEqual(node.sends.slice(1), [[1], [2], [3]]);
    assert.deepEqual(results.map((r) => [r.mandateId, r.status]), [[1, "failed"], [2, "settled"], [3, "settled"]]);
    assert.deepEqual([1, 2, 3].map((id) => mandateRow(db, id)), before, "the keeper advanced none of them");
    // The settled ones wait for the indexer to advance them (their claims
    // stop a second charge); the failed one is backing off instead…
    assert.deepEqual((await keeper.findDue(NOW + 1)).map((m) => m.id), [2, 3]);
    // …and is due again at its original date once the backoff lapses.
    assert.deepEqual(
      (await keeper.findDue(NOW + BASE_S)).map((m) => [m.id, m.next_charge]),
      [[1, DUE_AT], [2, DUE_AT + 5], [3, DUE_AT + 9]],
    );
    db.close();
  });

  test("one failure in a pass leaves its mandate due while the others settle", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, DUE_AT);
    insertDue(db, 2, DUE_AT + 1);
    const keeper = new Keeper(db, scriptedNode(new Map([[2, "onChainFailed"]])), config());

    const results = await keeper.tick(NOW);

    assert.deepEqual(results.map((r) => [r.mandateId, r.status]), [[1, "settled"], [2, "failed"]]);
    assert.equal(mandateRow(db, 2).next_charge, DUE_AT + 1);
    assert.equal(mandateRow(db, 2).status, "Active");
    assert.deepEqual((await keeper.findDue(NOW + 1)).map((m) => m.id), [1], "only the failed one is backing off");
    assert.deepEqual(
      (await keeper.findDue(NOW + BASE_S)).map((m) => [m.id, m.next_charge]),
      [[1, DUE_AT], [2, DUE_AT + 1]],
      "and it comes back at its original due date",
    );
    db.close();
  });

  test("a dry run that would fail neither advances the mandate nor delays it", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1);
    const before = mandateRow(db, 1);
    const node = scriptedNode(new Map([[1, "contractRefused"]]));
    const keeper = new Keeper(db, node, config({ KEEPER_DRY_RUN: true }));

    const [result] = await keeper.tick(NOW);

    assert.equal(result?.status, "simulated");
    assert.deepEqual(node.sends, [], "a dry run submits nothing");
    assert.deepEqual(mandateRow(db, 1), before);
    assert.deepEqual(attempts(db), [], "and records no attempt");
    assert.deepEqual((await keeper.findDue(NOW + 1)).map((m) => m.id), [1], "so it is still due right away");
    db.close();
  });
});
