import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { openDatabase } from "../src/lib/db.ts";
import { Reconciler, type ChainMandate } from "../src/reconcile.ts";
import type { IndexerStatus } from "../src/indexer.ts";
import type { rpc } from "@stellar/stellar-sdk";
import { nativeToScVal } from "@stellar/stellar-sdk";

// Keep test output quiet; behaviour, not log lines, is asserted below.
process.env.LOG_LEVEL = "silent";

const SUBSCRIPTION = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";

/** Field types the `get_mandate` view returns: decoded by `reconcile.ts`. */
const MANDATE_SPEC = {
  status: ["symbol", "string"] as const,
  charges_made: ["symbol", "u32"] as const,
  next_charge: ["symbol", "u64"] as const,
  amount: ["symbol", "i128"] as const,
};

function chainMandate(overrides: Partial<ChainMandate>): ChainMandate {
  return {
    id: 1,
    status: "Active",
    chargesMade: 0,
    nextCharge: 1_700_000_000,
    amount: "10_000_000",
    ...overrides,
  };
}

/** A read-only `get_mandate(id)` simulation answer. */
function simulate(mandate: ChainMandate): rpc.Api.SimulateTransactionResponse {
  return {
    result: {
      retval: nativeToScVal(
        {
          status: mandate.status,
          charges_made: mandate.chargesMade,
          next_charge: mandate.nextCharge,
          amount: BigInt(mandate.amount.replace(/_/g, "")),
        },
        { type: MANDATE_SPEC },
      ),
    } as never,
  } as never;
}

function failingSimulate(): rpc.Api.SimulateTransactionResponse {
  throw new Error("rpc unavailable");
}

function dbWithMandate(overrides: Partial<ChainMandate> & { status?: string } = {}) {
  const database = openDatabase(":memory:");
  const m = chainMandate(overrides);
  database
    .prepare(
      `INSERT INTO mandates
         (id, subscriber, merchant, plan_id, amount, period, next_charge, last_charge,
          charges_made, max_charges, fee_bps, status, ended_by, ledger)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, NULL, 100)`,
    )
    .run(
      m.id,
      SUBSCRIBER,
      MERCHANT,
      1,
      m.amount,
      2_592_000,
      m.nextCharge,
      m.chargesMade,
      m.status,
    );
  return { database, mandate: m };
}

function reconciler(
  database: ReturnType<typeof openDatabase>,
  simulateTransaction: ReturnType<typeof simulate> | typeof failingSimulate,
  sampleSize = 1,
) {
  const server = {
    simulateTransaction: async () => simulateTransaction,
  } as never;
  return new Reconciler(database, server, SUBSCRIPTION, "Test SDF Network ; September 2015", sampleSize);
}

function mandateRow(database: ReturnType<typeof openDatabase>, id: number) {
  return database
    .prepare(
      "SELECT status, charges_made, next_charge FROM mandates WHERE id = ?",
    )
    .get(id) as { status: string; charges_made: number; next_charge: number } | undefined;
}

