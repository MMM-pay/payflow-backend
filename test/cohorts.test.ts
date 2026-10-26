import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { openDatabase } from "../src/lib/db.ts";
import { asStorage } from "../src/lib/store/index.ts";
import { Indexer } from "../src/indexer.ts";
import { getMerchantCohorts } from "../src/lib/queries.ts";
import { merchantsRouter, MerchantSummaryCache } from "../src/routes/merchants.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import type { MerchantCohortsResponse } from "../src/routes/types.ts";

/**
 * Merchant cohort retention (#142) against a fixture with known answers.
 * Every instant is a ledger close time, so the cohorts are the chain's own
 * history, whenever the events were indexed.
 */

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const OTHER_MERCHANT = "GDLXOW3J5FEFW4UZ7XBHX6EFHL7POV7S2NG5RZ7ULYCGLJWGPUBFQO4U";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";

/** Unix seconds of a UTC instant. */
const at = (iso: string): number => Date.parse(iso) / 1000;

const ev = (
  name: string,
  topics: unknown[],
  closeTime: number,
  data: Record<string, unknown> = {},
): DecodedEvent => ({
  name,
  contractId: "C",
  ledger: 10,
  txHash: `tx-${name}-${String(topics[0])}`,
  closeTime,
  topics,
  data,
});

const subscribe = (mandate: bigint, closeTime: number, merchant = MERCHANT): DecodedEvent =>
  ev("subscribed", [mandate, SUBSCRIBER, merchant], closeTime, {
    plan_id: 1n,
    amount: 10_000_000n,
    period: 2_592_000n,
    next_charge: BigInt(closeTime),
    max_charges: 0n,
    fee_bps: 100n,
  });

/**
 * January 2025 cohort, four mandates:
 *   1  starts Jan 5,  cancelled Jan 25 (its own month)  → gone from period 1
 *   2  starts Jan 10, ended by the merchant Feb 14       → gone from period 2
 *   3  starts Jan 20, completed at Mar 1 00:00:00 UTC    → active at Mar 1, gone from period 3
 *   4  starts Jan 31 23:59:59 and never departs
 *   → periods 1..4 (Feb 1, Mar 1, Apr 1, May 1): 3, 2, 1, 1 of 4
 *
 * February 2025 cohort, two mandates:
 *   5  starts Feb 2, cancelled Apr 15                    → gone from period 3
 *   6  starts Feb 28 and never departs
 *   → periods 1..3 (Mar 1, Apr 1, May 1): 2, 2, 1 of 2
 *
 * No March cohort. Mandate 7 belongs to another merchant. Now is May 10, so
 * June 1 has not begun and no cohort reports it.
 */
const FIXTURE: DecodedEvent[] = [
  subscribe(1n, at("2025-01-05T12:00:00Z")),
  subscribe(2n, at("2025-01-10T12:00:00Z")),
  subscribe(3n, at("2025-01-20T12:00:00Z")),
  subscribe(4n, at("2025-01-31T23:59:59Z")),
  subscribe(5n, at("2025-02-02T12:00:00Z")),
  subscribe(6n, at("2025-02-28T12:00:00Z")),
  subscribe(7n, at("2025-01-07T12:00:00Z"), OTHER_MERCHANT),
  ev("cancelled", [1n, SUBSCRIBER], at("2025-01-25T12:00:00Z")),
  ev("mandate_ended", [2n, MERCHANT], at("2025-02-14T12:00:00Z")),
  ev("mandate_completed", [3n, SUBSCRIBER], at("2025-03-01T00:00:00Z")),
  ev("cancelled", [5n, SUBSCRIBER], at("2025-04-15T12:00:00Z")),
  ev("cancelled", [7n, SUBSCRIBER], at("2025-01-08T12:00:00Z")),
];

const NOW = at("2025-05-10T00:00:00Z");

