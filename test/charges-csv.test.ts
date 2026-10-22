import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import type { Config } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import { tokenUnits } from "../src/routes/merchants.ts";
import { testAddress } from "./addresses.ts";

const MERCHANT = testAddress(40);
const OTHER_MERCHANT = testAddress(41);
const SUBSCRIBER = testAddress(42);
const config = { CORS_ORIGIN: "*" } as unknown as Config;

/** 2025-03-10T12:00:00Z and the next day. */
const MAR_MID = Math.floor(Date.UTC(2025, 2, 10, 12, 0, 0) / 1000);
const MAR_NEXT = MAR_MID + 86_400;

const db = openDatabase(":memory:");
let server: Server;
let base = "";

const charged = (
  mandate: bigint,
  merchant: string,
  amount: bigint,
  fee: bigint,
  tx: string,
  closeTime: number,
): DecodedEvent => ({
  name: "charged",
  contractId: "C",
  ledger: 1,
  txHash: tx,
  topics: [mandate, SUBSCRIBER, merchant],
  data: { amount, fee, charges_made: 1n, next_charge: 4_000_000_000n },
  closeTime,
});

before(async () => {
  const ix = new Indexer(db, {} as never, {} as never);
  // The subscriber pays 10_000_000, the protocol keeps 100_000 and the
  // merchant 9_900_000.
  ix.apply(charged(1n, MERCHANT, 9_900_000n, 100_000n, "tx-a", MAR_MID));
  // Amounts beyond 2^53 must come through exactly.
  ix.apply(charged(2n, MERCHANT, 9_007_199_254_740_993n, 7n, "tx-b", MAR_NEXT));
  // Replaying a charge is a no-op, so it appears once.
  ix.apply(charged(1n, MERCHANT, 9_900_000n, 100_000n, "tx-a", MAR_MID));
  ix.apply(charged(3n, OTHER_MERCHANT, 1n, 0n, "tx-c", MAR_MID));

  const app = createApp(db, config);
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

describe("GET /api/merchants/:address/charges.csv", () => {
  test("is a CSV download with a header row and one row per charge", async () => {
    const res = await fetch(`${base}/api/merchants/${MERCHANT}/charges.csv`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/csv/);
    assert.equal(
      res.headers.get("content-disposition"),
      `attachment; filename="payflow-charges-${MERCHANT}.csv"`,
    );
    const lines = (await res.text()).split("\r\n");
    assert.deepEqual(lines, [
      "date,mandate,subscriber,gross,fee,net,tx_hash",
      `2025-03-10T12:00:00.000Z,1,${SUBSCRIBER},1.0000000,0.0100000,0.9900000,tx-a`,
      `2025-03-11T12:00:00.000Z,2,${SUBSCRIBER},900719925.4741000,0.0000007,900719925.4740993,tx-b`,
      "",
    ]);
  });

  test("from/to bound the range, half-open", async () => {
    const res = await fetch(`${base}/api/merchants/${MERCHANT}/charges.csv?from=${MAR_MID}&to=${MAR_NEXT}`);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /,tx-a$/);
  });

  test("a merchant with no charges gets just the header", async () => {
    const res = await fetch(`${base}/api/merchants/${testAddress(43)}/charges.csv`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "date,mandate,subscriber,gross,fee,net,tx_hash\r\n");
  });

  test("an invalid address is a 400, not a CSV", async () => {
    const res = await fetch(`${base}/api/merchants/nope/charges.csv`);
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /json/);
  });

  test("streams across pages", async () => {
    const big = openDatabase(":memory:");
    const ix = new Indexer(big, {} as never, {} as never);
    for (let i = 0; i < 1_234; i += 1) {
      ix.apply(charged(BigInt(i + 1), MERCHANT, 10n, 0n, `tx-${i}`, MAR_MID + i));
    }
    const app = createApp(big, config);
    const s = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    try {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const lines = (await (await fetch(`http://127.0.0.1:${port}/api/merchants/${MERCHANT}/charges.csv`)).text())
        .trim()
        .split("\r\n");
      assert.equal(lines.length, 1 + 1_234);
      assert.equal(new Set(lines).size, lines.length, "no row repeats at a page boundary");
    } finally {
      s.close();
      big.close();
    }
  });
});

describe("tokenUnits", () => {
  test("formats smallest units with seven decimals", () => {
    assert.equal(tokenUnits(0n), "0.0000000");
    assert.equal(tokenUnits(1n), "0.0000001");
    assert.equal(tokenUnits(12_500_000n), "1.2500000");
    assert.equal(tokenUnits(-5n), "-0.0000005");
  });
});
