import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { openDatabase } from "../src/lib/db.ts";
import { asStorage } from "../src/lib/store/index.ts";
import { Indexer } from "../src/indexer.ts";
import { getPlanStats } from "../src/lib/queries.ts";
import { plansRouter } from "../src/routes/plans.ts";
import { merchantsRouter, MerchantSummaryCache } from "../src/routes/merchants.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import type { TokenMetadataService } from "../src/lib/tokens.ts";
import type { MerchantSubscribersResponse, PlanStatsResponse } from "../src/routes/types.ts";

/**
 * Lifetime value per plan and per subscriber (#143), against a fixture whose
 * answers are worked out by hand below. A charge's `amount` is the merchant's
 * share (the protocol fee is separate), so lifetime value net of fee is the
 * sum of a subscriber's charge amounts.
 */

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUB_A = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const SUB_B = "GD2P7AV53TONBPXKX5NWQKGUTAF32VZWKMFHQ2QZ5XNTTQFTV7Q4USP";
const SUB_C = "GDLXOW3J5FEFW4UZ7XBHX6EFHL7POV7S2NG5RZ7ULYCGLJWGPUBFQO4U";
const SUB_D = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
/** 2^53 + 1: a JavaScript number cannot hold it. */
const BEYOND_FLOAT = 9_007_199_254_740_993n;

let tx = 0;
const ev = (name: string, topics: unknown[], data: Record<string, unknown>): DecodedEvent => ({
  name,
  contractId: "C",
  ledger: 10,
  txHash: `tx-${(tx += 1)}`,
  closeTime: 1_700_000_000,
  topics,
  data,
});

const plan = (id: bigint): DecodedEvent =>
  ev("plan_created", [MERCHANT, id], { token: TOKEN, amount: 10_000_000n, period: 2_592_000n, name: `Plan ${id}` });

const subscribe = (mandate: bigint, subscriber: string, planId: bigint): DecodedEvent =>
  ev("subscribed", [mandate, subscriber, MERCHANT], {
    plan_id: planId,
    amount: 10_000_000n,
    period: 2_592_000n,
    next_charge: 1_700_000_000n,
    max_charges: 0n,
    fee_bps: 100n,
  });

const charge = (mandate: bigint, subscriber: string, amount: bigint, made: bigint): DecodedEvent =>
  ev("charged", [mandate, subscriber, MERCHANT], {
    amount,
    fee: 100_000n,
    charges_made: made,
    next_charge: 1_700_000_000n + made * 2_592_000n,
  });

/**
 * Plan 1, three subscribers (odd count):
 *   SUB_A  mandate 1: 9_900_000 + 9_900_000, mandate 4: 9_900_000  → 29_700_000
 *   SUB_B  mandate 2: 9_900_000                                    →  9_900_000
 *   SUB_C  mandate 3: never charged                                →          0
 *   average = 39_600_000 / 3 = 13_200_000; median = 9_900_000
 *
 * Plan 2, two subscribers (even count, both rounded down):
 *   SUB_A  mandate 5: 4_950_001                                    →  4_950_001
 *   SUB_D  mandate 6: 10                                           →         10
 *   average = median = 4_950_011 / 2 = 2_475_005.5 → 2_475_005
 *
 * Plan 3: no mandates → "0" and "0".
 * Plan 4: one subscriber paying 2^53 + 1 → that exact value, not a float.
 *
 * Per subscriber across the merchant: SUB_A 34_650_001, SUB_B 9_900_000,
 * SUB_C 0, SUB_D 10 + 2^53 + 1.
 */
const FIXTURE: DecodedEvent[] = [
  plan(1n),
  plan(2n),
  plan(3n),
  plan(4n),
  subscribe(1n, SUB_A, 1n),
  subscribe(2n, SUB_B, 1n),
  subscribe(3n, SUB_C, 1n),
  subscribe(4n, SUB_A, 1n),
  subscribe(5n, SUB_A, 2n),
  subscribe(6n, SUB_D, 2n),
  subscribe(7n, SUB_D, 4n),
  charge(1n, SUB_A, 9_900_000n, 1n),
  charge(1n, SUB_A, 9_900_000n, 2n),
  charge(4n, SUB_A, 9_900_000n, 1n),
  charge(2n, SUB_B, 9_900_000n, 1n),
  charge(5n, SUB_A, 4_950_001n, 1n),
  charge(6n, SUB_D, 10n, 1n),
  charge(7n, SUB_D, BEYOND_FLOAT, 1n),
];

describe("lifetime value", () => {
  const db = openDatabase(":memory:");
  const store = asStorage(db);
  let server: Server;
  let base = "";

  before(async () => {
    const indexer = new Indexer(db, {} as never, {} as never);
    for (const event of FIXTURE) assert.equal(await indexer.apply(event), "applied");

    const app = express();
    app.use("/api", plansRouter(store, {} as TokenMetadataService));
    app.use("/api", merchantsRouter(store, new MerchantSummaryCache()));
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  test("a plan's average and median match the hand calculation", async () => {
    const odd = await getPlanStats(store, 1);
    assert.equal(odd.averageLtv, 13_200_000n);
    assert.equal(odd.medianLtv, 9_900_000n);

    const even = await getPlanStats(store, 2);
    assert.equal(even.averageLtv, 2_475_005n, "the mean is rounded down");
    assert.equal(even.medianLtv, 2_475_005n, "the mean of the middle two is rounded down");

    const empty = await getPlanStats(store, 3);
    assert.equal(empty.averageLtv, 0n);
    assert.equal(empty.medianLtv, 0n);

    const large = await getPlanStats(store, 4);
    assert.equal(large.averageLtv, BEYOND_FLOAT);
    assert.equal(large.medianLtv, BEYOND_FLOAT);
  });

  test("/plans/:id/stats serves them as decimal strings", async () => {
    const body = (await (await fetch(`${base}/api/plans/1/stats`)).json()) as PlanStatsResponse;
    assert.equal(body.averageLtv, "13200000");
    assert.equal(body.medianLtv, "9900000");

    const large = (await (await fetch(`${base}/api/plans/4/stats`)).json()) as PlanStatsResponse;
    assert.equal(large.averageLtv, "9007199254740993");
    assert.equal(large.medianLtv, "9007199254740993");
  });

  test("/merchants/:address/subscribers carries each subscriber's ltv", async () => {
    const body = (await (
      await fetch(`${base}/api/merchants/${MERCHANT}/subscribers`)
    ).json()) as MerchantSubscribersResponse;
    // Highest lifetime value first, as the route has always ordered them.
    assert.deepEqual(
      body.subscribers.map((s) => [s.subscriber, s.ltv]),
      [
        [SUB_D, "9007199254741003"],
        [SUB_A, "34650001"],
        [SUB_B, "9900000"],
        [SUB_C, "0"],
      ],
    );
  });

  test("replaying the charges leaves every lifetime value unchanged", async () => {
    const before = await getPlanStats(store, 1);
    const indexer = new Indexer(db, {} as never, {} as never);
    for (const event of FIXTURE) await indexer.apply(event);
    assert.deepEqual(await getPlanStats(store, 1), before);
  });
});
