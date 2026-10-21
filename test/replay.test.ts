import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { Address, xdr } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { Indexer } from "../src/indexer.ts";
import { decodeEvent } from "../src/lib/stellar.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import type { rpc } from "@stellar/stellar-sdk";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

interface Fixture {
  events: unknown[];
  cursor: string;
  latestLedger: number;
}

function loadFixture(): Fixture {
  return JSON.parse(
    readFileSync(new URL("./fixtures/replay-events.json", import.meta.url), "utf8"),
  ) as Fixture;
}

/**
 * A 64-bit or 128-bit value from the fixture.
 *
 * JSON has no bigint, so the fixture carries these as numbers or strings;
 * both are read as text so no precision is lost on the way in.
 */
function asBigInt(value: unknown): bigint {
  return BigInt(typeof value === "string" ? value : String(value));
}

/**
 * Hydrate a recorded ScVal JSON blob into a real xdr.ScVal, the shape the SDK
 * returns from RPC and that `decodeEvent` consumes.
 */
function toScVal(value: unknown): xdr.ScVal {
  if (Array.isArray(value)) {
    return xdr.ScVal.scvVec(value.map(toScVal));
  }
  const obj = value as Record<string, unknown>;
  if ("symbol" in obj) return xdr.ScVal.scvSymbol(String(obj.symbol));
  if ("string" in obj) return xdr.ScVal.scvString(String(obj.string));
  if ("address" in obj) {
    // `toScVal()` builds the address ScVal; the raw key is what `scvAddress`
    // takes.
    const address = Address.fromString(String(obj.address)).toScVal() as xdr.ScValAddress;
    return xdr.ScVal.scvAddress(address.address);
  }
  if ("u32" in obj) return xdr.ScVal.scvU32(Number(obj.u32));
  if ("i32" in obj) return xdr.ScVal.scvI32(Number(obj.i32));
  if ("u64" in obj) return xdr.ScVal.scvU64(asBigInt(obj.u64));
  if ("i64" in obj) return xdr.ScVal.scvI64(asBigInt(obj.i64));
  if ("timepoint" in obj) return xdr.ScVal.scvTimepoint(asBigInt(obj.timepoint));
  if ("bool" in obj) return xdr.ScVal.scvBool(Boolean(obj.bool));
  if ("i128" in obj) {
    const n = asBigInt(obj.i128);
    return xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: n < 0n ? -1n : 0n, lo: n }));
  }
  if ("u128" in obj) {
    return xdr.ScVal.scvU128(new xdr.Uint128Parts({ hi: 0n, lo: asBigInt(obj.u128) }));
  }
  if ("map" in obj) {
    const entries = obj.map as { key: unknown; val: unknown }[];
    return xdr.ScVal.scvMap(
      entries.map((e) => new xdr.ScMapEntry({ key: toScVal(e.key), val: toScVal(e.val) })),
    );
  }
  throw new Error("unknown ScVal: " + JSON.stringify(value));
}

/** Replay one recorded getEvents response through decodeEvent and the indexer. */
function replay(db: ReturnType<typeof openDatabase>): DecodedEvent[] {
  const ix = new Indexer(db, {} as never, {} as never);
  const events: DecodedEvent[] = [];
  for (const raw of loadFixture().events) {
    const event = {
      ledger: (raw as { ledger: number }).ledger,
      txHash: (raw as { txHash: string }).txHash,
      contractId: (raw as { contractId: string }).contractId,
      topic: (raw as { topic: unknown[] }).topic.map(toScVal),
      value: toScVal((raw as { value: unknown }).value),
      ledgerClosedAt: (raw as { ledgerClosedAt?: number }).ledgerClosedAt,
    } as unknown as rpc.Api.EventResponse;
    const decoded = decodeEvent(event);
    assert.ok(decoded, `event ${event.txHash} decoded from the fixture`);
    events.push(decoded!);
    ix.apply(decoded!);
  }
  return events;
}

const events = replay(openDatabase(":memory:"));