const EXPECTED: MerchantCohortsResponse = {
  merchant: MERCHANT,
  bucket: "month",
  cohorts: [
    {
      cohort: "2025-01",
      size: 4,
      retention: [
        { period: 1, active: 3, share: 0.75 },
        { period: 2, active: 2, share: 0.5 },
        { period: 3, active: 1, share: 0.25 },
        { period: 4, active: 1, share: 0.25 },
      ],
    },
    {
      cohort: "2025-02",
      size: 2,
      retention: [
        { period: 1, active: 2, share: 1 },
        { period: 2, active: 2, share: 1 },
        { period: 3, active: 1, share: 0.5 },
      ],
    },
  ],
};

describe("merchant cohort retention", () => {
  const db = openDatabase(":memory:");
  const store = asStorage(db);
  let server: Server;
  let base = "";

  before(async () => {
    const indexer = new Indexer(db, {} as never, {} as never);
    for (const event of FIXTURE) assert.equal(await indexer.apply(event), "applied");

    const app = express();
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

  test("monthly cohorts match the known answers", async () => {
    assert.deepEqual(await getMerchantCohorts(store, MERCHANT, "month", 12, NOW), EXPECTED);
  });

  test("limit keeps the most recent cohorts", async () => {
    assert.deepEqual(
      (await getMerchantCohorts(store, MERCHANT, "month", 1, NOW)).cohorts,
      EXPECTED.cohorts.slice(1),
    );
  });

  test("a period is reported only once its bucket has begun", async () => {
    // On the last day of February only the January cohort has a period.
    const early = await getMerchantCohorts(store, MERCHANT, "month", 12, at("2025-02-28T23:59:59Z"));
    assert.deepEqual(
      early.cohorts.map((c) => [c.cohort, c.retention.length]),
      [
        ["2025-01", 1],
        ["2025-02", 0],
      ],
    );
  });

  test("weekly cohorts start on Monday", async () => {
    // Jan 5 2025 is a Sunday, so mandate 1 opens the week of Monday Dec 30.
    const weekly = await getMerchantCohorts(store, MERCHANT, "week", 120, NOW);
    assert.deepEqual(
      weekly.cohorts.map((c) => [c.cohort, c.size]),
      [
        ["2024-12-30", 1],
        ["2025-01-06", 1],
        ["2025-01-20", 1],
        ["2025-01-27", 2],
        ["2025-02-24", 1],
      ],
    );
    // Mandate 1 was cancelled on Saturday Jan 25: it was still active when
    // the weeks of Jan 6, 13 and 20 began, and gone from the week of Jan 27.
    const first = weekly.cohorts[0]!.retention.slice(0, 5).map((r) => r.active);
    assert.deepEqual(first, [1, 1, 1, 0, 0]);
  });

  test("a merchant without mandates has no cohorts", async () => {
    assert.deepEqual((await getMerchantCohorts(store, SUBSCRIBER, "month", 12, NOW)).cohorts, []);
  });

  test("replaying the events leaves the cohorts unchanged", async () => {
    const indexer = new Indexer(db, {} as never, {} as never);
    for (const event of FIXTURE) await indexer.apply(event);
    assert.deepEqual(await getMerchantCohorts(store, MERCHANT, "month", 12, NOW), EXPECTED);
  });

  test("GET /merchants/:address/cohorts serves the report", async () => {
    const res = await fetch(`${base}/api/merchants/${MERCHANT}/cohorts?bucket=month`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as MerchantCohortsResponse;
    assert.equal(body.bucket, "month");
    assert.deepEqual(body.cohorts.map((c) => [c.cohort, c.size]), [
      ["2025-01", 4],
      ["2025-02", 2],
    ]);
    // Served against the wall clock, so later periods follow; the first four
    // are the fixture's.
    assert.deepEqual(body.cohorts[0]!.retention.slice(0, 4), EXPECTED.cohorts[0]!.retention);

    assert.equal((await fetch(`${base}/api/merchants/${MERCHANT}/cohorts?bucket=year`)).status, 400);
    assert.equal((await fetch(`${base}/api/merchants/not-an-address/cohorts`)).status, 400);
  });
});
