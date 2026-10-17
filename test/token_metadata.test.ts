import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import {
  TokenMetadataService,
  TokenMetadataUnavailable,
  nativeTokenId,
  type TokenReader,
} from "../src/lib/tokens.ts";
import type { Config } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import type { MandateRow, PlanRow } from "../src/routes/types.ts";

const TESTNET = "Test SDF Network ; September 2015";
const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
// A USDC-style contract id (56 chars) that the fake reader recognises.
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGHPJDUIVAPHCIMTQWGLP3OK53N2OQ6TQ7N";
// A well-formed contract id the fake reader refuses, standing in for an
// unreachable token.
const UNKNOWN = "C" + "D".repeat(55);

const config = {
  STELLAR_NETWORK: "testnet",
  NETWORK_PASSPHRASE: TESTNET,
  PLAN_REGISTRY_ID: "C".repeat(56),
  VAULT_ID: "C".repeat(56),
  SUBSCRIPTION_ID: "C".repeat(56),
  CORS_ORIGIN: "*",
  PORT: 0,
} as unknown as Config;

const NATIVE_ID = nativeTokenId(TESTNET);

let reads = 0;
const reader: TokenReader = async (tokenId) => {
  reads += 1;
  if (tokenId === USDC) return { token: tokenId, symbol: "USDC", name: "USD Coin", decimals: 7 };
  throw new TokenMetadataUnavailable(`no metadata for ${tokenId}`);
};

const ev = (name: string, topics: unknown[], data: Record<string, unknown>, tx = "t"): DecodedEvent => ({
  name, contractId: "C", ledger: 1, txHash: tx, topics, data,
});

let server: Server;
let base: string;
const db = openDatabase(":memory:");

before(async () => {
  const ix = new Indexer(db, {} as never, {} as never);
  // Plan 1 pays in USDC, plan 2 in the network's native asset.
  ix.apply(ev("plan_created", [MERCHANT, 1n], { token: USDC, amount: 5_000_000n, period: 2_592_000n }));
  ix.apply(ev("plan_created", [MERCHANT, 2n], { token: NATIVE_ID, amount: 10_000_000n, period: 2_592_000n }));
  ix.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 5_000_000n, period: 2_592_000n, next_charge: 1n,
  }));

  const tokens = new TokenMetadataService(reader, { networkPassphrase: TESTNET });
  const app = createApp(db, config, undefined, undefined, tokens);
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
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("GET /api/tokens/:id", () => {
  test("reads metadata from the token contract", async () => {
    const before = reads;
    const { status, body } = await get(`/api/tokens/${USDC}`);
    assert.equal(status, 200);
    assert.equal(body.symbol, "USDC");
    assert.equal(body.name, "USD Coin");
    assert.equal(body.decimals, 7);
    assert.equal(reads, before + 1, "the contract is read once");
  });

  test("caches: a repeat request does not read the contract again", async () => {
    const before = reads;
    await get(`/api/tokens/${USDC}`);
    await get(`/api/tokens/${USDC}`);
    assert.equal(reads, before, "the cached entry is reused");
  });

  test("native SAC returns XLM / 7 without a read", async () => {
    const before = reads;
    const { status, body } = await get(`/api/tokens/${NATIVE_ID}`);
    assert.equal(status, 200);
    assert.equal(body.symbol, "XLM");
    assert.equal(body.decimals, 7);
    assert.equal(reads, before, "native metadata never reaches the reader");
  });

  test("the plain `native` alias is accepted too", async () => {
    const { status, body } = await get("/api/tokens/native");
    assert.equal(status, 200);
    assert.equal(body.symbol, "XLM");
    assert.equal(body.decimals, 7);
  });

  test("a malformed contract id is a 400", async () => {
    const { status, body } = await get("/api/tokens/not-a-token");
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_token_id");
  });

  test("an unreadable token is a 502 and is retried next request", async () => {
    const first = await get(`/api/tokens/${UNKNOWN}`);
    assert.equal(first.status, 502);
    assert.equal(first.body.error, "token_metadata_unavailable");
    const n = reads;
    await get(`/api/tokens/${UNKNOWN}`);
    assert.ok(reads > n, "a failed read is not cached, so the next call retries");
  });
});

describe("token metadata joined onto plan and mandate responses", () => {
  test("a plan in USDC carries tokenSymbol and decimals", async () => {
    const { body } = await get("/api/plans/1");
    const plan = body as unknown as PlanRow;
    assert.equal(plan.token, USDC);
    assert.equal(plan.tokenSymbol, "USDC");
    assert.equal(plan.decimals, 7);
    assert.equal(plan.amount, "5000000"); // still a string in the token's unit
  });

  test("a plan in the native asset carries XLM / 7", async () => {
    const { body } = await get("/api/plans/2");
    const plan = body as unknown as PlanRow;
    assert.equal(plan.tokenSymbol, "XLM");
    assert.equal(plan.decimals, 7);
  });

  test("the plans list carries token metadata per row", async () => {
    const { body } = await get("/api/plans");
    const plans = body.plans as unknown as PlanRow[];
    const byId = new Map(plans.map((p) => [p.id, p]));
    assert.equal(byId.get(1)?.tokenSymbol, "USDC");
    assert.equal(byId.get(2)?.tokenSymbol, "XLM");
  });

  test("a mandate inherits its plan's token metadata", async () => {
    const { body } = await get("/api/mandates/1");
    const mandate = body as unknown as MandateRow;
    assert.equal(mandate.plan_id, 1);
    assert.equal(mandate.tokenSymbol, "USDC");
    assert.equal(mandate.decimals, 7);
  });

  test("an unreadable token leaves the amount but nulls the metadata", async () => {
    const memDb = openDatabase(":memory:");
    const ix = new Indexer(memDb, {} as never, {} as never);
    ix.apply(ev("plan_created", [MERCHANT, 9n], { token: UNKNOWN, amount: 1n, period: 2_592_000n }));
    const tokens = new TokenMetadataService(reader, { networkPassphrase: TESTNET });
    const app = createApp(memDb, config, undefined, undefined, tokens);
    const testServer = app.listen(0);
    const addr = testServer.address();
    const testBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      const res = await fetch(`${testBase}/api/plans/9`);
      assert.equal(res.status, 200); // not a 502: the plan still renders
      const plan = (await res.json()) as unknown as PlanRow;
      assert.equal(plan.tokenSymbol, null);
      assert.equal(plan.decimals, null);
      assert.equal(plan.amount, "1");
    } finally {
      testServer.close();
      memDb.close();
    }
  });
});
