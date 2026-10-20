import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import { testAddress } from "./addresses.ts";

/**
 * Every route of the API, its filters and its error cases.
 *
 * The API is what the frontend and any third-party developer read, so each
 * route needs a test of its own: one that shows it answers, one that shows
 * its filters narrow the result, and one that shows a bad id is refused
 * rather than crashing the request.
 */

const MERCHANT = testAddress(30);
const OTHER_MERCHANT = testAddress(31);
const SUBSCRIBER = testAddress(32);
const OTHER_SUBSCRIBER = testAddress(33);
const TOKEN = "CDQ5EJTVXXX2CBMHWP3BGGUDHSK6D4I25IF5XXH3QGL2TNTBMJUOFKDB";

const testnet: NetworkConfig = {
  name: "testnet",
  rpcUrl: "https://rpc.invalid",
  networkPassphrase: "Test SDF Network ; September 2015",
  planRegistryId: "C".repeat(56),
  vaultId: "C".repeat(56),
  subscriptionId: "C".repeat(56),
  startLedger: 0,
  databasePath: ":memory:",
};
const config = { CORS_ORIGIN: "*" } as unknown as Config;

/** Now, in unix seconds; the due fixtures hang off it. */
const NOW = Math.floor(Date.now() / 1000);

let server: Server;
let base = "";
const db = openDatabase(":memory:");

const ev = (
  name: string,
  topics: unknown[],
  data: Record<string, unknown>,
  tx = "t",
): DecodedEvent => ({ name, contractId: "C", ledger: 1, txHash: tx, topics, data });

before(async () => {
  const ix = new Indexer(db, {} as never, {} as never);

  // Plan 1 belongs to the first merchant, plan 2 to the second.
  ix.apply(ev("plan_created", [MERCHANT, 1n], {
    token: TOKEN, amount: 10_000_000n, period: 2_592_000n, name: "monthly",
  }, "p1"));
  ix.apply(ev("plan_created", [OTHER_MERCHANT, 2n], {
    token: TOKEN, amount: 5_000_000n, period: 2_592_000n, name: "other",
  }, "p2"));

  // Mandate 1: active and due, with a funded vault.
  ix.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 10_000_000n, period: 2_592_000n,
    next_charge: BigInt(NOW - 60), fee_bps: 100n,
  }, "s1"));
  ix.apply(ev("deposit", [SUBSCRIBER, TOKEN], {
    amount: 20_000_000n, balance: 20_000_000n,
  }, "v1"));

  // Mandate 2: active, due, but its vault holds nothing.
  ix.apply(ev("subscribed", [2n, OTHER_SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 10_000_000n, period: 2_592_000n,
    next_charge: BigInt(NOW - 60), fee_bps: 100n,
  }, "s2"));

  // Mandate 3: active, but not due yet.
  ix.apply(ev("subscribed", [3n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 1_000_000n, period: 2_592_000n,
    next_charge: BigInt(NOW + 86_400), fee_bps: 0n,
  }, "s3"));

  // Mandate 4: paused, and mandate 5: cancelled — neither is chargeable.
  ix.apply(ev("subscribed", [4n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 1_000_000n, period: 2_592_000n,
    next_charge: BigInt(NOW - 60), fee_bps: 0n,
  }, "s4"));
  ix.apply(ev("pause_changed", [4n, SUBSCRIBER], { paused: true }, "p4"));
  ix.apply(ev("subscribed", [5n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 1_000_000n, period: 2_592_000n,
    next_charge: BigInt(NOW - 60), fee_bps: 0n,
  }, "s5"));
  ix.apply(ev("cancelled", [5n, SUBSCRIBER], { charges_made: 0 }, "c5"));

  // Mandate 6: the other merchant's mandate, so the merchant filter has
  // something to separate.
  ix.apply(ev("subscribed", [6n, OTHER_SUBSCRIBER, OTHER_MERCHANT], {
    plan_id: 2n, amount: 5_000_000n, period: 2_592_000n,
    next_charge: BigInt(NOW + 86_400), fee_bps: 0n,
  }, "s6"));

  // A settled charge, so the history and the revenue reports have something.
  // The mandate stays due: the charge does not move its next charge.
  ix.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
    amount: 9_900_000n, fee: 100_000n, charges_made: 1n, next_charge: BigInt(NOW - 60),
  }, "ch1"));

  // The projection has caught up, so the readiness probe passes.
  ix.status.cursor = 100;
  ix.status.latest = 100;

  const app = createApp([{ config: testnet, db, indexer: ix.status, events: ix.events }], config);
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
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : ({} as Record<string, unknown>),
  };
};

