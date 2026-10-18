import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "../src/lib/db.ts";
import { Indexer } from "../src/indexer.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function db() {
  return openDatabase(":memory:");
}

/** Indexer with no RPC: `apply` is pure and needs no network. */
function indexer(database: ReturnType<typeof db>) {
  return new Indexer(database, {} as never, {} as never);
}

function event(name: string, topics: unknown[], data: Record<string, unknown>): DecodedEvent {
  return { name, contractId: "C", ledger: 100, txHash: "tx-" + name, topics, data };
}

const planCreated = event("plan_created", [MERCHANT, 1n], {
  token: TOKEN,
  amount: 10_000_000n,
  period: 2_592_000n,
  name: "Pro Monthly",
});

const subscribed = event("subscribed", [1n, SUBSCRIBER, MERCHANT], {
  plan_id: 1n,
  amount: 10_000_000n,
  period: 2_592_000n,
  next_charge: 1_700_000_000n,
  max_charges: 0,
  fee_bps: 100,
});

function charged(chargesMade: number, nextCharge: number, txHash: string): DecodedEvent {
  return {
    ...event("charged", [1n, SUBSCRIBER, MERCHANT], {
      amount: 9_900_000n,
      fee: 100_000n,
      charges_made: BigInt(chargesMade),
      next_charge: BigInt(nextCharge),
    }),
    txHash,
  };
}

