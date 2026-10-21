import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { rawEventsRouter } from "../src/routes/events.ts";

test("raw event feed filters, pages without duplicates, and validates cursors", async () => {
  const db = openDatabase(":memory:");
  const insert = db.prepare(`INSERT INTO events
    (event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const encoded = (name: string) => JSON.stringify([nativeToScVal(name, { type: "symbol" }).toXDR("base64")]);
  for (let i = 0; i < 120; i++) {
    const id = String(i).padStart(4, "0");
    insert.run(id, i % 2 === 0 ? "contract-a" : "contract-b",
      10 + Math.floor(i / 10), "tx-" + id, id,
      encoded(i % 3 === 0 ? "charged" : "future_event"),
      nativeToScVal(900719925474099300000n, { type: "i128" }).toXDR("base64"), 1700000000);
  }
  const app = express();
  app.use("/api", rawEventsRouter(db));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const read = async (query: string) => {
      const response = await fetch(base + "/api/events" + query);
      return { status: response.status, body: await response.json() as {
        events: Array<{ ledger: number; index: string; name: string | null; data: string; contract: string }>;
        next: string | null;
      } };
    };
    const first = await read("");
    assert.equal(first.status, 200);
    assert.equal(first.body.events.length, 50);
    assert.ok(first.body.next);
    const second = await read("?after=" + encodeURIComponent(first.body.next!));
    assert.equal(second.body.events.length, 50);
    assert.equal(new Set([...first.body.events, ...second.body.events].map(e => e.index)).size, 100);
    const third = await read("?after=" + encodeURIComponent(second.body.next!));
    assert.equal(third.body.events.length, 20);
    assert.equal(third.body.next, null);

    const filtered = await read("?contract=contract-a&name=charged");
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.events.length, 20);
    assert.ok(filtered.body.events.every(e => e.contract === "contract-a" && e.name === "charged"));
    assert.equal(filtered.body.events[0]?.data,
      nativeToScVal(900719925474099300000n, { type: "i128" }).toXDR("base64"));
    assert.equal((await read("?after=not-a-cursor")).status, 400);
    assert.equal((await read("?contract[]=bad")).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    db.close();
  }
});
