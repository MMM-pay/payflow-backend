import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import type { Config } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import { MerchantSummaryCache } from "../src/routes/index.ts";
import type { MerchantSummary } from "../src/routes/types.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const YEARLY_MERCHANT = "GDLXOW3J5FEFW4UZ7XBHX6EFHL7POV7S2NG5RZ7ULYCGLJWGPUBFQO4U";

const config = {
  STELLAR_NETWORK: "testnet",
  PLAN_REGISTRY_ID: "C".repeat(56),
  VAULT_ID: "C".repeat(56),
  SUBSCRIPTION_ID: "C".repeat(56),
  CORS_ORIGIN: "*",
  PORT: 0,
} as unknown as Config;

let server: Server;
let ix: Indexer;
const status = {
  cursor: 1_000,
  latest: 1_010,
  lastRunAt: Date.now(),
  lastError: null,
  lastLedgerCloseTime: 1_700_000_000,
  freshnessSeconds: 42,
};
let base: string;
const db = openDatabase(":memory:");

const ev = (name: string, topics: unknown[], data: Record<string, unknown>, tx = "t"): DecodedEvent => ({
  name, contractId: "C", ledger: 1, txHash: tx, topics, data,
});

before(async () => {
  ix = new Indexer(db, {} as never, {} as never);

  ix.apply(ev("plan_created", [MERCHANT, 1n], { token: "C", amount: 10_000_000n, period: 2_592_000n }));
  ix.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 10_000_000n, period: 2_592_000n, next_charge: 1n,
  }));
  ix.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
    amount: 9_900_000n, fee: 100_000n, charges_made: 1n, next_charge: 4_000_000_000n,
  }, "tx1"));

  // A yearly plan: one charge of 120_000_000 per 365-day period, next charge
  // far in the future so it never lands in the due list.
  ix.apply(ev("subscribed", [2n, SUBSCRIBER, YEARLY_MERCHANT], {
    plan_id: 1n, amount: 120_000_000n, period: 31_536_000n, next_charge: 4_000_000_000n,
  }, "tx2"));

  const app = createApp(db, config, status, ix.merchantCache);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  db.close();
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() as Record<string, never> };
};

