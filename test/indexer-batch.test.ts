import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { openDatabase, writeCursor } from "../src/lib/db.ts";
import { Indexer, type IndexerRpc } from "../src/indexer.ts";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import type { Storage } from "../src/lib/store/types.ts";
import type { NetworkConfig } from "../src/config.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/** A network whose indexer reads a fake chain; no real RPC is contacted. */
function net(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    name: "testnet",
    rpcUrl: "https://rpc.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    planRegistryId: CONTRACT,
    vaultId: CONTRACT,
    subscriptionId: CONTRACT,
    startLedger: 0,
    databasePath: ":memory:",
    ...overrides,
  };
}

interface FakeChain {
  latest: number;
  oldest: number;
  events: rpc.Api.EventResponse[];
  calls: Array<Record<string, unknown>>;
}

/** A raw `plan_created` event in `ledger`, id'd the way Soroban RPC ids one. */
function rawEvent(ledger: number, planId: number): rpc.Api.EventResponse {
  return {
    id: `${ledger}-${planId}`,
    ledger,
    txHash: `tx-${planId}`,
    topic: [
      nativeToScVal("plan_created", { type: "symbol" }),
      nativeToScVal(MERCHANT, { type: "address" }),
      nativeToScVal(planId, { type: "u64" }),
    ],
    value: nativeToScVal({ token: CONTRACT, amount: 10n, period: 60n, name: `p${planId}` }, {
      type: {
        token: ["symbol", "address"],
        amount: ["symbol", "i128"],
        period: ["symbol", "u64"],
        name: ["symbol", "string"],
      },
    }),
  } as unknown as rpc.Api.EventResponse;
}

/** The RPC calls the indexer makes, answering from `chain`. */
function fakeRpc(chain: FakeChain): IndexerRpc {
  return {
    async getLatestLedger() {
      return { sequence: chain.latest, closeTime: "1700000000" };
    },
    async getHealth() {
      return { oldestLedger: chain.oldest, latestLedger: chain.latest };
    },
    async getEvents(request: Record<string, unknown>) {
      chain.calls.push(request);
      // Every fixture fits in one page, so a cursor page is the end of the
      // window. Answering it again would make the pager loop forever.
      if (request.cursor !== undefined) {
        return { events: [], cursor: undefined } as unknown as rpc.Api.GetEventsResponse;
      }
      const start = Number(request.startLedger ?? 0);
      const end = Number(request.endLedger ?? chain.latest);
      const page = chain.events
        .filter((event) => event.ledger >= start && event.ledger < end)
        .sort((a, b) => a.ledger - b.ledger);
      return { events: page, cursor: `cursor-${end}` } as unknown as rpc.Api.GetEventsResponse;
    },
  } as unknown as IndexerRpc;
}

function planRows(storage: ReturnType<typeof openDatabase>): number[] {
  return (storage.prepare("SELECT id FROM plans ORDER BY id").all() as { id: number }[]).map(
    (row) => row.id,
  );
}

function cursorOf(storage: ReturnType<typeof openDatabase>): number {
  const row = storage.prepare("SELECT last_ledger FROM cursor WHERE id = 1").get() as
    | { last_ledger: number }
    | undefined;
  return row?.last_ledger ?? 0;
}

function count(storage: ReturnType<typeof openDatabase>, table: "events" | "plans"): number {
  const sql = table === "events" ? "SELECT COUNT(*) AS n FROM events" : "SELECT COUNT(*) AS n FROM plans";
  return (storage.prepare(sql).get() as { n: number }).n;
}

/** Wraps a storage and records every statement and transaction it sees. */
function spyStorage(inner: Storage): {
  storage: Storage;
  statements: string[];
  transactions: number;
} {
  const statements: string[] = [];
  let transactions = 0;
  const wrap = (target: Storage): Storage => ({
    dialect: target.dialect,
    all: (sql, params) => target.all(sql, params),
    get: (sql, params) => target.get(sql, params),
    async run(sql, params) {
      statements.push(sql);
      return target.run(sql, params);
    },
    async transaction(work) {
      transactions += 1;
      return target.transaction((tx) => work(wrap(tx)));
    },
    close: () => target.close(),
  });
  return { storage: wrap(inner), statements, get transactions() { return transactions; } };
}