describe("reconcile", () => {
  test("invalidates the merchant's cached summary when it corrects a mandate", async () => {
    const invalidated: string[] = [];
    const { database } = dbWithMandate({ status: "Active" });
    const server = {
      simulateTransaction: async () => simulate(chainMandate({ status: "Cancelled" })),
    } as never;
    const rx = new Reconciler(
      database,
      server,
      SUBSCRIPTION,
      "Test SDF Network ; September 2015",
      1,
      (merchant) => invalidated.push(merchant),
    );

    const result = await rx.tick();

    assert.equal(result.corrections, 1);
    assert.deepEqual(invalidated, [MERCHANT]);
  });

  test("corrects a status the chain disagrees with", async () => {
    const { database } = dbWithMandate({ status: "Active" });
    const rx = reconciler(database, simulate(chainMandate({ status: "Cancelled" })));

    const result = await rx.tick();

    assert.equal(result.corrections, 1);
    assert.equal(result.drift.length, 1);
    assert.equal(result.drift[0]!.field, "status");
    assert.equal(result.drift[0]!.projection, "Active");
    assert.equal(result.drift[0]!.chain, "Cancelled");
    assert.equal(mandateRow(database, 1)!.status, "Cancelled");
  });

  test("corrects charges_made drift", async () => {
    const { database } = dbWithMandate({ chargesMade: 0 });
    const rx = reconciler(database, simulate(chainMandate({ chargesMade: 3 })));

    const result = await rx.tick();

    assert.equal(result.corrections, 1);
    assert.equal(mandateRow(database, 1)!.charges_made, 3);
  });

  test("corrects next_charge drift", async () => {
    const { database } = dbWithMandate({ nextCharge: 1_700_000_000 });
    const rx = reconciler(database, simulate(chainMandate({ nextCharge: 1_700_060_000 })));

    const result = await rx.tick();

    assert.equal(result.corrections, 1);
    assert.equal(mandateRow(database, 1)!.next_charge, 1_700_060_000);
  });

  test("corrects every divergent field on one mandate", async () => {
    const { database } = dbWithMandate({
      status: "Active",
      chargesMade: 0,
      nextCharge: 1_700_000_000,
    });
    const rx = reconciler(
      database,
      simulate(chainMandate({ status: "Completed", chargesMade: 2, nextCharge: 1_700_120_000 })),
    );

    const result = await rx.tick();

    assert.equal(result.corrections, 3);
    const row = mandateRow(database, 1)!;
    assert.equal(row.status, "Completed");
    assert.equal(row.charges_made, 2);
    assert.equal(row.next_charge, 1_700_120_000);
  });

  test("leaves a matching mandate alone", async () => {
    const { database } = dbWithMandate({ status: "Active", chargesMade: 1, nextCharge: 1_700_060_000 });
    const rx = reconciler(database, simulate(chainMandate({ status: "Active", chargesMade: 1, nextCharge: 1_700_060_000 })));

    const result = await rx.tick();

    assert.equal(result.sampled, 1);
    assert.equal(result.onChain, 1);
    assert.equal(result.corrections, 0);
    assert.equal(result.errors, 0);
    assert.equal(result.drift.length, 0);
  });

  test("replaying a clean pass corrects nothing", async () => {
    const { database } = dbWithMandate({ status: "Active" });
    const rx = reconciler(database, simulate(chainMandate({ status: "Cancelled" })));

    await rx.tick();
    assert.equal(mandateRow(database, 1)!.status, "Cancelled");

    const second = await rx.tick();
    assert.equal(second.corrections, 0, "a second pass over matching state is a no-op");
    assert.equal(mandateRow(database, 1)!.status, "Cancelled");
  });

  test("samples only the configured number of active mandates", async () => {
    const database = openDatabase(":memory:");
    for (let id = 1; id <= 50; id += 1) {
      database
        .prepare(
          `INSERT INTO mandates
            (id, subscriber, merchant, plan_id, amount, period, next_charge, last_charge,
             charges_made, max_charges, fee_bps, status, ended_by, ledger)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'Active', NULL, 100)`,
        )
        .run(id, SUBSCRIBER, MERCHANT, 1, "10000000", 2_592_000, 1_700_000_000 + id);
    }
    let reads = 0;
    const server = {
      simulateTransaction: async () => {
        reads += 1;
        return simulate(chainMandate({ id: reads }));
      },
    } as never;
    const rx = new Reconciler(
      database,
      server,
      SUBSCRIPTION,
      "Test SDF Network ; September 2015",
      5,
    );

    const result = await rx.tick();

    assert.equal(result.sampled, 5);
    assert.equal(result.onChain, 5);
    assert.equal(reads, 5, "exactly one chain read per sampled mandate");
  });

  test("does not sample non-active mandates", async () => {
    const database = openDatabase(":memory:");
    database
      .prepare(
        `INSERT INTO mandates
          (id, subscriber, merchant, plan_id, amount, period, next_charge, last_charge,
           charges_made, max_charges, fee_bps, status, ended_by, ledger)
         VALUES (1, ?, ?, 1, '10000000', 2_592_000, 1_700_000_000, 0, 0, 0, 0, 'Cancelled', NULL, 100),
                (2, ?, ?, 1, '10000000', 2_592_000, 1_700_000_000, 0, 0, 0, 0, 'Completed', NULL, 100),
                (3, ?, ?, 1, '10000000', 2_592_000, 1_700_000_000, 0, 0, 0, 0, 'Active', NULL, 100)`,
      )
      .run(SUBSCRIBER, MERCHANT, SUBSCRIBER, MERCHANT, SUBSCRIBER, MERCHANT);
    let reads = 0;
    const server = {
      simulateTransaction: async () => {
        reads += 1;
        return simulate(chainMandate({ id: reads }));
      },
    } as never;
    const rx = new Reconciler(database, server, SUBSCRIPTION, "Test SDF Network ; September 2015", 10);

    const result = await rx.tick();

    assert.equal(result.sampled, 1, "only the active mandate is sampled");
    assert.equal(reads, 1);
  });

  test("a transient chain failure is counted, logged and retried next pass", async () => {
    const { database } = dbWithMandate({ status: "Active" });
    let calls = 0;
    const server = {
      simulateTransaction: async () => {
        calls += 1;
        if (calls === 1) throw new Error("rpc unavailable");
        return simulate(chainMandate({ status: "Cancelled" }));
      },
    } as never;
    const rx = new Reconciler(
      database,
      server,
      SUBSCRIPTION,
      "Test SDF Network ; September 2015",
      1,
    );

    const first = await rx.tick();
    assert.equal(first.errors, 1);
    assert.equal(first.lastError, "rpc unavailable");
    assert.equal(first.corrections, 0);
    assert.equal(mandateRow(database, 1)!.status, "Active", "nothing was fixed while the chain was unreadable");

    const second = await rx.tick();
    assert.equal(second.errors, 0);
    assert.equal(second.lastError, null);
    assert.equal(second.corrections, 1);
    assert.equal(mandateRow(database, 1)!.status, "Cancelled");
  });

  test("a mandate the chain does not know is skipped, not corrected", async () => {
    const { database } = dbWithMandate({ status: "Active" });
    const rx = reconciler(database, failingSimulate);

    const result = await rx.tick();

    assert.equal(result.errors, 1);
    assert.equal(result.corrections, 0);
    assert.equal(result.onChain, 0);
    assert.equal(mandateRow(database, 1)!.status, "Active");
  });

  test("amounts are compared as strings, never as JavaScript numbers", async () => {
    const { database } = dbWithMandate({ amount: "10_000_000" });
    // The chain reports the same amount as a bigint i128; the reconciler must
    // not treat a bigint as a float and must not correct amounts at all.
    const rx = reconciler(
      database,
      simulate(chainMandate({ id: 1, amount: "10000000" })),
    );

    const result = await rx.tick();

    assert.equal(result.corrections, 0, "amount differences are out of scope: amount is immutable after subscribe");
    const row = mandateRow(database, 1)!;
    assert.equal(row.status, "Active");
    assert.equal(typeof row.next_charge, "number");
    assert.equal(typeof row.charges_made, "number");
  });
});

describe("reconcile status shape", () => {
  test("exposes per-pass counters the indexer can report on /health", async () => {
    const { database } = dbWithMandate({ status: "Active" });
    const rx = reconciler(database, simulate(chainMandate({ status: "Cancelled" })));

    const result = await rx.tick();

    assert.equal(result.sampled, 1);
    assert.equal(result.onChain, 1);
    assert.equal(result.corrections, 1);
    assert.equal(result.errors, 0);

    // The status fields a pass contributes mirror IndexerStatus counters.
    const status: Pick<IndexerStatus, "reconciliations" | "corrections"> = {
      reconciliations: 1,
      corrections: result.corrections,
    };
    assert.equal(status.reconciliations, 1);
    assert.equal(status.corrections, 1);
  });
});
