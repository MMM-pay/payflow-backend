import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { openDatabase } from "../src/lib/db.ts";
import { Indexer } from "../src/indexer.ts";
import { mandatesRouter } from "../src/routes/mandates.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import type { TokenMetadataService } from "../src/lib/tokens.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";

test("mandate timeline covers all six event types and is unchanged by replay", async () => {
  const db = openDatabase(":memory:");
  const indexer = new Indexer(db, {} as never, {} as never);
  const make = (name: string, txHash: string, data: Record<string, unknown> = {}): DecodedEvent => ({
    name, contractId: "C", ledger: 100, txHash, closeTime: 1700000000,
    topics: name === "mandate_ended" ? [1n, MERCHANT] :
      name === "subscribed" || name === "charged" ? [1n, SUBSCRIBER, MERCHANT] :
      [1n, SUBSCRIBER], data,
  });
  const events = [
    make("subscribed", "tx-1", {
      plan_id: 1n, amount: 10000000000000000000n, period: 60n,
      next_charge: 1700000060n, max_charges: 0, fee_bps: 100,
    }),
    make("charged", "tx-2", {
      amount: 9999999999999999999n, fee: 1n, charges_made: 1n, next_charge: 1700000120n,
    }),
    make("pause_changed", "tx-3", { paused: true }),
    make("pause_changed", "tx-4", { paused: false }),
    make("cancelled", "tx-5"),
    make("mandate_ended", "tx-6"),
    make("mandate_completed", "tx-7"),
  ];
  try {
    for (const event of events) assert.equal(indexer.apply(event), "applied");
    const before = db.prepare("SELECT * FROM mandate_timeline ORDER BY ledger, tx_hash, kind").all();
    assert.equal(before.length, 7);
    for (const event of events) assert.equal(indexer.apply(event), "applied");
    assert.deepEqual(db.prepare("SELECT * FROM mandate_timeline ORDER BY ledger, tx_hash, kind").all(), before);
    assert.deepEqual(before.map(row => row.kind), events.map(e => e.name));
    const charged = before.find(row => row.kind === "charged");
    assert.equal(JSON.parse(String(charged?.details)).amount, "9999999999999999999");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mandate_events").get() as { n: number }).n, 2);

    const app = express();
    app.use("/api", mandatesRouter(db, {} as TokenMetadataService));
    const server = app.listen(0);
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      const response = await fetch(base + "/api/mandates/1/timeline");
      assert.equal(response.status, 200);
      const body = await response.json() as { events: Array<{ kind: string; details: Record<string, unknown>; ledger: number }> };
      assert.deepEqual(body.events.map(e => e.kind), events.map(e => e.name));
      assert.equal(body.events[1]?.details.amount, "9999999999999999999");
      assert.ok(body.events.every(e => e.ledger === 100));
      assert.equal((await fetch(base + "/api/mandates/999/timeline")).status, 404);
      assert.equal((await fetch(base + "/api/mandates/invalid/timeline")).status, 400);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  } finally {
    db.close();
  }
});