describe("replay of recorded testnet events", () => {
  test("every recorded event decodes against the committed spec", () => {
    assert.equal(events.length, 5);
    assert.deepEqual(
      events.map((e) => e.name),
      ["plan_created", "subscribed", "charged", "deposit", "fee_changed"],
    );
    assert.deepEqual(events.map((e) => e.txHash), [
      "tx-plan-1",
      "tx-sub-1",
      "tx-charge-1",
      "tx-deposit-1",
      "tx-fee-1",
    ]);
    // Amounts round-trip as bigints, never JavaScript numbers.
    const charged = events[2]!;
    assert.equal(charged.data.amount, 9_900_000n);
    assert.equal(charged.data.fee, 100_000n);
  });

  test("replaying the fixture produces a committed snapshot of state", () => {
    const db = openDatabase(":memory:");
    const ix = new Indexer(db, {} as never, {} as never);
    for (const e of events) ix.apply(e);

    const plans = db
      .prepare(
        `SELECT id, merchant, name, token, amount, period, active, ledger
           FROM plans ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      plans.map((row) => ({ ...row })),
      [
      {
        id: 1,
        merchant: MERCHANT,
        name: "Pro Monthly",
        token: TOKEN,
        amount: "10000000",
        period: 2_592_000,
        active: 1,
        ledger: 1000,
      },
    ]);

    const mandates = db
      .prepare(
        `SELECT id, subscriber, merchant, plan_id, amount, period, next_charge,
                last_charge, charges_made, max_charges, fee_bps, status, ended_by, ledger
           FROM mandates ORDER BY id`,
      )
      .all() as Array<{
        id: number;
        subscriber: string;
        merchant: string;
        plan_id: number;
        amount: string;
        period: number;
        next_charge: number;
        last_charge: number;
        charges_made: number;
        max_charges: number;
        fee_bps: number;
        status: string;
        ended_by: string | null;
        ledger: number;
      }>;
    assert.deepEqual(
      mandates.map((row) => ({ ...row })),
      [
      {
        id: 1,
        subscriber: SUBSCRIBER,
        merchant: MERCHANT,
        plan_id: 1,
        amount: "10000000",
        period: 2_592_000,
        // The charge advanced next_charge and derived last_charge from it.
        next_charge: 1_700_060_000,
        last_charge: 1_700_060_000 - 2_592_000,
        charges_made: 1,
        max_charges: 0,
        fee_bps: 100,
        status: "Active",
        ended_by: null,
        ledger: 1001,
      },
    ]);

    const charges = db
      .prepare(
        `SELECT tx_hash, mandate_id, subscriber, merchant, amount, fee, charges_made,
                next_charge, ledger, created_at
           FROM charges ORDER BY tx_hash`,
      )
      .all() as Array<{
        tx_hash: string;
        mandate_id: number;
        subscriber: string;
        merchant: string;
        amount: string;
        fee: string;
        charges_made: number;
        next_charge: number;
        ledger: number;
        created_at: number;
      }>;
    assert.deepEqual(
      charges.map((row) => ({ ...row })),
      [
      {
        tx_hash: "tx-charge-1",
        mandate_id: 1,
        subscriber: SUBSCRIBER,
        merchant: MERCHANT,
        amount: "9900000",
        fee: "100000",
        charges_made: 1,
        next_charge: 1_700_060_000,
        ledger: 1002,
        // The chain's close time (1700000120s) in milliseconds, not the moment
        // of indexing.
        created_at: 1_700_000_120_000,
      },
    ]);

    const vault = db
      .prepare(
        `SELECT tx_hash, kind, user, token, counterparty, amount, balance, ledger
           FROM vault_events ORDER BY tx_hash`,
      )
      .all() as Array<{
        tx_hash: string;
        kind: string;
        user: string;
        token: string;
        counterparty: string | null;
        amount: string;
        balance: string;
        ledger: number;
      }>;
    assert.deepEqual(
      vault.map((row) => ({ ...row })),
      [
      {
        tx_hash: "tx-deposit-1",
        kind: "deposit",
        user: SUBSCRIBER,
        token: TOKEN,
        counterparty: null,
        amount: "50000000",
        balance: "50000000",
        ledger: 1003,
      },
    ]);

    const fees = db
      .prepare("SELECT tx_hash, old_fee_bps, new_fee_bps, ledger FROM fee_history ORDER BY ledger")
      .all() as Array<{
        tx_hash: string;
        old_fee_bps: number;
        new_fee_bps: number;
        ledger: number;
      }>;
    assert.deepEqual(
      fees.map((row) => ({ ...row })),
      [
      { tx_hash: "tx-fee-1", old_fee_bps: 100, new_fee_bps: 125, ledger: 1004 },
    ]);

    const churn = db
      .prepare(
        `SELECT mandate_id, slot, merchant, kind, at, ledger
           FROM mandate_events ORDER BY at`,
      )
      .all() as Array<{
        mandate_id: number;
        slot: string;
        merchant: string;
        kind: string;
        at: number;
        ledger: number;
      }>;
    assert.deepEqual(
      churn.map((row) => ({ ...row })),
      [
      {
        mandate_id: 1,
        slot: "start",
        merchant: MERCHANT,
        kind: "started",
        at: 1_700_000_060,
        ledger: 1001,
      },
    ]);

    db.close();
  });

  test("replaying the fixture twice leaves the database unchanged", () => {
    const db = openDatabase(":memory:");
    const ix = new Indexer(db, {} as never, {} as never);

    const snapshot = () => ({
      plans: db.prepare("SELECT * FROM plans ORDER BY id").all(),
      mandates: db.prepare("SELECT * FROM mandates ORDER BY id").all(),
      charges: db.prepare("SELECT * FROM charges ORDER BY tx_hash").all(),
      vault: db.prepare("SELECT * FROM vault_events ORDER BY tx_hash").all(),
      fees: db.prepare("SELECT * FROM fee_history ORDER BY ledger").all(),
      churn: db.prepare("SELECT * FROM mandate_events ORDER BY at").all(),
    });

    for (const e of events) ix.apply(e);
    const first = snapshot();

    for (const e of events) ix.apply(e);
    const second = snapshot();

    assert.deepEqual(second, first, "a second replay is a no-op");
    assert.equal(first.charges.length, 1, "the charge was not double-counted");
    assert.equal(first.churn.length, 1, "the start was not logged twice");
    db.close();
  });

  test("no recorded event fails the contract spec", () => {
    let mismatched = 0;
    for (const e of events) {
      const ix = new Indexer(openDatabase(":memory:"), {} as never, {} as never);
      if (ix.apply(e) === "mismatched") mismatched += 1;
    }
    assert.equal(mismatched, 0);
  });
});