describe("http api", () => {
  test("health reports contract wiring", async () => {
    const { status, body } = await get("/health");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
  });

  test("health reports indexer lag", async () => {
    const { body } = await get("/health");
    const ix = body.indexer as unknown as { cursor: number; lag: number };
    assert.equal(ix.cursor, 1_000);
    assert.equal(ix.lag, 10);
  });

  test("health reports freshnessSeconds", async () => {
    const { body } = await get("/health");
    const ixStatus = body.indexer as unknown as { freshnessSeconds: number };
    assert.equal(ixStatus.freshnessSeconds, 42);
  });

  test("health says catching_up while far behind, but stays 200", async () => {
    status.latest = 50_000;
    try {
      const res = await get("/health");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "catching_up");
    } finally {
      status.latest = 1_010;
    }
  });

  test("lists plans and filters by merchant", async () => {
    const all = await get("/api/plans");
    assert.equal((all.body.plans as unknown[]).length, 1);

    const mine = await get(`/api/plans?merchant=${MERCHANT}`);
    assert.equal((mine.body.plans as unknown[]).length, 1);

    const none = await get("/api/plans?merchant=GNOBODY");
    assert.equal((none.body.plans as unknown[]).length, 0);
  });

  test("unknown plan is 404", async () => {
    const { status } = await get("/api/plans/999");
    assert.equal(status, 404);
  });

  test("mandate charge history", async () => {
    const { body } = await get("/api/mandates/1/charges");
    assert.equal((body.charges as unknown[]).length, 1);
  });

  test("batch mandate lookup omits unknown ids", async () => {
    const { body } = await get("/api/mandates?ids=1,2,999");
    const rows = body.mandates as unknown as { id: number }[];
    assert.deepEqual(
      rows.map((r) => r.id), // ORDER BY id DESC, as the list endpoint always does
      [2, 1],
    );
  });

  test("batch mandate lookup rejects more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1).join(",");
    const { status, body } = await get(`/api/mandates?ids=${ids}`);
    assert.equal(status, 400);
    assert.equal(body.error, "too_many_ids");
  });

  test("batch mandate lookup rejects a non-numeric id", async () => {
    const { status, body } = await get("/api/mandates?ids=1,nope");
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_ids");
  });

  test("merchant summary computes MRR, ARR and revenue", async () => {
    const { body } = await get(`/api/merchants/${MERCHANT}/summary`);
    assert.equal(body.activeMandates, 1);
    assert.equal(body.totalCollected, "9900000");
    // 10_000_000 per 30-day period normalises to itself, twelve times a year
    assert.equal(body.mrr, "10000000");
    assert.equal(body.arr, "121666666");
  });

  test("yearly plan fixture gives the expected ARR", async () => {
    const { body } = await get(`/api/merchants/${YEARLY_MERCHANT}/summary`);
    assert.equal(body.activeMandates, 1);
    // 120_000_000 per 365-day period is the ARR itself...
    assert.equal(body.arr, "120000000");
    // ...and the same amount normalised to a 30-day month is smaller than ARR.
    assert.equal(body.mrr, "9863013");
  });

  test("subscriber summary includes fee in total paid", async () => {
    const { body } = await get(`/api/subscribers/${SUBSCRIBER}/summary`);
    assert.equal(body.totalPaid, "10000000");
  });

  test("due list excludes future charges", async () => {
    const { body } = await get("/api/due");
    assert.equal((body.due as unknown[]).length, 0);
  });

  test("stats reflect indexed state", async () => {
    const { body } = await get("/api/stats");
    assert.equal(body.plans, 1);
    assert.equal(body.mandates, 2);
    assert.equal(body.charges, 1);
  });

  test("unknown route is 404 json", async () => {
    const { status, body } = await get("/nope");
    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
  });

  test("every response carries an X-Request-Id, reusing the caller's", async () => {
    const generated = await fetch(`${base}/health`);
    assert.ok(generated.headers.get("x-request-id"));
    const missing = await fetch(`${base}/nope`);
    assert.ok(missing.headers.get("x-request-id"));
    const echoed = await fetch(`${base}/health`, { headers: { "X-Request-Id": "abc-123" } });
    assert.equal(echoed.headers.get("x-request-id"), "abc-123");
  });

  test("X-Request-Id is exposed to browsers through CORS", async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: "http://localhost:3000" } });
    assert.match(res.headers.get("access-control-expose-headers") ?? "", /x-request-id/i);
  });
});

describe("merchant summary caching", () => {
  test("invalidates after a new charge", async () => {
    const memDb = openDatabase(":memory:");
    const cache = new MerchantSummaryCache();
    const indexer = new Indexer(memDb, {} as never, {} as never, cache);
    indexer.apply(ev("plan_created", [MERCHANT, 1n], { token: "C", amount: 10_000_000n, period: 2_592_000n }));
    indexer.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
      plan_id: 1n, amount: 10_000_000n, period: 2_592_000n, next_charge: 1n,
    }));
    indexer.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
      amount: 9_900_000n, fee: 100_000n, charges_made: 1n, next_charge: 4_000_000_000n,
    }, "tx1"));

    const app = createApp(memDb, config, status, cache);
    const testServer = app.listen(0);
    const addr = testServer.address();
    const testBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    try {
      const firstRes = await fetch(`${testBase}/api/merchants/${MERCHANT}/summary`);
      const first = (await firstRes.json()) as MerchantSummary;
      assert.equal(first.chargeCount, 1);
      assert.equal(first.totalCollected, "9900000");

      // Apply a second charge
      indexer.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
        amount: 5_000_000n, fee: 50_000n, charges_made: 2n, next_charge: 5_000_000_000n,
      }, "tx2"));

      const secondRes = await fetch(`${testBase}/api/merchants/${MERCHANT}/summary`);
      const second = (await secondRes.json()) as MerchantSummary;
      assert.equal(second.chargeCount, 2);
      assert.equal(second.totalCollected, "14900000");
    } finally {
      testServer.close();
      memDb.close();
    }
  });

  test("memory is bounded by evicting oldest entries", () => {
    const cache = new MerchantSummaryCache(2);
    const mockSummary = (m: string): MerchantSummary => ({
      merchant: m,
      activeMandates: 1,
      totalCollected: "100",
      chargeCount: 1,
      mrr: "10",
      arr: "120",
    });

    cache.set("m1", mockSummary("m1"));
    cache.set("m2", mockSummary("m2"));
    assert.equal(cache.size, 2);

    // Access m1 so m2 is the least recently used
    assert.equal(cache.get("m1")?.merchant, "m1");

    // Inserting 3rd entry evicts m2
    cache.set("m3", mockSummary("m3"));
    assert.equal(cache.size, 2);
    assert.equal(cache.get("m1")?.merchant, "m1");
    assert.equal(cache.get("m2"), undefined);
    assert.equal(cache.get("m3")?.merchant, "m3");
  });
});