describe("every route answers", () => {
  /** Every route of the API, with the status a well-formed request gets. */
  const ROUTES: { name: string; path: string; status: number }[] = [
    { name: "health", path: "/health", status: 200 },
    { name: "readiness", path: "/ready", status: 200 },
    { name: "the OpenAPI document", path: "/api/openapi.json", status: 200 },
    { name: "the plans list", path: "/api/plans", status: 200 },
    { name: "one plan", path: "/api/plans/1", status: 200 },
    { name: "a plan's statistics", path: "/api/plans/1/stats", status: 200 },
    { name: "the mandates list", path: "/api/mandates", status: 200 },
    { name: "one mandate", path: "/api/mandates/1", status: 200 },
    { name: "a mandate's charges", path: "/api/mandates/1/charges", status: 200 },
    { name: "the due list", path: "/api/due", status: 200 },
    { name: "a merchant's summary", path: `/api/merchants/${MERCHANT}/summary`, status: 200 },
    { name: "a merchant's subscribers", path: `/api/merchants/${MERCHANT}/subscribers`, status: 200 },
    { name: "a merchant's churn", path: `/api/merchants/${MERCHANT}/churn`, status: 200 },
    { name: "a merchant's revenue", path: `/api/merchants/${MERCHANT}/revenue`, status: 200 },
    { name: "a merchant's forecast", path: `/api/merchants/${MERCHANT}/forecast`, status: 200 },
    { name: "a subscriber's summary", path: `/api/subscribers/${SUBSCRIBER}/summary`, status: 200 },
    { name: "a subscriber's upcoming charges", path: `/api/subscribers/${SUBSCRIBER}/upcoming`, status: 200 },
    { name: "a vault's balances", path: `/api/vault/${SUBSCRIBER}`, status: 200 },
    { name: "a vault's events", path: `/api/vault/${SUBSCRIBER}/events`, status: 200 },
    { name: "the protocol fee", path: "/api/protocol", status: 200 },
    { name: "the protocol totals", path: "/api/stats", status: 200 },
  ];

  for (const route of ROUTES) {
    test(`${route.name} answers ${route.status}`, async () => {
      const { status } = await get(route.path);
      assert.equal(status, route.status);
    });
  }

  test("the token route answers with a readable error, never a crash", async () => {
    // No token reader is wired in the test, so the contract cannot be read.
    const { status, body } = await get(`/api/tokens/${TOKEN}`);
    assert.equal(status, 502);
    assert.equal((body.error as { code: string }).code, "token_metadata_unavailable");
  });

  test("the stream route opens a stream", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    controller.abort();
  });
});