describe("indexer projections", () => {
  let d: ReturnType<typeof db>;
  let ix: Indexer;

  beforeEach(() => {
    d = db();
    ix = indexer(d);
  });

  test("projects a created plan", () => {
    ix.apply(planCreated);
    const row = d.prepare("SELECT * FROM plans WHERE id = 1").get() as Record<string, unknown>;
    assert.equal(row.merchant, MERCHANT);
    assert.equal(row.amount, "10000000");
    assert.equal(row.period, 2_592_000);
    assert.equal(row.active, 1);
    assert.equal(row.name, "Pro Monthly");
  });

  test("projects a plan with no name as an empty label", () => {
    // The contract allows an empty name; the UI falls back to the plan number.
    ix.apply(event("plan_created", [MERCHANT, 2n], {
      token: TOKEN,
      amount: 1n,
      period: 60n,
      name: "",
    }));
    const row = d.prepare("SELECT name FROM plans WHERE id = 2").get() as Record<string, unknown>;
    assert.equal(row.name, "");
  });

  test("projects the fee rate frozen into a mandate", () => {
    ix.apply(subscribed);
    const row = d.prepare("SELECT fee_bps FROM mandates WHERE id = 1").get() as Record<
      string,
      unknown
    >;
    assert.equal(row.fee_bps, 100);
  });

  test("deactivating a plan flips the flag", () => {
    ix.apply(planCreated);
    ix.apply(event("plan_status_changed", [MERCHANT, 1n], { active: false }));
    const row = d.prepare("SELECT active FROM plans WHERE id = 1").get() as { active: number };
    assert.equal(row.active, 0);
  });

  test("records the spend cap from the subscribe event", () => {
    ix.apply(
      event("subscribed", [2n, SUBSCRIBER, MERCHANT], {
        plan_id: 1n,
        amount: 10_000_000n,
        period: 2_592_000n,
        next_charge: 1_700_000_000n,
        max_charges: 3,
      }),
    );
    const row = d.prepare("SELECT max_charges FROM mandates WHERE id = 2").get() as {
      max_charges: number;
    };
    assert.equal(
      row.max_charges,
      3,
      "a capped mandate must not be projected as open-ended",
    );
  });

  test("projects a mandate on subscribe", () => {
    ix.apply(subscribed);
    const row = d.prepare("SELECT * FROM mandates WHERE id = 1").get() as Record<string, unknown>;
    assert.equal(row.subscriber, SUBSCRIBER);
    assert.equal(row.merchant, MERCHANT);
    assert.equal(row.status, "Active");
    assert.equal(row.charges_made, 0);
  });

  test("a charge appends history and advances the mandate", () => {
    ix.apply(subscribed);
    ix.apply(charged(1, 1_700_060_000, "tx-a"));

    const mandate = d.prepare("SELECT * FROM mandates WHERE id = 1").get() as Record<string, unknown>;
    assert.equal(mandate.charges_made, 1);
    assert.equal(mandate.next_charge, 1_700_060_000);

    const rows = d.prepare("SELECT * FROM charges WHERE mandate_id = 1").all();
    assert.equal(rows.length, 1);
  });

  test("last_charge is derived from next_charge minus the period", () => {
    ix.apply(subscribed);
    ix.apply(charged(1, 1_700_060_000, "tx-a"));

    const row = d.prepare("SELECT last_charge, next_charge, period FROM mandates WHERE id = 1").get() as {
      last_charge: number;
      next_charge: number;
      period: number;
    };
    assert.equal(row.next_charge, 1_700_060_000);
    assert.equal(
      row.last_charge,
      1_700_060_000 - row.period,
      "last_charge must be the settlement time, not a copy of next_charge",
    );
    assert.ok(row.last_charge < row.next_charge);
  });

  test("replaying the same charge is idempotent", () => {
    ix.apply(subscribed);
    ix.apply(charged(1, 1_700_060_000, "tx-a"));
    ix.apply(charged(1, 1_700_060_000, "tx-a"));

    const rows = d.prepare("SELECT * FROM charges WHERE mandate_id = 1").all();
    assert.equal(rows.length, 1, "duplicate tx must not double-count revenue");

    const mandate = d.prepare("SELECT charges_made FROM mandates WHERE id = 1").get() as {
      charges_made: number;
    };
    assert.equal(mandate.charges_made, 1);
  });

  test("out-of-order charges never move a mandate backwards", () => {
    ix.apply(subscribed);
    ix.apply(charged(2, 1_700_120_000, "tx-b"));
    ix.apply(charged(1, 1_700_060_000, "tx-a")); // stale, arrives late

    const mandate = d.prepare("SELECT * FROM mandates WHERE id = 1").get() as Record<string, unknown>;
    assert.equal(mandate.charges_made, 2);
    assert.equal(mandate.next_charge, 1_700_120_000);
  });

  test("cancel and completion set terminal status", () => {
    ix.apply(subscribed);
    ix.apply(event("cancelled", [1n, SUBSCRIBER], { charges_made: 1n }));
    let row = d.prepare("SELECT status FROM mandates WHERE id = 1").get() as { status: string };
    assert.equal(row.status, "Cancelled");

    ix.apply(event("mandate_completed", [1n, SUBSCRIBER], { charges_made: 3n }));
    row = d.prepare("SELECT status FROM mandates WHERE id = 1").get() as { status: string };
    assert.equal(row.status, "Completed");
  });

  test("a merchant ending a mandate cancels it and records who ended it", () => {
    ix.apply(subscribed);
    ix.apply(event("mandate_ended", [1n, MERCHANT], { subscriber: SUBSCRIBER, charges_made: 0 }));
    const row = d.prepare("SELECT status, ended_by FROM mandates WHERE id = 1").get() as Record<string, unknown>;
    assert.equal(row.status, "Cancelled");
    assert.equal(row.ended_by, "merchant");
  });

  test("a subscriber cancel records the subscriber as the one who ended it", () => {
    ix.apply(subscribed);
    ix.apply(event("cancelled", [1n, SUBSCRIBER], { charges_made: 0 }));
    const row = d.prepare("SELECT status, ended_by FROM mandates WHERE id = 1").get() as Record<string, unknown>;
    assert.equal(row.status, "Cancelled");
    assert.equal(row.ended_by, "subscriber");
  });

  test("pause toggles only from active states", () => {
    ix.apply(subscribed);
    ix.apply(event("pause_changed", [1n, SUBSCRIBER], { paused: true }));
    assert.equal(
      (d.prepare("SELECT status FROM mandates WHERE id = 1").get() as { status: string }).status,
      "Paused",
    );

    ix.apply(event("cancelled", [1n, SUBSCRIBER], { charges_made: 1n }));
    ix.apply(event("pause_changed", [1n, SUBSCRIBER], { paused: false }));
    assert.equal(
      (d.prepare("SELECT status FROM mandates WHERE id = 1").get() as { status: string }).status,
      "Cancelled",
      "a cancelled mandate must not be resurrected by a pause event",
    );
  });

  test("vault events are recorded", () => {
    ix.apply(
      event("deposit", [SUBSCRIBER, TOKEN], { amount: 50_000_000n, balance: 50_000_000n }),
    );
    const rows = d.prepare("SELECT * FROM vault_events").all() as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "deposit");
    assert.equal(rows[0]!.balance, "50000000");
  });

  test("unknown events are ignored", () => {
    ix.apply(event("some_future_event", [], { x: 1n }));
    const rows = d.prepare("SELECT * FROM mandates").all();
    assert.equal(rows.length, 0);
  });
});

