import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
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

  test("fee changes are projected once and preserve the latest rate", () => {
    const changed = event("fee_changed", [MERCHANT], {
      old_fee_bps: 100n,
      new_fee_bps: 125n,
    });
    ix.apply(changed);
    ix.apply(changed);
    ix.apply({
      ...changed,
      txHash: "tx-fee-2",
      ledger: 101,
      data: { old_fee_bps: 125n, new_fee_bps: 150n },
    });

    const history = d
      .prepare("SELECT tx_hash, old_fee_bps, new_fee_bps FROM fee_history ORDER BY ledger DESC")
      .all() as { tx_hash: string; old_fee_bps: number; new_fee_bps: number }[];
    assert.deepEqual(history.map((row) => ({ ...row })), [
      { tx_hash: "tx-fee-2", old_fee_bps: 125, new_fee_bps: 150 },
      { tx_hash: "tx-fee_changed", old_fee_bps: 100, new_fee_bps: 125 },
    ]);
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

  test("emits a live event only after its projection has been applied", () => {
    const received: DecodedEvent[] = [];
    ix.events.on("applied", (e: DecodedEvent) => received.push(e));

    ix.apply(subscribed);
    ix.apply(charged(1, 1_700_060_000, "tx-live"));
    ix.apply(event("some_future_event", [], { x: 1n }));

    assert.deepEqual(received.map((e) => e.name), ["subscribed", "charged"]);
    assert.equal(
      (d.prepare("SELECT charges_made FROM mandates WHERE id = 1").get() as { charges_made: number })
        .charges_made,
      1,
    );
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

  test("a charge is stamped with the ledger close time, not the indexer's clock", () => {
    // 2025-01-15T12:00:00Z: the chain's clock, long before this test runs.
    const at = Math.floor(Date.UTC(2025, 0, 15, 12) / 1000);
    ix.apply(subscribed);
    ix.apply({ ...charged(1, 1_700_060_000, "tx-close"), closeTime: at });

    const row = d.prepare("SELECT created_at FROM charges WHERE tx_hash = ?").get("tx-close") as {
      created_at: number;
    };
    assert.equal(row.created_at, at * 1000);
    assert.notEqual(
      row.created_at,
      Date.now(),
      "a backfill must not stamp a charge with the moment it was indexed",
    );
  });

  test("replaying a charge leaves its timestamp unchanged", () => {
    const at = Math.floor(Date.UTC(2025, 0, 15, 12) / 1000);
    ix.apply(subscribed);
    ix.apply({ ...charged(1, 1_700_060_000, "tx-replay"), closeTime: at });
    const first = (
      d.prepare("SELECT created_at FROM charges WHERE tx_hash = ?").get("tx-replay") as {
        created_at: number;
      }
    ).created_at;

    // The same ledger, applied again as a crashed pass would.
    ix.apply({ ...charged(1, 1_700_060_000, "tx-replay"), closeTime: at });
    const second = (
      d.prepare("SELECT created_at FROM charges WHERE tx_hash = ?").get("tx-replay") as {
        created_at: number;
      }
    ).created_at;

    assert.equal(second, first);
    assert.equal(second, at * 1000);
  });

  test("a charge with no close time falls back to the indexer's clock", () => {
    // The RPC did not report a close time, so there is no chain clock to use.
    // The fallback is the indexer's wall clock, which is logged: it is the one
    // value a re-index cannot reproduce.
    const before = Date.now();
    ix.apply(subscribed);
    ix.apply(charged(1, 1_700_060_000, "tx-no-close"));

    const row = d.prepare("SELECT created_at FROM charges WHERE tx_hash = ?").get("tx-no-close") as {
      created_at: number;
    };
    assert.ok(row.created_at >= before && row.created_at <= Date.now());
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

  test("a lifecycle event is logged with the ledger close time", () => {
    const at = Math.floor(Date.UTC(2025, 0, 15, 12) / 1000);
    ix.apply({ ...subscribed, closeTime: at });
    ix.apply({ ...event("cancelled", [1n, SUBSCRIBER], { charges_made: 0 }), closeTime: at + 60 });

    const rows = d
      .prepare("SELECT mandate_id, slot, merchant, kind, at FROM mandate_events ORDER BY at")
      .all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.mandate_id, 1);
    assert.equal(rows[0]!.slot, "start");
    assert.equal(rows[0]!.merchant, MERCHANT);
    assert.equal(rows[0]!.kind, "started");
    assert.equal(rows[0]!.at, at);
    assert.equal(rows[1]!.mandate_id, 1);
    assert.equal(rows[1]!.slot, "departure");
    assert.equal(rows[1]!.merchant, MERCHANT);
    assert.equal(rows[1]!.kind, "cancelled");
    assert.equal(rows[1]!.at, at + 60);
  });

  test("replaying an event does not log it twice", () => {
    const at = Math.floor(Date.UTC(2025, 0, 15, 12) / 1000);
    const sub = { ...subscribed, closeTime: at };
    const cancel = { ...event("cancelled", [1n, SUBSCRIBER], { charges_made: 0 }), closeTime: at + 60 };
    ix.apply(sub);
    ix.apply(cancel);
    ix.apply(sub);
    ix.apply(cancel);
    ix.apply(cancel);

    const count = (
      d.prepare("SELECT COUNT(*) AS n FROM mandate_events").get() as { n: number }
    ).n;
    assert.equal(count, 2, "one start and one departure, however often they arrive");
  });

  test("a mandate is counted as leaving at most once", () => {
    const at = Math.floor(Date.UTC(2025, 0, 15, 12) / 1000);
    ix.apply({ ...subscribed, closeTime: at });
    ix.apply({ ...event("cancelled", [1n, SUBSCRIBER], { charges_made: 0 }), closeTime: at + 60 });
    // A second, different departure for the same mandate: the log keeps the
    // first, so a mandate can never be counted as leaving twice.
    ix.apply({
      ...event("mandate_ended", [1n, MERCHANT], { subscriber: SUBSCRIBER, charges_made: 1 }),
      closeTime: at + 120,
    });

    const rows = d
      .prepare("SELECT kind FROM mandate_events WHERE slot = 'departure'")
      .all() as Array<{ kind: string }>;
    assert.deepEqual(rows.map((r) => r.kind), ["cancelled"]);
  });

  test("an event with no ledger close time is not logged", () => {
    // No close time means no bucket to file the event under, so it is
    // skipped rather than filed under a guessed time.
    ix.apply(subscribed);
    ix.apply(event("cancelled", [1n, SUBSCRIBER], { charges_made: 0 }));
    const count = (
      d.prepare("SELECT COUNT(*) AS n FROM mandate_events").get() as { n: number }
    ).n;
    assert.equal(count, 0);
    // The projection itself is still written.
    const row = d.prepare("SELECT status FROM mandates WHERE id = 1").get() as { status: string };
    assert.equal(row.status, "Cancelled");
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
    const deposit = event("deposit", [SUBSCRIBER, TOKEN], {
      amount: 50_000_000n,
      balance: 50_000_000n,
    });
    ix.apply(deposit);
    ix.apply(deposit);
    const rows = d.prepare("SELECT * FROM vault_events").all() as Record<string, unknown>[];
    assert.equal(rows.length, 1, "replaying the event cannot duplicate history");
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

/**
 * The projection under random orderings.
 *
 * The indexer consumes events in ledger order and the cursor only moves
 * after a whole window has been applied, so a pass that dies replays the
 * window it was applying: the same events arrive again, and a range that
 * overlaps the previous one delivers some of them a third time. None of
 * that may change the projection.
 *
 * These tests generate a random history, apply it in ledger order, and
 * then apply the same history again as a shuffled, repeated replay. The
 * projection has to come out the same either way.
 *
 * ### What the shuffle keeps, and why
 *
 * The chain orders events by ledger, and an event that updates a row is
 * always in a later ledger than the event that created that row. A replay
 * therefore keeps two things: the order of the events that touch one row,
 * and a row's creation ahead of its updates. Everything else is free —
 * the events of different mandates, plans and vault rows interleave
 * however the RPC pages them.
 *
 * A permutation that breaks those rules is not one the chain can produce,
 * and the projection is not built to survive it: an update that arrives
 * before the row it updates finds nothing to update, and a pause that
 * arrives after the unpause that followed it wins. Both are pinned down by
 * their own tests below, so what this file relies on is written down
 * rather than assumed.
 * ### Why the events are hand-built
 *
 * `apply` is the whole projection: it takes a decoded event and writes the
 * database. Building the events here — rather than driving the indexer
 * through a fake RPC — keeps the test off the network, keeps the event
 * sequence exactly under the test's control, and keeps the seeds
 * reproducible. The decoder and the RPC windowing are covered elsewhere
 * (`test/replay.test.ts` replays recorded events, `test/sync.test.ts` drives
 * the fetch loop).
 */

/**
 * A small deterministic pseudo-random generator.
 *
 * `Math.random` cannot be used here: a failing run has to be
 * reproducible, so the seed is part of the test and the whole sequence is
 * derived from it alone.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic account address for a role, so a seed reproduces exactly. */
function accountFor(seed: number, role: string, n: number): string {
  return Keypair.fromRawEd25519Seed(
    createHash("sha256").update(`${seed}:${role}:${n}`).digest(),
  ).publicKey();
}

/** A deterministic contract address for a role. */
function contractFor(role: string, n: number): string {
  return StrKey.encodeContract(createHash("sha256").update(`contract:${role}:${n}`).digest());
}

/** A generated event, and the row it belongs to. */
interface Generated {
  event: DecodedEvent;
  /**
   * The row the event creates or updates. The events of one row keep their
   * order in a replay; the events of different rows interleave freely.
   */
  entity: string;
}

/**
 * A random history of the protocol's events.
 *
 * The sequence comes from the seed alone: the same seed always produces
 * the same history, the same addresses and the same amounts.
 */
function generateHistory(seed: number): Generated[] {
  const rnd = mulberry32(seed);
  const int = (max: number): number => Math.floor(rnd() * max);
  const events: Generated[] = [];
  let ledger = 1_000;
  let clock = 1_700_000_000;

  /** The next ledger and its close time, advancing both. */
  const next = (): { ledger: number; closeTime: number } => {
    ledger += 1 + int(4);
    clock += 60 + int(900);
    return { ledger, closeTime: clock };
  };

  const token = contractFor("token", 0);
  const registry = contractFor("plan_registry", 0);
  const subscription = contractFor("subscription", 0);
  const vault = contractFor("vault", 0);

  // Plans, and the merchants who own them.
  const plans: Array<{ id: number; merchant: string }> = [];
  const merchantCount = 2 + int(3);
  for (let mi = 0; mi < merchantCount; mi += 1) {
    const merchant = accountFor(seed, "merchant", mi);
    const planCount = 1 + int(2);
    for (let pi = 0; pi < planCount; pi += 1) {
      const id = plans.length + 1;
      plans.push({ id, merchant });
      const entity = `plan:${id}`;
      const created = next();
      events.push({
        entity,
        event: {
          name: "plan_created",
          contractId: registry,
          ledger: created.ledger,
          txHash: `tx-plan-${id}`,
          // The chain's clock, not the indexer's: a charge stamped with the
          // moment it was indexed would differ between the two runs and the
          // projections could never be equal.
          closeTime: created.closeTime,
          topics: [merchant, BigInt(id)],
          data: {
            token,
            amount: 1_000_000n + BigInt(int(1_000_000)),
            period: 2_592_000n,
            name: `Plan ${id}`,
          },
        },
      });
      // A merchant may deactivate a plan and reactivate it later.
      for (let s = 0; s < int(3); s += 1) {
        const when = next();
        events.push({
          entity,
          event: {
            name: "plan_status_changed",
            contractId: registry,
            ledger: when.ledger,
            txHash: `tx-plan-status-${id}-${s}`,
            closeTime: when.closeTime,
            topics: [merchant, BigInt(id)],
            data: { active: s % 2 === 0 },
          },
        });
      }
    }
  }

  // Mandates: a subscriber takes a plan, and the contract charges it every
  // period until the cap.
  let mandateId = 0;
  for (const plan of plans) {
    for (let k = 0; k < 1 + int(3); k += 1) {
      mandateId += 1;
      const id = mandateId;
      const entity = `mandate:${id}`;
      const subscriber = accountFor(seed, "subscriber", id);
      const amount = 1_000_000n + BigInt(int(5_000_000));
      const period = 2_592_000n;
      const maxCharges = int(4) === 0 ? 0 : 1 + int(5);
      const feeBps = int(4) * 25;

      const started = next();
      events.push({
        entity,
        event: {
          name: "subscribed",
          contractId: subscription,
          ledger: started.ledger,
          txHash: `tx-subscribed-${id}`,
          closeTime: started.closeTime,
          topics: [BigInt(id), subscriber, plan.merchant],
          data: {
            plan_id: BigInt(plan.id),
            amount,
            period,
            next_charge: BigInt(started.closeTime),
            max_charges: maxCharges,
            fee_bps: feeBps,
          },
        },
      });

      const chargeCount =
        maxCharges > 0 ? int(maxCharges + 1) : int(4);
      let chargesMade = 0;
      let nextCharge = BigInt(started.closeTime);
      for (let c = 0; c < chargeCount; c += 1) {
        chargesMade += 1;
        nextCharge += period;
        const when = next();
        events.push({
          entity,
          event: {
            name: "charged",
            contractId: subscription,
            ledger: when.ledger,
            txHash: `tx-charged-${id}-${c}`,
            closeTime: when.closeTime,
            topics: [BigInt(id), subscriber, plan.merchant],
            data: {
              amount,
              // Money is a bigint all the way: a fee computed in floating
              // point would round.
              fee: (amount * BigInt(feeBps)) / 10_000n,
              charges_made: BigInt(chargesMade),
              next_charge: nextCharge,
            },
          },
        });
      }

      // A subscriber may pause a mandate and resume it.
      for (let p = 0; p < int(3); p += 1) {
        const when = next();
        events.push({
          entity,
          event: {
            name: "pause_changed",
            contractId: subscription,
            ledger: when.ledger,
            txHash: `tx-pause-${id}-${p}`,
            closeTime: when.closeTime,
            topics: [BigInt(id), subscriber],
            data: { paused: p % 2 === 0 },
          },
        });
      }

      // A mandate ends one way: the subscriber cancels, the merchant ends
      // it, or it completes itself once the cap is reached.
      const endings = ["cancelled", "mandate_ended"];
      if (maxCharges > 0 && chargesMade === maxCharges) endings.push("mandate_completed");
      if (int(3) === 0) {
        const kind = endings[int(endings.length)]!;
        const when = next();
        const endedByMerchant = kind === "mandate_ended";
        events.push({
          entity,
          event: {
            name: kind,
            contractId: subscription,
            ledger: when.ledger,
            txHash: `tx-${kind}-${id}`,
            closeTime: when.closeTime,
            topics: endedByMerchant
              ? [BigInt(id), plan.merchant]
              : [BigInt(id), subscriber],
            data: endedByMerchant
              ? { subscriber, charges_made: BigInt(chargesMade) }
              : { charges_made: BigInt(chargesMade) },
          },
        });
      }
    }
  }

  // The vault's own events: one row each.
  for (let v = 0; v < 2 + int(4); v += 1) {
    const kind = ["deposit", "withdraw", "debit"][int(3)]!;
    const when = next();
    events.push({
      entity: `vault:${v}`,
      event: {
        name: kind,
        contractId: vault,
        ledger: when.ledger,
        txHash: `tx-vault-${v}`,
        closeTime: when.closeTime,
        topics: [accountFor(seed, "subscriber", 1 + int(mandateId)), token, plans[0]!.merchant],
        data: {
          amount: 1_000n + BigInt(int(1_000_000)),
          balance: BigInt(int(1_000_000)),
        },
      },
    });
  }

  // The protocol's fee changes.
  for (let f = 0; f < int(3); f += 1) {
    const when = next();
    events.push({
      entity: `fee:${f}`,
      event: {
        name: "fee_changed",
        contractId: subscription,
        ledger: when.ledger,
        txHash: `tx-fee-${f}`,
        closeTime: when.closeTime,
        topics: [accountFor(seed, "merchant", int(merchantCount))],
        data: { old_fee_bps: BigInt(50 * f), new_fee_bps: BigInt(50 * f + 25) },
      },
    });
  }

  return events;
}

/**
 * A replay of the history: the same events, delivered again, in a random
 * order and with some of them repeated.
 *
 * The order of the events that touch one row is kept, because that is the
 * order the chain produced them in and the order a replay delivers them
 * in. A repeat of an event lands with that row's own history, which is
 * where an overlapping ledger range puts it.
 */
function replayOrder(events: Generated[], seed: number): DecodedEvent[] {
  const rnd = mulberry32(seed);
  const int = (max: number): number => Math.floor(rnd() * max);

  const queues = new Map<string, DecodedEvent[]>();
  for (const { event, entity } of events) {
    const queue = queues.get(entity);
    if (queue) queue.push(event);
    else queues.set(entity, [event]);
  }

  // Each event is delivered once, twice or three times.
  const ready: DecodedEvent[][] = [];
  for (const queue of queues.values()) {
    const repeated: DecodedEvent[] = [];
    for (const event of queue) {
      const original = repeated.length;
      repeated.push(event);
      for (let r = 0; r < int(3); r += 1) {
        // The repeat lands after the original and before the row's next
        // event: an overlapping range delivers the same event again a
        // moment later, and nothing else happened to that row in between.
        const spot = original + 1 + int(repeated.length - original);
        repeated.splice(spot, 0, event);
      }
    }
    ready.push(repeated);
  }

  // The rows interleave: the events of different mandates, plans and
  // vault rows arrive in whatever order the RPC pages them.
  const order: DecodedEvent[] = [];
  while (ready.length > 0) {
    const i = int(ready.length);
    const queue = ready[i]!;
    order.push(queue.shift()!);
    if (queue.length === 0) ready.splice(i, 1);
  }
  return order;
}

/** The tables the projection is made of. */
const PROJECTION_TABLES = [
  "cursor",
  "plans",
  "mandates",
  "charges",
  "vault_events",
  "fee_history",
  "mandate_events",
] as const;

/** A row as text, with its columns in a fixed order. */
function canonicalRow(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map((key) => [key, row[key]]),
  );
}

/**
 * The whole projection, as a snapshot that can be compared.
 *
 * The rows are sorted, because the order they were written in is not part
 * of the projection: a replay writes them in a different order.
 */
function snapshot(database: DatabaseSync): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const table of PROJECTION_TABLES) {
    out[table] = database
      // The table name comes from the fixed list above, not from anything a
      // caller supplies, and the query binds no values at all.
      // eslint-disable-next-line no-restricted-syntax
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) => canonicalRow(row as Record<string, unknown>))
      .sort();
  }
  return out;
}

describe("indexer idempotency under random orderings", () => {
  /**
   * The seeds the property is checked over.
   *
   * Fibonacci numbers, so the list reads as a deliberate spread rather than
   * a range, and a failing seed names the history it produced.
   */
  const SEEDS = [
    1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765, 10946,
    17711, 28657, 46368, 75025,
  ];

  test("a shuffled, repeated replay leaves the projection identical", () => {
    for (const seed of SEEDS) {
      const history = generateHistory(seed);
      const ordered = db();
      const replayed = db();
      try {
        const orderedIndexer = indexer(ordered);
        const replayIndexer = indexer(replayed);

        for (const { event } of history) {
          assert.equal(
            orderedIndexer.apply(event),
            "applied",
            `seed ${seed}: ${event.name} does not match the contract spec`,
          );
        }
        const replay = replayOrder(history, seed);
        assert.ok(
          replay.length > history.length,
          `seed ${seed}: the replay repeats at least one event`,
        );
        for (const event of replay) {
          assert.equal(
            replayIndexer.apply(event),
            "applied",
            `seed ${seed}: ${event.name} does not match the contract spec`,
          );
        }

        assert.deepEqual(
          snapshot(replayed),
          snapshot(ordered),
          `seed ${seed}: the replay left a different projection`,
        );
      } finally {
        ordered.close();
        replayed.close();
      }
    }
  });

  test("the history tables hold the same rows whatever order the events arrive in", () => {
    // The tables that record what happened are keyed on the event that
    // happened, so even a permutation the chain cannot produce leaves them
    // with the same rows.
    for (const seed of SEEDS) {
      const history = generateHistory(seed);
      const ordered = db();
      const shuffled = db();
      try {
        const orderedIndexer = indexer(ordered);
        const shuffledIndexer = indexer(shuffled);

        for (const { event } of history) orderedIndexer.apply(event);
        // Every event, in an order that shares nothing with the original.
        const permutation = history.map(({ event }) => event);
        const rnd = mulberry32(seed * 31 + 7);
        for (let i = permutation.length - 1; i > 0; i -= 1) {
          const j = Math.floor(rnd() * (i + 1));
          [permutation[i], permutation[j]] = [permutation[j]!, permutation[i]!];
        }
        for (const event of permutation) shuffledIndexer.apply(event);

        for (const table of ["charges", "vault_events", "fee_history"]) {
          assert.deepEqual(
            snapshot(shuffled)[table],
            snapshot(ordered)[table],
            `seed ${seed}: ${table} differs after a permutation`,
          );
        }
        // The churn log is not in that list: a departure is attributed to the
        // merchant the mandate row holds, so a permutation that delivers it
        // before the subscription leaves it unattributed. That is the same
        // dependency the test above pins down.
      } finally {
        ordered.close();
        shuffled.close();
      }
    }
  });

  test("the same seed always generates the same history", () => {
    // The property above is only worth anything if a failure can be
    // reproduced: the same seed has to give the same events, the same
    // addresses and the same amounts.
    for (const seed of SEEDS) {
      const first = generateHistory(seed);
      const second = generateHistory(seed);
      assert.deepEqual(
        second.map(({ event }) => event),
        first.map(({ event }) => event),
        `seed ${seed} generated a different history the second time`,
      );
    }
    // And a different seed has to give a different history, or the seeds
    // would not be covering anything.
    assert.notDeepEqual(
      generateHistory(1).map(({ event }) => event.txHash),
      generateHistory(2).map(({ event }) => event.txHash),
    );
  });

  test("an update that arrives before the row it updates is dropped", () => {
    // The one ordering the projection does not survive, written down so
    // the shuffle above is not quietly relying on it. The chain orders
    // events by ledger, so a charge never reaches the projection before
    // the subscription that created its mandate; the update simply finds
    // no row to update, and the charge's own row is still recorded.
    const d = db();
    try {
      const ix = indexer(d);
      const charge = charged(1, 1_700_060_000, "tx-early");
      ix.apply(charge);
      ix.apply(subscribed);

      const mandate = d.prepare("SELECT * FROM mandates WHERE id = 1").get() as Record<
        string,
        unknown
      >;
      assert.equal(mandate.charges_made, 0, "the charge did not advance the mandate");
      const charges = d.prepare("SELECT COUNT(*) AS n FROM charges").get() as { n: number };
      assert.equal(charges.n, 1, "the charge itself is still recorded");
    } finally {
      d.close();
    }
  });

  test("a pause that arrives after the unpause that followed it wins", () => {
    // The other ordering the projection does not survive: the pause is
    // guarded on the mandate being active or paused, so a late repeat of
    // an old pause flips the state back. The chain cannot deliver it —
    // the repeat of an event always follows the events that came after it
    // in the same ledger order — but it is worth writing down.
    const d = db();
    try {
      const ix = indexer(d);
      ix.apply(subscribed);
      ix.apply(event("pause_changed", [1n, SUBSCRIBER], { paused: true }));
      ix.apply(event("pause_changed", [1n, SUBSCRIBER], { paused: false }));
      assert.equal(
        (d.prepare("SELECT status FROM mandates WHERE id = 1").get() as { status: string }).status,
        "Active",
      );

      // The late repeat of the first pause.
      ix.apply(event("pause_changed", [1n, SUBSCRIBER], { paused: true }));
      assert.equal(
        (d.prepare("SELECT status FROM mandates WHERE id = 1").get() as { status: string }).status,
        "Paused",
        "the late pause wins, because the guard accepts an active mandate",
      );
    } finally {
      d.close();
    }
  });
});
