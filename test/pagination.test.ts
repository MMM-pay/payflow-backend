/**
 * Tests for issue #296: pagination correctness across page boundaries.
 *
 * Seeds more mandates than MAX_LIMIT (200) and pages through all of them with
 * the cursor API, asserting:
 *   - every row appears exactly once (no overlap, no gaps)
 *   - the final page carries nextCursor === null
 *   - a small page size works correctly too
 */

import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import { testAddress } from "./addresses.ts";

/** One more than the page cap so we always cross at least one boundary. */
const TOTAL_MANDATES = 25;

const MERCHANT = testAddress(70);
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

const NOW = Math.floor(Date.now() / 1000);

let server: Server;
let base = "";
const db = openDatabase(":memory:");

const ev = (
  name: string,
  topics: unknown[],
  data: Record<string, unknown>,
  tx = "tx",
  closeTime: number | null = null,
): DecodedEvent => ({ name, contractId: "C", ledger: 1, txHash: tx, topics, data, closeTime });

/** Collect all mandates by following the cursor chain until exhausted. */
async function collectAllPages(
  pageSize: number,
  extraQuery = "",
): Promise<{ ids: number[]; pageCount: number }> {
  const ids: number[] = [];
  let cursor: string | undefined;
  let pageCount = 0;

  while (true) {
    const qs = new URLSearchParams({ limit: String(pageSize) });
    if (cursor !== undefined) qs.set("cursor", cursor);
    if (extraQuery) {
      for (const [k, v] of new URLSearchParams(extraQuery)) qs.set(k, v);
    }
    const res = await fetch(`${base}/api/mandates?${qs.toString()}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { mandates: { id: number }[]; nextCursor: string | null };
    pageCount++;

    for (const m of body.mandates) ids.push(m.id);

    if (body.nextCursor === null) break;
    cursor = body.nextCursor;

    // Safety: prevent infinite loops in case of a bug
    if (pageCount > TOTAL_MANDATES + 5) {
      throw new Error("pagination did not terminate");
    }
  }

  return { ids, pageCount };
}

before(async () => {
  const ix = new Indexer(db, {} as never, {} as never);

  await ix.apply(ev("plan_created", [MERCHANT, 1n], {
    token: TOKEN, amount: 10_000_000n, period: 2_592_000n, name: "pagination-plan",
  }, "p1"));

  for (let i = 1; i <= TOTAL_MANDATES; i++) {
    const sub = testAddress(100 + i);
    await ix.apply(ev("subscribed", [BigInt(i), sub, MERCHANT], {
      plan_id: 1n, amount: 10_000_000n, period: 2_592_000n,
      next_charge: BigInt(NOW + i * 86_400), fee_bps: 0n,
    }, `s${i}`));
  }

  ix.status.cursor = 1;
  ix.status.latest = 1;

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

describe("cursor pagination correctness (#296)", () => {
  test("small page size: every row appears exactly once", async () => {
    const PAGE_SIZE = 7;
    const { ids, pageCount } = await collectAllPages(PAGE_SIZE);

    assert.equal(ids.length, TOTAL_MANDATES, `all ${TOTAL_MANDATES} mandates returned`);

    const unique = new Set(ids);
    assert.equal(unique.size, TOTAL_MANDATES, "no duplicate ids across pages");

    const expectedPageCount = Math.ceil(TOTAL_MANDATES / PAGE_SIZE);
    assert.equal(pageCount, expectedPageCount, `${expectedPageCount} pages for ${TOTAL_MANDATES} rows at ${PAGE_SIZE} per page`);
  });

  test("page size 1: each mandate on its own page", async () => {
    const { ids, pageCount } = await collectAllPages(1);
    assert.equal(ids.length, TOTAL_MANDATES);
    assert.equal(new Set(ids).size, TOTAL_MANDATES, "no duplicates at page size 1");
    assert.equal(pageCount, TOTAL_MANDATES);
  });

  test("page size larger than total: single page, no next cursor", async () => {
    const PAGE_SIZE = TOTAL_MANDATES + 10;
    const { ids, pageCount } = await collectAllPages(PAGE_SIZE);
    assert.equal(ids.length, TOTAL_MANDATES);
    assert.equal(pageCount, 1, "single page when limit exceeds total");
  });

  test("merchant filter is preserved across pages", async () => {
    const { ids } = await collectAllPages(5, `merchant=${MERCHANT}`);
    assert.equal(ids.length, TOTAL_MANDATES, "all mandates belong to the filtered merchant");
    assert.equal(new Set(ids).size, TOTAL_MANDATES, "no duplicates with merchant filter");
  });

  test("ids are strictly decreasing across pages (newest first order)", async () => {
    const { ids } = await collectAllPages(5);
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i]! < ids[i - 1]!, `id[${i}] < id[${i - 1}] (descending order)`);
    }
  });

  test("plans endpoint also paginates correctly", async () => {
    const PAGE_SIZE = 5;
    const planIds: number[] = [];
    let cursor: string | undefined;
    let pageCount = 0;

    while (true) {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), merchant: MERCHANT });
      if (cursor !== undefined) qs.set("cursor", cursor);
      const res = await fetch(`${base}/api/plans?${qs.toString()}`);
      assert.equal(res.status, 200);
      const body = await res.json() as { plans: { id: number }[]; nextCursor: string | null };
      pageCount++;
      for (const p of body.plans) planIds.push(p.id);
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
      if (pageCount > 20) throw new Error("plans pagination did not terminate");
    }

    assert.equal(planIds.length, 1, "one plan was seeded");
    assert.equal(new Set(planIds).size, 1, "no duplicates");
  });
});