describe("the filters narrow the result", () => {
  test("the plans list filters by merchant", async () => {
    const all = await get("/api/plans");
    assert.equal((all.body.plans as unknown[]).length, 2);

    const mine = await get(`/api/plans?merchant=${MERCHANT}`);
    assert.deepEqual(
      (mine.body.plans as { id: number }[]).map((plan) => plan.id),
      [1],
    );

    const none = await get(`/api/plans?merchant=${testAddress(34)}`);
    assert.deepEqual(none.body.plans, []);
  });

  test("the mandates list filters by merchant, subscriber and status", async () => {
    const all = await get("/api/mandates");
    assert.equal((all.body.mandates as unknown[]).length, 6);

    const mine = await get(`/api/mandates?merchant=${MERCHANT}`);
    assert.equal((mine.body.mandates as unknown[]).length, 5);

    const theirs = await get(`/api/mandates?merchant=${OTHER_MERCHANT}`);
    assert.equal((theirs.body.mandates as unknown[]).length, 1);

    const subscriber = await get(`/api/mandates?subscriber=${SUBSCRIBER}`);
    assert.equal((subscriber.body.mandates as unknown[]).length, 4);

    const active = await get("/api/mandates?status=Active");
    assert.equal((active.body.mandates as unknown[]).length, 4);

    const paused = await get("/api/mandates?status=Paused");
    assert.equal((paused.body.mandates as unknown[]).length, 1);

    const cancelled = await get("/api/mandates?status=Cancelled");
    assert.equal((cancelled.body.mandates as unknown[]).length, 1);

    // The filters combine.
    const both = await get(`/api/mandates?merchant=${MERCHANT}&status=Cancelled`);
    assert.equal((both.body.mandates as unknown[]).length, 1);
  });

  test("the mandates list filters by a batch of ids", async () => {
    const { body } = await get("/api/mandates?ids=1,3");
    assert.deepEqual(
      (body.mandates as { id: number }[]).map((mandate) => mandate.id).sort(),
      [1, 3],
    );
  });

  test("a limit above the cap is capped, not refused", async () => {
    const { status, body } = await get("/api/mandates?limit=1000");
    assert.equal(status, 200, "a large limit is not an error");
    assert.equal((body.mandates as unknown[]).length, 6);

    const capped = await get("/api/mandates?limit=1");
    assert.equal((capped.body.mandates as unknown[]).length, 1);
  });

  test("the vault events list filters by limit", async () => {
    const all = await get(`/api/vault/${SUBSCRIBER}/events`);
    assert.equal((all.body.events as unknown[]).length, 1);
    const none = await get(`/api/vault/${SUBSCRIBER}/events?limit=0`);
    assert.equal(none.status, 400, "zero is not a page size");
  });

  test("the merchant reports filter by bucket, range and days", async () => {
    const churn = await get(`/api/merchants/${MERCHANT}/churn?bucket=month`);
    assert.equal(churn.status, 200);
    const revenue = await get(`/api/merchants/${MERCHANT}/revenue?bucket=day&from=0&to=9999999999`);
    assert.equal(revenue.status, 200);
    const forecast = await get(`/api/merchants/${MERCHANT}/forecast?days=7`);
    assert.equal(forecast.body.days, 7);
    const upcoming = await get(`/api/subscribers/${SUBSCRIBER}/upcoming?days=7`);
    assert.equal(upcoming.body.days, 7);
  });

  test("an unknown filter value is refused rather than ignored", async () => {
    const status = await get("/api/mandates?status=Nonsense");
    assert.equal(status.status, 400);
    assert.equal((status.body.error as { code: string }).code, "invalid_request");

    const limit = await get("/api/mandates?limit=lots");
    assert.equal(limit.status, 400);

    const merchant = await get("/api/mandates?merchant=not-an-address");
    assert.equal(merchant.status, 400);
  });
});

describe("the due list says which mandates the vault can cover", () => {
  test("a mandate the vault covers is funded, one it cannot is not", async () => {
    const { body } = await get("/api/due");
    const due = body.due as { id: number; funded: boolean }[];
    // Mandates 1 and 2 are due; only the first one's vault holds anything.
    assert.deepEqual(due.map((mandate) => mandate.id), [1, 2]);
    assert.equal(due[0]!.funded, true);
    assert.equal(due[1]!.funded, false);
  });

  test("a paused or cancelled mandate is never due", async () => {
    const { body } = await get("/api/due");
    const ids = (body.due as { id: number }[]).map((mandate) => mandate.id);
    assert.equal(ids.includes(4), false, "a paused mandate is not due");
    assert.equal(ids.includes(5), false, "a cancelled mandate is not due");
  });
});

describe("a bad id is refused, not crashed on", () => {
  /** The routes that take an id. */
  const ID_ROUTES = [
    "/api/plans/:id",
    "/api/plans/:id/stats",
    "/api/mandates/:id",
    "/api/mandates/:id/charges",
  ];

  for (const route of ID_ROUTES) {
    test(`${route} answers 404 for an unknown id`, async () => {
      const path = route.replace(":id", "9999");
      const { status, body } = await get(path);
      assert.equal(status, 404);
      assert.equal((body.error as { code: string }).code.endsWith("_not_found"), true);
    });

    test(`${route} refuses a non-numeric id with a 4xx, never a 500`, async () => {
      const path = route.replace(":id", "not-a-number");
      const { status, body } = await get(path);
      assert.ok(status >= 400 && status < 500, `expected a 4xx, got ${status}`);
      assert.notEqual(status, 500);
      assert.equal((body.error as { code: string }).code, "invalid_request");
    });
  }

  test("a negative or zero id is refused", async () => {
    for (const path of ["/api/plans/0", "/api/plans/-1", "/api/mandates/0", "/api/mandates/1.5"]) {
      const { status } = await get(path);
      assert.ok(status >= 400 && status < 500, `${path} answered ${status}`);
    }
  });
});
