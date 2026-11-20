import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { rawEventsRouter } from "../src/routes/events.ts";
import { asStorage } from "../src/lib/store/index.ts";
import type { SqlParameters, Storage } from "../src/lib/store/types.ts";

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
  app.use("/api", rawEventsRouter(asStorage(db)));
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

test("a page without a name filter reads one page plus one row, with the same pages as before", async () => {
  const db = openDatabase(":memory:");
  const insert = db.prepare(`INSERT INTO events
    (event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const topics = JSON.stringify([nativeToScVal("charged", { type: "symbol" }).toXDR("base64")]);
  const data = nativeToScVal(1n, { type: "i128" }).toXDR("base64");
  // 100 events of contract-a, then 50 of contract-b: each feed ends on an
  // exact page boundary, where `next` must still come back null.
  for (let i = 0; i < 150; i++) {
    const id = String(i).padStart(4, "0");
    insert.run(id, i < 100 ? "contract-a" : "contract-b", 10 + i, "tx-" + id, id, topics, data, 1700000000);
  }
  const storage = asStorage(db);
  const limits: unknown[] = [];
  // Record the LIMIT (the last parameter) of every feed query.
  const recording: Storage = {
    dialect: storage.dialect,
    all: <Row>(sql: string, parameters: SqlParameters = []) => {
      limits.push(parameters.at(-1));
      return storage.all<Row>(sql, parameters);
    },
    get: (sql, parameters) => storage.get(sql, parameters),
    run: (sql, parameters) => storage.run(sql, parameters),
    transaction: (work) => storage.transaction(work),
    close: () => storage.close(),
  };
  const app = express();
  app.use("/api", rawEventsRouter(recording));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const read = async (query: string) =>
      (await (await fetch(base + "/api/events" + query)).json()) as {
        events: Array<{ index: string }>;
        next: string | null;
      };
    const pages = async (query: string) => {
      const sizes: number[] = [];
      let body = await read(query);
      sizes.push(body.events.length);
      while (body.next !== null) {
        body = await read((query ? query + "&" : "?") + "after=" + encodeURIComponent(body.next));
        sizes.push(body.events.length);
      }
      return sizes;
    };

    limits.length = 0;
    assert.deepEqual(await pages(""), [50, 50, 50]);
    assert.deepEqual(limits, [51, 51, 51], "one bounded read per page");

    limits.length = 0;
    assert.deepEqual(await pages("?contract=contract-a"), [50, 50]);
    assert.deepEqual(await pages("?contract=contract-b"), [50]);
    assert.deepEqual(new Set(limits), new Set([51]));

    // The name filter decodes topics in SQL-unfiltered batches, as before.
    limits.length = 0;
    assert.deepEqual(await pages("?name=charged"), [50, 50, 50]);
    assert.deepEqual(new Set(limits), new Set([200]));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    db.close();
  }
});
