import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { Indexer } from "../src/indexer.ts";
import { openDatabase, writeCursor } from "../src/lib/db.ts";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import {
  getMandateById,
  getMerchantSummary,
  getPlanById,
  getProtocolStats,
  getSubscriberSummary,
  listDueMandates,
  listMandateCharges,
  listMandates,
  listMerchantForecastMandates,
  listMerchantTokenRevenue,
  listPlans,
  listSubscriberUpcomingMandates,
} from "../src/lib/queries.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";

const MERCHANT_A = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const MERCHANT_B = "GDLXOW3J5FEFW4UZ7XBHX6EFHL7POV7S2NG5RZ7ULYCGLJWGPUBFQO4U";
const SUB_A = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const SUB_B = "GD2P7AV53TONBPXKX5NWQKGUTAF32VZWKMFHQ2QZ5XNTTQFTV7Q4USP";
const TOKEN_X = "CTOKEN_X";
const TOKEN_Y = "CTOKEN_Y";

const ev = (
  name: string,
  topics: unknown[],
  data: Record<string, unknown>,
  tx = "tx",
  ledger = 10,
): DecodedEvent => ({
  name,
  contractId: "C",
  ledger,
  txHash: tx,
  topics,
  data,
});

describe("direct database queries", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteStorage(db);
  const ix = new Indexer(db, {} as never, {} as never);
  const now = 1_700_000_000;

  before(async () => {
    await ix.apply(
      ev(
        "plan_created",
        [MERCHANT_A, 1n],
        { token: TOKEN_X, amount: 10_000_000n, period: 2_592_000n, name: "Starter" },
        "tx-plan-1",
        10,
      ),
    );
    await ix.apply(
      ev(
        "plan_created",
        [MERCHANT_A, 2n],
        { token: TOKEN_Y, amount: 5_000_000n, period: 2_592_000n, name: "Pro" },
        "tx-plan-2",
        11,
      ),
    );
    await ix.apply(
      ev(
        "plan_created",
        [MERCHANT_B, 3n],
        { token: TOKEN_X, amount: 120_000_000n, period: 31_536_000n, name: "Annual" },
        "tx-plan-3",
        12,
      ),
    );

    // Mandate 1: Active, due at now - 60, open-ended
    await ix.apply(
      ev(
        "subscribed",
        [1n, SUB_A, MERCHANT_A],
        {
          plan_id: 1n,
          amount: 10_000_000n,
          period: 2_592_000n,
          next_charge: BigInt(now - 60),
          max_charges: 0n,
          fee_bps: 100n,
        },
        "tx-sub-1",
        20,
      ),
    );

    // Mandate 2: Active, due in the future (now + 3600), capped at 3 charges
    await ix.apply(
      ev(
        "subscribed",
        [2n, SUB_A, MERCHANT_A],
        {
          plan_id: 2n,
          amount: 5_000_000n,
          period: 2_592_000n,
          next_charge: BigInt(now + 3_600),
          max_charges: 3n,
          fee_bps: 50n,
        },
        "tx-sub-2",
        21,
      ),
    );

    // Mandate 3: Cancelled mandate on MERCHANT_B
    await ix.apply(
      ev(
        "subscribed",
        [3n, SUB_B, MERCHANT_B],
        {
          plan_id: 3n,
          amount: 120_000_000n,
          period: 31_536_000n,
          next_charge: BigInt(now - 10),
        },
        "tx-sub-3",
        22,
      ),
    );
    await ix.apply(ev("cancelled", [3n, SUB_B], { charges_made: 0 }, "tx-cancel-3", 23));

    // Mandate 4: Active but exhausted max_charges (charges_made == max_charges)
    await ix.apply(
      ev(
        "subscribed",
        [4n, SUB_B, MERCHANT_A],
        {
          plan_id: 1n,
          amount: 10_000_000n,
          period: 2_592_000n,
          next_charge: BigInt(now - 120),
          max_charges: 1n,
        },
        "tx-sub-4",
        24,
      ),
    );
    await ix.apply(
      ev(
        "charged",
        [4n, SUB_B, MERCHANT_A],
        {
          amount: 9_900_000n,
          fee: 100_000n,
          charges_made: 1n,
          next_charge: BigInt(now - 30),
        },
        "tx-charge-old",
        25,
      ),
    );
    db.prepare("UPDATE charges SET created_at = ? WHERE tx_hash = ?").run(
      1_000,
      "tx-charge-old",
    );

    // Two charges on Mandate 1 at different ledgers
    await ix.apply(
      ev(
        "charged",
        [1n, SUB_A, MERCHANT_A],
        {
          amount: 9_900_000n,
          fee: 100_000n,
          charges_made: 1n,
          next_charge: BigInt(now - 60),
        },
        "tx-charge-1a",
        30,
      ),
    );
    db.prepare("UPDATE charges SET created_at = ? WHERE tx_hash = ?").run(
      5_000,
      "tx-charge-1a",
    );

    await ix.apply(
      ev(
        "charged",
        [1n, SUB_A, MERCHANT_A],
        {
          amount: 9_900_000n,
          fee: 100_000n,
          charges_made: 2n,
          next_charge: BigInt(now - 60),
        },
        "tx-charge-1b",
        40,
      ),
    );
    db.prepare("UPDATE charges SET created_at = ? WHERE tx_hash = ?").run(
      9_000,
      "tx-charge-1b",
    );

    writeCursor(db, 42);
  });

  after(() => {
    db.close();
  });

  test("listPlans orders by id DESC, filters by merchant, and respects limit", async () => {
    const all = await listPlans(store, { limit: 50 });
    assert.deepEqual(
      all.map((p) => p.id),
      [3, 2, 1],
    );

    const limited = await listPlans(store, { limit: 2 });
    assert.deepEqual(
      limited.map((p) => p.id),
      [3, 2],
    );

    const merchantA = await listPlans(store, { merchant: MERCHANT_A, limit: 50 });
    assert.deepEqual(
      merchantA.map((p) => p.id),
      [2, 1],
    );

    const unknown = await listPlans(store, { merchant: "GNOBODY", limit: 50 });
    assert.deepEqual(unknown, []);
  });

  test("getPlanById returns a plan row or undefined when absent", async () => {
    const plan = await getPlanById(store, 1);
    assert.ok(plan);
    assert.equal(plan.merchant, MERCHANT_A);
    assert.equal(plan.name, "Starter");
    assert.equal(plan.amount, "10000000");

    assert.equal(await getPlanById(store, 999), undefined);
  });

  test("listMandates filters by ids, subscriber, merchant, status, and limit", async () => {
    const all = await listMandates(store, { limit: 50 });
    assert.deepEqual(
      all.map((m) => m.id),
      [4, 3, 2, 1],
    );

    const byIds = await listMandates(store, { ids: [1, 3, 999], limit: 50 });
    assert.deepEqual(
      byIds.map((m) => m.id),
      [3, 1],
    );

    assert.deepEqual(await listMandates(store, { ids: [], limit: 50 }), []);

    const bySub = await listMandates(store, { subscriber: SUB_A, limit: 50 });
    assert.deepEqual(
      bySub.map((m) => m.id),
      [2, 1],
    );

    const byMerchantAndStatus = await listMandates(store, {
      merchant: MERCHANT_B,
      status: "Cancelled",
      limit: 50,
    });
    assert.deepEqual(
      byMerchantAndStatus.map((m) => m.id),
      [3],
    );
  });

  test("getMandateById returns a mandate row or undefined when absent", async () => {
    const mandate = await getMandateById(store, 2);
    assert.ok(mandate);
    assert.equal(mandate.subscriber, SUB_A);
    assert.equal(mandate.fee_bps, 50);

    assert.equal(await getMandateById(store, 999), undefined);
  });

  test("listMandateCharges returns charges ordered by ledger DESC with limit", async () => {
    const charges = await listMandateCharges(store, 1, 50);
    assert.deepEqual(
      charges.map((c) => c.tx_hash),
      ["tx-charge-1b", "tx-charge-1a"],
    );

    const single = await listMandateCharges(store, 1, 1);
    assert.equal(single.length, 1);
    assert.equal(single[0]?.tx_hash, "tx-charge-1b");

    assert.deepEqual(await listMandateCharges(store, 999, 50), []);
  });

  test("listDueMandates includes only active unexhausted mandates with next_charge <= now", async () => {
    // Mandate 1 is active and due (now - 60); Mandate 2 is future; Mandate 3 is cancelled;
    // Mandate 4 has charges_made (1) == max_charges (1) so it is excluded.
    const due = await listDueMandates(store, now, 50);
    assert.deepEqual(
      due.map((d) => d.id),
      [1],
    );
  });

  test("listMerchantTokenRevenue and getMerchantSummary compute per-token and scoped totals", async () => {
    const tokens = await listMerchantTokenRevenue(store, MERCHANT_A);
    assert.deepEqual(tokens, [
      // Mandate 1 (10M) + Mandate 4 (10M) both active on plan 1 (TOKEN_X), 3 charges of 9.9M each
      { token: TOKEN_X, totalCollected: "29700000", mrr: "20000000" },
      // Mandate 2 (5M) active on plan 2 (TOKEN_Y), 0 charges
      { token: TOKEN_Y, totalCollected: "0", mrr: "5000000" },
    ]);

    const unscoped = await getMerchantSummary(store, MERCHANT_A);
    assert.equal(unscoped.activeMandates, 3);
    assert.equal(unscoped.chargeCount, 3);
    assert.equal(unscoped.totalCollected, "29700000");
    assert.equal(unscoped.mrr, "25000000");

    const scopedY = await getMerchantSummary(store, MERCHANT_A, TOKEN_Y);
    assert.equal(scopedY.totalCollected, "0");
    assert.equal(scopedY.mrr, "5000000");
    assert.equal(scopedY.chargeCount, 3);

    const empty = await getMerchantSummary(store, "GNOBODY");
    assert.equal(empty.activeMandates, 0);
    assert.equal(empty.totalCollected, "0");
    assert.equal(empty.mrr, "0");
    assert.equal(empty.arr, "0");
    assert.deepEqual(empty.tokens, []);
  });

  test("listMerchantForecastMandates returns active positive-period mandates for a merchant", async () => {
    const rows = await listMerchantForecastMandates(store, MERCHANT_A);
    assert.equal(rows.length, 3);
    assert.deepEqual(await listMerchantForecastMandates(store, MERCHANT_B), []);
  });

  test("getSubscriberSummary and listSubscriberUpcomingMandates return subscriber state", async () => {
    const summaryA = await getSubscriberSummary(store, SUB_A);
    assert.equal(summaryA.subscriber, SUB_A);
    assert.deepEqual(
      summaryA.mandates.map((m) => m.id),
      [2, 1],
    );
    // Two charges of (9_900_000 + 100_000) each = 20_000_000
    assert.equal(summaryA.totalPaid, "20000000");

    const upcomingA = await listSubscriberUpcomingMandates(store, SUB_A);
    assert.deepEqual(
      upcomingA.map((m) => m.id).sort((a, b) => a - b),
      [1, 2],
    );
  });

  test("getProtocolStats aggregates counts, 24h/all-time gross volume, fees, and cursor", async () => {
    const stats = await getProtocolStats(store, 4_000);
    assert.equal(stats.plans, 3);
    assert.equal(stats.mandates, 4);
    assert.equal(stats.activeMandates, 3);
    assert.equal(stats.charges, 3);
    // Only charges with created_at >= 4_000 (tx-charge-1a and tx-charge-1b): 2 * 10_000_000
    assert.equal(stats.volume24h, "20000000");
    // All 3 charges: 3 * 10_000_000
    assert.equal(stats.volumeAllTime, "30000000");
    assert.equal(stats.totalFees, "300000");
    assert.equal(stats.activeMerchants, 1);
    assert.equal(stats.lastIndexedLedger, 42);
  });

  test("route handlers in src/routes do not build SQL inline with db.prepare", async () => {
    const routesDir = fileURLToPath(new URL("../src/routes", import.meta.url));
    for (const entry of readdirSync(routesDir)) {
      if (!entry.endsWith(".ts")) continue;
      const source = readFileSync(join(routesDir, entry), "utf8");
      assert.doesNotMatch(
        source,
        /\.prepare\s*\(/,
        `Expected ${entry} to delegate SQL queries to src/lib/queries.ts instead of calling .prepare()`,
      );
    }
  });
});
