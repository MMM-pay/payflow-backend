import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeToScVal, type rpc } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { Indexer, type IndexerRpc } from "../src/indexer.ts";
import type { NetworkConfig } from "../src/config.ts";

const merchant = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const config: NetworkConfig = {
  name: "testnet",
  rpcUrl: "https://rpc.invalid",
  networkPassphrase: "Test SDF Network ; September 2015",
  planRegistryId: contract,
  vaultId: contract,
  subscriptionId: contract,
  startLedger: 1,
  databasePath: ":memory:",
};

function event(name: string, id: string): rpc.Api.EventResponse {
  return {
    id,
    ledger: 2,
    txHash: id,
    contractId: contract,
    topic: [
      nativeToScVal(name, { type: "symbol" }),
      nativeToScVal(merchant, { type: "address" }),
      nativeToScVal(1n, { type: "u64" }),
    ],
    value: nativeToScVal({
      token: contract, amount: 999999999999999999999n, period: 60n, name: "Plan",
    }, {
      type: {
        token: ["symbol", "address"],
        amount: ["symbol", "i128"],
        period: ["symbol", "u64"],
        name: ["symbol", "string"],
      },
    }),
    ledgerClosedAt: "2026-10-21T10:00:00Z",
  } as unknown as rpc.Api.EventResponse;
}

test("all raw events survive overlapping windows; rebuild restores identical projections offline", async () => {
  const db = openDatabase(":memory:");
  try {
    const history = [event("plan_created", "0002-0001"), event("future_event", "0002-0002")];
    const rpcStub = {
      getLatestLedger: async () => ({ sequence: 4 }),
      getHealth: async () => ({ oldestLedger: 1 }),
      getEvents: async () => ({ events: history, cursor: undefined }),
    } as unknown as IndexerRpc;
    const indexer = new Indexer(db, rpcStub, config);
    await indexer.tick();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 2);
    const original = db.prepare("SELECT * FROM plans").all();
    assert.equal(original.length, 1);
    assert.equal(original[0]?.amount, "999999999999999999999");
    assert.equal(db.prepare("SELECT * FROM events WHERE event_id = ?").get("0002-0002")?.tx_hash, "0002-0002");
    // The next pass can replay the same ledger range without duplicating raw rows.
    db.prepare("DELETE FROM cursor").run();
    await indexer.tick();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 2);
    db.prepare("DELETE FROM plans").run();
    assert.equal(indexer.rebuildProjections(), 1);
    assert.deepEqual(db.prepare("SELECT * FROM plans").all(), original);
    assert.equal(indexer.rebuildProjections(), 1);
    assert.deepEqual(db.prepare("SELECT * FROM plans").all(), original);
  } finally {
    db.close();
  }
});