describe("configurable batch size (#241)", () => {
  test("INDEXER_BATCH_SIZE sets how many ledgers one pass covers", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = { latest: 5_000, oldest: 1, events: [], calls: [] };
    const ix = new Indexer(db, fakeRpc(chain), net({ startLedger: 1_000, batchSize: 1_000 }));

    const first = await ix.tick();
    assert.equal(first.cursor, 2_000, "the pass stops after one batch of 1,000 ledgers");
    assert.equal(chain.calls[0]!.startLedger, 1_000);
    assert.equal(chain.calls[0]!.endLedger, 2_000, "the RPC window is the configured batch");

    const second = await ix.tick();
    assert.equal(second.cursor, 3_000, "the next pass resumes where the batch ended");
    assert.equal(cursorOf(db), 3_000);
  });

  test("unset, a pass still covers the 8,000-ledger RPC window", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = { latest: 20_000, oldest: 1, events: [], calls: [] };
    const ix = new Indexer(db, fakeRpc(chain), net({ startLedger: 1_000 }));

    const result = await ix.tick();

    assert.equal(result.cursor, 9_000);
    assert.equal(chain.calls[0]!.endLedger, 9_000);
  });

  test("a configured batch never exceeds the RPC's getEvents window", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = { latest: 20_000, oldest: 1, events: [], calls: [] };
    // A NetworkConfig built outside loadConfig can carry any number; the
    // indexer clamps it rather than sending a range the RPC rejects.
    const ix = new Indexer(db, fakeRpc(chain), net({ startLedger: 1_000, batchSize: 50_000 }));

    const result = await ix.tick();

    assert.equal(result.cursor, 9_000, "clamped to 8,000 ledgers");
  });

  test("each configured batch keeps its own cursor and events", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = {
      latest: 3_000,
      oldest: 1,
      events: [rawEvent(1_100, 1), rawEvent(2_100, 2)],
      calls: [],
    };
    const ix = new Indexer(db, fakeRpc(chain), net({ startLedger: 1_000, batchSize: 1_000 }));

    await ix.tick();
    assert.deepEqual(planRows(db), [1], "the first batch applied ledger 1,100");

    await ix.tick();
    assert.deepEqual(planRows(db), [1, 2], "the second batch applied ledger 2,100");
  });
});

describe("per-ledger batched writes (#247)", () => {
  test("one transaction commits a whole batch, cursor included", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = {
      latest: 2_000,
      oldest: 1,
      events: [rawEvent(1_100, 1), rawEvent(1_200, 2), rawEvent(1_300, 3)],
      calls: [],
    };
    const spy = spyStorage(new SqliteStorage(db));
    const ix = new Indexer(spy.storage, fakeRpc(chain), net({ startLedger: 1_000, batchSize: 2_000 }));

    await ix.tick();

    assert.equal(spy.transactions, 1, "one commit for the batch, not one per event");
    assert.deepEqual(planRows(db), [1, 2, 3]);
    assert.equal(cursorOf(db), 2_000);
    assert.equal(
      spy.statements.filter((sql) => sql.startsWith("INSERT INTO cursor")).length,
      1,
      "the cursor is written once per batch",
    );
  });

  test("a ledger's raw events are retained in one statement", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = {
      latest: 1_500,
      oldest: 1,
      events: [rawEvent(1_100, 1), rawEvent(1_100, 2), rawEvent(1_100, 3), rawEvent(1_400, 4)],
      calls: [],
    };
    const spy = spyStorage(new SqliteStorage(db));
    const ix = new Indexer(spy.storage, fakeRpc(chain), net({ startLedger: 1_000 }));

    await ix.tick();

    const retains = spy.statements.filter((sql) => sql.startsWith("INSERT OR IGNORE INTO events"));
    assert.equal(retains.length, 2, "one statement per ledger, not per event");
    assert.equal(
      (retains[0]!.match(/\(\?, \?, \?, \?, \?, \?, \?, \?\)/g) ?? []).length,
      3,
      "the first statement carries all three events of ledger 1,100",
    );
    assert.equal(count(db, "events"), 4, "every event is retained");
  });

  test("a failure mid-batch rolls the whole batch back, ledger by ledger", async () => {
    const db = openDatabase(":memory:");
    db.exec(`CREATE TRIGGER fail_second_plan BEFORE INSERT ON plans
      WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'projection failure'); END`);
    const chain: FakeChain = {
      latest: 1_500,
      oldest: 1,
      events: [rawEvent(1_100, 1), rawEvent(1_200, 2)],
      calls: [],
    };
    const ix = new Indexer(db, fakeRpc(chain), net({ startLedger: 1_000 }));

    await assert.rejects(ix.tick(), /projection failure/);

    assert.deepEqual(planRows(db), [], "the first ledger's rows rolled back with the batch");
    assert.equal(count(db, "events"), 0, "its raw events rolled back too");
    assert.equal(cursorOf(db), 0, "the cursor did not advance");
  });

  test("a replayed batch does not duplicate retained events", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = {
      latest: 1_500,
      oldest: 1,
      events: [rawEvent(1_100, 1), rawEvent(1_100, 2)],
      calls: [],
    };
    const ix = new Indexer(db, fakeRpc(chain), net({ startLedger: 1_000 }));

    await ix.tick();
    const afterFirst = count(db, "events");
    // Rewind as an operator reindex would, and replay the same ledgers.
    writeCursor(db, 1_000);
    await ix.tick();

    assert.equal(count(db, "events"), afterFirst, "retained events are idempotent");
    assert.deepEqual(planRows(db), [1, 2]);
  });
});