describe("stats volume", () => {
  const MERCHANT2 = "GBIWM7VWG7UBSHPOXG7XQV6M4EXG2XC5JQER6IZU35VS2DGLTJX7UVOM";
  const statsDb = openDatabase(":memory:");
  const statsIx = new Indexer(statsDb, {} as never, {} as never);
  let statsServer: Server;
  let statsBase: string;

  const ev = (
    name: string,
    topics: unknown[],
    data: Record<string, unknown>,
    tx = "t",
  ): DecodedEvent => ({ name, contractId: "C", ledger: 1, txHash: tx, topics, data });

  const statsGet = async (path: string) => {
    const res = await fetch(statsBase + path);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  before(async () => {
    // One active merchant with a recent charge and one from two days ago, and
    // a cancelled merchant that must not count as active.
    statsIx.apply(ev("plan_created", [MERCHANT, 1n], {
      token: "CTOKEN", amount: 10_000_000n, period: 2_592_000n, name: "p1",
    }));
    statsIx.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
      plan_id: 1n, amount: 10_000_000n, period: 2_592_000n, next_charge: 4_000_000_000n,
    }));
    statsIx.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
      amount: 2_000_000n, fee: 100_000n, charges_made: 1n, next_charge: 4_000_000_000n,
    }, "tx-old"));
    statsIx.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
      amount: 3_000_000n, fee: 150_000n, charges_made: 2n, next_charge: 4_000_000_000n,
    }, "tx-recent"));
    statsDb
      .prepare("UPDATE charges SET created_at = ? WHERE tx_hash = ?")
      .run(Date.now() - 2 * 86_400_000, "tx-old");

    statsIx.apply(ev("plan_created", [MERCHANT2, 2n], {
      token: "CTOKEN", amount: 1_000_000n, period: 2_592_000n, name: "p2",
    }));
    statsIx.apply(ev("subscribed", [2n, SUBSCRIBER, MERCHANT2], {
      plan_id: 2n, amount: 1_000_000n, period: 2_592_000n, next_charge: 4_000_000_000n,
    }));
    statsIx.apply(ev("cancelled", [2n, SUBSCRIBER], { charges_made: 0 }));

    const app = createApp(statsDb, config);
    await new Promise<void>((resolve) => {
      statsServer = app.listen(0, () => {
        const addr = statsServer.address();
        statsBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    statsServer.close();
    statsDb.close();
  });

  test("stats report volume, fees and active merchants as decimal strings", async () => {
    const { body } = await statsGet("/api/stats");
    assert.equal(body.plans, 2);
    assert.equal(body.mandates, 2);
    assert.equal(body.activeMandates, 1);
    assert.equal(body.charges, 2);
    // Only the merchant with an active mandate counts.
    assert.equal(body.activeMerchants, 1);
    // Gross volume and fees across every charge: 2_100_000 + 3_150_000.
    assert.equal(body.volumeAllTime, "5250000");
    assert.equal(body.totalFees, "250000");
    for (const field of ["volume24h", "volumeAllTime", "totalFees"]) {
      assert.equal(typeof body[field], "string", `${field} is a string`);
    }
  });

  test("the 24-hour window counts only recent charges", async () => {
    const { body } = await statsGet("/api/stats");
    // The charge from two days ago is excluded: 3_000_000 + 150_000.
    assert.equal(body.volume24h, "3150000");
  });
});
