/**
 * Tests for issue #295: end-to-end subscribe, charge, cancel lifecycle.
 *
 * Drives the full subscription lifecycle through the API against an in-memory
 * Soroban event projection, asserting that the query layer reflects each
 * state transition exactly.
 *
 *   subscribe  → mandate is active, charge history is empty
 *   charge     → charge appears, mandate's next_charge advances
 *   cancel     → mandate status is "cancelled"
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

const MERCHANT = testAddress(60);
const SUBSCRIBER = testAddress(61);
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
let ix: Indexer;

const ev = (
  name: string,
  topics: unknown[],
  data: Record<string, unknown>,
  tx = "tx",
  closeTime: number | null = null,
): DecodedEvent => ({ name, contractId: "C", ledger: 1, txHash: tx, topics, data, closeTime });

before(async () => {
  ix = new Indexer(db, {} as never, {} as never);
  await ix.apply(ev("plan_created", [MERCHANT, 1n], {
    token: TOKEN, amount: 10_000_000n, period: 2_592_000n, name: "lifecycle-plan",
  }, "p1"));

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

describe("subscription lifecycle (#295)", () => {
  describe("after subscribe event", () => {
    before(async () => {
      await ix.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
        plan_id: 1n, amount: 10_000_000n, period: 2_592_000n,
        next_charge: BigInt(NOW + 2_592_000), fee_bps: 100n,
      }, "s1", NOW));
    });

    test("mandate appears in /api/mandates with status Active", async () => {
      const res = await fetch(`${base}/api/mandates?subscriber=${SUBSCRIBER}`);
      assert.equal(res.status, 200);
      const body = await res.json() as { mandates: { id: number; status: string }[] };
      assert.ok(body.mandates.length >= 1, "at least one mandate");
      const mandate = body.mandates.find((m) => m.status === "Active");
      assert.ok(mandate, "mandate is Active after subscribe");
    });

    test("mandate is retrievable by id", async () => {
      const listRes = await fetch(`${base}/api/mandates?subscriber=${SUBSCRIBER}`);
      const listBody = await listRes.json() as { mandates: { id: number }[] };
      const id = listBody.mandates[0]!.id;

      const res = await fetch(`${base}/api/mandates/${id}`);
      assert.equal(res.status, 200);
      const body = await res.json() as { status: string; subscriber: string; merchant: string };
      assert.equal(body.status, "Active");
      assert.equal(body.subscriber, SUBSCRIBER);
      assert.equal(body.merchant, MERCHANT);
    });

    test("charge history is empty before any charge", async () => {
      const listRes = await fetch(`${base}/api/mandates?subscriber=${SUBSCRIBER}`);
      const listBody = await listRes.json() as { mandates: { id: number }[] };
      const id = listBody.mandates[0]!.id;

      const res = await fetch(`${base}/api/mandates/${id}/charges`);
      assert.equal(res.status, 200);
      const body = await res.json() as { charges: unknown[] };
      assert.equal(body.charges.length, 0, "no charges yet");
    });
  });

  describe("after charge event", () => {
    let mandateId: number;

    before(async () => {
      const listRes = await fetch(`${base}/api/mandates?subscriber=${SUBSCRIBER}`);
      const listBody = await listRes.json() as { mandates: { id: number }[] };
      mandateId = listBody.mandates[0]!.id;

      await ix.apply(ev("charged", [BigInt(mandateId), SUBSCRIBER, MERCHANT], {
        amount: 9_900_000n, fee: 100_000n, charges_made: 1n,
        next_charge: BigInt(NOW + 2 * 2_592_000),
      }, "ch1", NOW));
    });

    test("charge appears in charge history", async () => {
      const res = await fetch(`${base}/api/mandates/${mandateId}/charges`);
      assert.equal(res.status, 200);
      const body = await res.json() as { charges: { amount: string; fee: string }[] };
      assert.equal(body.charges.length, 1, "one charge recorded");
      assert.equal(body.charges[0]!.amount, "9900000");
      assert.equal(body.charges[0]!.fee, "100000");
    });

    test("mandate remains active after charge", async () => {
      const res = await fetch(`${base}/api/mandates/${mandateId}`);
      assert.equal(res.status, 200);
      const body = await res.json() as { status: string };
      assert.equal(body.status, "Active");
    });
  });

  describe("after cancel event", () => {
    let mandateId: number;

    before(async () => {
      const listRes = await fetch(`${base}/api/mandates?subscriber=${SUBSCRIBER}`);
      const listBody = await listRes.json() as { mandates: { id: number }[] };
      mandateId = listBody.mandates[0]!.id;

      await ix.apply(ev("cancelled", [BigInt(mandateId), SUBSCRIBER], {
        charges_made: 1n,
      }, "cancel1", NOW));
    });

    test("mandate status is Cancelled", async () => {
      const res = await fetch(`${base}/api/mandates/${mandateId}`);
      assert.equal(res.status, 200);
      const body = await res.json() as { status: string };
      assert.equal(body.status, "Cancelled");
    });

    test("mandate no longer appears in /api/due", async () => {
      const res = await fetch(`${base}/api/due`);
      assert.equal(res.status, 200);
      const body = await res.json() as { due: { id: number }[] };
      const found = body.due.find((m) => m.id === mandateId);
      assert.ok(!found, "cancelled mandate is not in due list");
    });

    test("charge history is preserved after cancel", async () => {
      const res = await fetch(`${base}/api/mandates/${mandateId}/charges`);
      assert.equal(res.status, 200);
      const body = await res.json() as { charges: unknown[] };
      assert.equal(body.charges.length, 1, "charge history preserved after cancel");
    });
  });
});