describe("schema migration", () => {
  test("adds columns to a database created before they existed", () => {
    // Reproduce the pre-migration shape, which is what a deployed indexer
    // already has on disk: CREATE TABLE IF NOT EXISTS would skip it silently.
    const raw = new DatabaseSync(":memory:");
    raw.exec(`CREATE TABLE plans (
      id INTEGER PRIMARY KEY, merchant TEXT NOT NULL, token TEXT NOT NULL,
      amount TEXT NOT NULL, period INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, ledger INTEGER NOT NULL)`);
    raw.exec("INSERT INTO plans VALUES (7, 'M', 'T', '100', 60, 1, 1)");

    migrate(raw);

    const row = raw.prepare("SELECT * FROM plans WHERE id = 7").get() as Record<string, unknown>;
    assert.equal(row.name, "", "existing rows get the default, not null");
    assert.equal(row.amount, "100", "existing data survives");

    // Running it again must be a no-op rather than an error.
    migrate(raw);
    assert.equal(
      (raw.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n,
      1,
    );
  });
});

describe("runtime pause and resume", () => {
  /** A fake RPC that records whether any pass actually reached the network. */
  function fakeRpc() {
    const calls = { latest: 0, health: 0, events: 0 };
    const server = {
      getLatestLedger: async () => {
        calls.latest += 1;
        return { sequence: 2_000 };
      },
      getHealth: async () => {
        calls.health += 1;
        return { oldestLedger: 1 };
      },
      getEvents: async () => {
        calls.events += 1;
        return [];
      },
    };
    return { server, calls };
  }

  test("a paused tick reads nothing and advances nothing", async () => {
    const d = db();
    const { server, calls } = fakeRpc();
    const ix = new Indexer(d, server as never, { startLedger: 1_500 } as never);
    ix.status.cursor = 1_500;
    ix.status.latest = 1_600;
    ix.pause();
    assert.equal(ix.status.paused, true);

    const r = await ix.tick();
    assert.deepEqual(r, { applied: 0, mismatched: 0, cursor: 1_500, latest: 1_600 });
    assert.equal(calls.latest, 0, "no RPC while paused");
    assert.equal(calls.health, 0);
    assert.equal(calls.events, 0);
    assert.equal(ix.status.cursor, 1_500, "cursor preserved while paused");
    d.close();
  });

  test("resume lets passes run again", async () => {
    const d = db();
    const { server, calls } = fakeRpc();
    const ix = new Indexer(d, server as never, { startLedger: 1_500 } as never);
    ix.pause();
    ix.resume();
    assert.equal(ix.status.paused, false);
    await ix.tick();
    assert.ok(calls.latest >= 1, "the network is read again after resume");
    d.close();
  });
});
