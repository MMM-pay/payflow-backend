import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/lib/db.ts";
import { seedDatabase } from "../src/cmd/seed.ts";
import type { NetworkConfig } from "../src/config.ts";

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

function projections(db: ReturnType<typeof openDatabase>): string {
  return JSON.stringify(
    [
      db.prepare("SELECT * FROM plans ORDER BY rowid").all(),
      db.prepare("SELECT * FROM merchant_profiles ORDER BY rowid").all(),
      db.prepare("SELECT * FROM mandates ORDER BY rowid").all(),
      db.prepare("SELECT * FROM charges ORDER BY rowid").all(),
      db.prepare("SELECT * FROM vault_events ORDER BY rowid").all(),
      db.prepare("SELECT * FROM mandate_events ORDER BY rowid").all(),
      db.prepare("SELECT * FROM mandate_timeline ORDER BY rowid").all(),
    ],
  );
}

test("seed data is realistic and idempotent across replays", () => {
  const db = openDatabase(":memory:");
  try {
    const eventsApplied = seedDatabase(db, testnet, undefined, 1_800_000_000);
    const first = projections(db);

    assert.ok(eventsApplied > 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM plans").get() as { count: number }).count, 4);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM mandates").get() as { count: number }).count, 5);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM charges").get() as { count: number }).count, 8);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM vault_events").get() as { count: number }).count, 5);

    seedDatabase(db, testnet, undefined, 1_800_100_000);
    assert.equal(projections(db), first);
  } finally {
    db.close();
  }
});

test("seed refuses a populated production-network database without changing it", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare(
      "INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger) VALUES (1, 'merchant', 'live plan', 'token', '500', 30, 1, 100)",
    ).run();
    const before = db.prepare("SELECT * FROM plans").all();

    assert.throws(() => seedDatabase(db, testnet), /non-empty database/);
    assert.deepEqual(db.prepare("SELECT * FROM plans").all(), before);

    const mainnet = {
      ...testnet,
      name: "mainnet",
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    };

    assert.throws(() => seedDatabase(db, mainnet), /Refusing to seed a production network database/);
    assert.deepEqual(db.prepare("SELECT * FROM plans").all(), before);
  } finally {
    db.close();
  }
});