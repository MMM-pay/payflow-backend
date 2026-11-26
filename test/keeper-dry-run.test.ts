import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  Account,
  Keypair,
  Transaction,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { Keeper, type KeeperRpc } from "../src/keeper.ts";
import type { Config } from "../src/config.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const key = Keypair.random();

function config(): Config {
  return {
    PLAN_REGISTRY_ID: CONTRACT,
    VAULT_ID: CONTRACT,
    SUBSCRIPTION_ID: CONTRACT,
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    KEEPER_SECRET: key.secret(),
    KEEPER_FEE_PERCENTILE: "90",
    KEEPER_MAX_FEE: "100000",
    KEEPER_BATCH: false,
    KEEPER_BATCH_SIZE: 10,
    KEEPER_BACKOFF_JITTER: 0,
  } as unknown as Config;
}

function seed(db: ReturnType<typeof openDatabase>, amount = "1000"): void {
  db.prepare(
    `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
     VALUES (1, ?, 'p', ?, '1000', 60, 1, 1)`,
  ).run(MERCHANT, TOKEN);
  db.prepare(
    `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
     VALUES (1, ?, ?, 1, ?, 60, 1000, 'Active', 1)`,
  ).run(SUBSCRIBER, MERCHANT, amount);
}

/** The function a simulated transaction invokes (`balance` or `charge`). */
function functionName(tx: Transaction): string {
  const { func } = tx.operations[0] as unknown as {
    func: { invokeContract: { functionName: unknown } };
  };
  const decoded = scValToNative(func.invokeContract.functionName as never);
  return typeof decoded === "string" ? decoded : String(func.invokeContract.functionName);
}

/**
 * A node whose vault view answers `balance` (or fails when null) and whose
 * `charge` simulation answers `charge` (or fails with it). Every simulated
 * function is recorded so a test can see what the keeper asked.
 */
function simulationRpc(options: {
  balance: bigint | null;
  charge?: string | null;
  submitted?: string[];
  simulated?: string[];
}): KeeperRpc {
  const submitted = options.submitted ?? [];
  const simulated = options.simulated ?? [];
  return {
    getFeeStats: async () => ({ sorobanInclusionFee: { p90: "1000" } }) as never,
    getAccount: async (address: string) => new Account(address, "1") as never,
    prepareTransaction: async (tx: Transaction) => tx as Transaction,
    sendTransaction: async (tx: Transaction) => {
      submitted.push(Buffer.from((tx as Transaction).hash()).toString("hex"));
      return { status: "PENDING", hash: "hash" } as never;
    },
    getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }) as never,
    simulateTransaction: async (tx: Transaction) => {
      const name = functionName(tx);
      simulated.push(name);
      if (name === "balance") {
        if (options.balance === null) throw new Error("rpc unavailable");
        return { result: { retval: nativeToScVal(options.balance, { type: "i128" }) } } as never;
      }
      if (options.charge) return { error: options.charge } as never;
      return { result: { retval: nativeToScVal(true, { type: "bool" }) } } as never;
    },
  } as unknown as KeeperRpc;
}

describe("keeper dry-run report (#250)", () => {
  test("lists the due mandates and intended charges without submitting or recording", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const submitted: string[] = [];
    const keeper = new Keeper(
      db,
      simulationRpc({ balance: 5_000n, submitted }),
      config(),
    );

    const report = await keeper.dryRun(10_000);

    assert.equal(report.now, 10_000);
    assert.deepEqual(report.due, [
      {
        mandateId: 1,
        subscriber: SUBSCRIBER,
        merchant: MERCHANT,
        planId: 1,
        amount: "1000",
        nextCharge: 1_000,
        balance: "5000",
        shortfall: null,
        outcome: "ready",
      },
    ]);
    assert.equal(report.chargeable, 1);
    assert.equal(report.skipped, 0);
    assert.deepEqual(submitted, [], "a dry run never submits");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM charge_attempts").get() as { n: number }).n,
      0,
      "a dry run records no attempt",
    );
    assert.equal(keeper.passHistory().length, 0, "a dry run records no pass");
    db.close();
  });

  test("reports a vault that cannot cover the charge, with the shortfall", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const simulated: string[] = [];
    const keeper = new Keeper(
      db,
      simulationRpc({ balance: 400n, simulated }),
      config(),
    );

    const report = await keeper.dryRun(10_000);

    assert.deepEqual(report.due.map((row) => [row.outcome, row.balance, row.shortfall]), [
      ["insufficient_balance", "400", "600"],
    ]);
    assert.equal(report.chargeable, 0);
    assert.equal(report.skipped, 1);
    assert.deepEqual(simulated, ["balance"], "a known-short mandate is not simulated again");
    db.close();
  });

  test("reports a charge the simulation refuses as would_fail", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const keeper = new Keeper(
      db,
      simulationRpc({ balance: 1_000n, charge: "HostError: Error(Contract, #3004)" }),
      config(),
    );

    const report = await keeper.dryRun(10_000);

    const row = report.due[0]!;
    assert.equal(row.outcome, "would_fail");
    assert.match(row.error ?? "", /3004/);
    assert.equal(report.chargeable, 1, "the pass would try it for real");
    db.close();
  });

  test("says unverified when the RPC cannot simulate", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const node = {
      getFeeStats: async () => ({ sorobanInclusionFee: { p90: "1000" } }) as never,
    } as unknown as KeeperRpc;
    const keeper = new Keeper(db, node, config());

    const report = await keeper.dryRun(10_000);

    assert.equal(report.due[0]?.outcome, "unverified");
    assert.equal(report.due[0]?.balance, null);
    db.close();
  });
});

describe("keeper simulation short skips (#251)", () => {
  test("skips a mandate the charge simulation proves short, before submitting", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const submitted: string[] = [];
    const simulated: string[] = [];
    const keeper = new Keeper(
      db,
      // The vault view cannot answer, so the charge simulation decides.
      simulationRpc({
        balance: null,
        charge: "HostError: Error(Contract, #3009)",
        submitted,
        simulated,
      }),
      config(),
    );

    const results = await keeper.tick(10_000);

    assert.deepEqual(results, [], "nothing was submitted");
    assert.deepEqual(submitted, []);
    assert.deepEqual(simulated.sort(), ["balance", "charge"]);
    assert.deepEqual(keeper.passHistory()[0]?.skipped, [
      {
        mandateId: 1,
        required: "1000",
        reason: "simulation",
        error: "HostError: Error(Contract, #3009)",
      },
    ]);
    const attempt = db
      .prepare("SELECT result, error_code, shortfall FROM charge_attempts")
      .get() as { result: string; error_code: string; shortfall: string | null };
    // node:sqlite returns null-prototype rows; spread them for a strict compare.
    assert.deepEqual(
      { ...attempt },
      {
        result: "skipped",
        error_code: "SIMULATION_SHORTFALL",
        shortfall: null,
      },
    );
    assert.ok((keeper.retryIn(1, 10_000) ?? 0) > 0, "the skipped mandate backs off");
    db.close();
  });

  test("a refusal that is not the vault's leaves the charge to decide", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const submitted: string[] = [];
    const keeper = new Keeper(
      db,
      simulationRpc({
        balance: null,
        charge: "HostError: Error(Contract, #2005)",
        submitted,
      }),
      config(),
    );

    const results = await keeper.tick(10_000);

    assert.deepEqual(results.map((result) => result.status), ["settled"]);
    assert.equal(submitted.length, 1, "an unrelated refusal is not a shortfall skip");
    db.close();
  });
});
