/**
 * Measure the indexer's write path with and without per-ledger batching (#247).
 *
 *     npm run bench:indexer
 *
 * The same fixture is indexed twice through the real `Indexer`: once with a
 * storage wrapper that splits each ledger's multi-row event insert back into
 * one statement per event — the statement count the indexer issued before #247
 * — and once as it is written today. Both run inside the same single
 * transaction per batch, so the difference is statement and round-trip
 * overhead, not commit count.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { Indexer, type IndexerRpc } from "../src/indexer.ts";
import { openDatabase } from "../src/lib/db.ts";
import { PostgresStorage } from "../src/lib/store/postgres.ts";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import type { Storage } from "../src/lib/store/types.ts";
import type { NetworkConfig } from "../src/config.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const LEDGERS = 400;
const EVENTS_PER_LEDGER = 10;
const START_LEDGER = 1_000;
const END_LEDGER = START_LEDGER + LEDGERS;
const COLUMNS = 8;
const RETAIN = /^\s*INSERT OR IGNORE INTO events/;
const RETAIN_SQL = `INSERT OR IGNORE INTO events
   (event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

function rawEvent(ledger: number, index: number): rpc.Api.EventResponse {
  return {
    id: `${ledger}-${index}`,
    ledger,
    txHash: `tx-${ledger}-${index}`,
    topic: [
      nativeToScVal("plan_created", { type: "symbol" }),
      nativeToScVal(MERCHANT, { type: "address" }),
      nativeToScVal(ledger * 100 + index, { type: "u64" }),
    ],
    value: nativeToScVal({ token: CONTRACT, amount: 10n, period: 60n, name: `p${index}` }, {
      type: {
        token: ["symbol", "address"],
        amount: ["symbol", "i128"],
        period: ["symbol", "u64"],
        name: ["symbol", "string"],
      },
    }),
  } as unknown as rpc.Api.EventResponse;
}

function fixture(): rpc.Api.EventResponse[] {
  const events: rpc.Api.EventResponse[] = [];
  for (let ledger = START_LEDGER; ledger < END_LEDGER; ledger += 1) {
    for (let index = 0; index < EVENTS_PER_LEDGER; index += 1) events.push(rawEvent(ledger, index));
  }
  return events;
}

function rpcFor(events: rpc.Api.EventResponse[]): IndexerRpc {
  return {
    async getLatestLedger() {
      return { sequence: END_LEDGER, closeTime: "1700000000" };
    },
    async getHealth() {
      return { oldestLedger: 1, latestLedger: END_LEDGER };
    },
    async getEvents(request: Record<string, unknown>) {
      if (request.cursor !== undefined) {
        return { events: [], cursor: undefined } as unknown as rpc.Api.GetEventsResponse;
      }
      const start = Number(request.startLedger ?? 0);
      const end = Number(request.endLedger ?? END_LEDGER);
      return {
        events: events.filter((event) => event.ledger >= start && event.ledger < end),
        cursor: `cursor-${end}`,
      } as unknown as rpc.Api.GetEventsResponse;
    },
  } as unknown as IndexerRpc;
}

function network(): NetworkConfig {
  return {
    name: "bench",
    rpcUrl: "https://rpc.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    planRegistryId: CONTRACT,
    vaultId: CONTRACT,
    subscriptionId: CONTRACT,
    startLedger: START_LEDGER,
    databasePath: ":memory:",
    batchSize: 8_000,
    progressLedgers: 0,
  };
}

interface Counts {
  transactions: number;
  retains: number;
}

/**
 * Storage that counts transactions and retain statements, optionally splitting
 * a ledger's multi-row retain into one statement per event (the pre-#247 shape).
 */
function instrument(inner: Storage, split: boolean): { storage: Storage; counts: Counts } {
  const counts: Counts = { transactions: 0, retains: 0 };
  const wrap = (target: Storage): Storage => ({
    dialect: target.dialect,
    all: (sql, params) => target.all(sql, params),
    get: (sql, params) => target.get(sql, params),
    async run(sql, params = []) {
      if (!RETAIN.test(sql)) return target.run(sql, params);
      if (!split) {
        counts.retains += 1;
        return target.run(sql, params);
      }
      // One statement per event, the statement count the indexer issued before #247.
      const rows = params.length / COLUMNS;
      counts.retains += rows;
      for (let row = 0; row < rows; row += 1) {
        await target.run(RETAIN_SQL, params.slice(row * COLUMNS, (row + 1) * COLUMNS));
      }
      return undefined;
    },
    transaction: (work) => {
      counts.transactions += 1;
      return target.transaction((tx) => work(wrap(tx)));
    },
    close: () => target.close(),
  });
  return { storage: wrap(inner), counts };
}

interface Measurement {
  ms: number;
  counts: Counts;
  applied: number;
}

async function run(storage: Storage, split: boolean): Promise<Measurement> {
  const { storage: wrapped, counts } = instrument(storage, split);
  const ix = new Indexer(wrapped, rpcFor(fixture()), network());
  const started = performance.now();
  const result = await ix.tick();
  return { ms: performance.now() - started, counts, applied: result.applied };
}

function report(label: string, before: Measurement, after: Measurement): void {
  const rows = LEDGERS * EVENTS_PER_LEDGER;
  console.log(`\n${label} — ${rows} events, ${LEDGERS} ledgers`);
  console.log(
    `  per event:  ${before.ms.toFixed(0)} ms, ${before.counts.retains} retain statements`,
  );
  console.log(
    `  per ledger: ${after.ms.toFixed(0)} ms, ${after.counts.retains} retain statements`,
  );
  console.log(
    `  ${before.ms.toFixed(0)} ms → ${after.ms.toFixed(0)} ms, ${(before.ms / after.ms).toFixed(2)}× faster; ` +
      `transactions per pass ${before.counts.transactions} → ${after.counts.transactions}; ${after.applied} applies`,
  );
}

const dir = mkdtempSync(join(tmpdir(), "payflow-bench-"));
try {
  const openSqlite = (name: string) => new SqliteStorage(openDatabase(join(dir, `${name}.db`)));

  const sqliteBefore = openSqlite("per-event");
  const before = await run(sqliteBefore, true);
  await sqliteBefore.close();
  const sqliteAfter = openSqlite("per-ledger");
  const after = await run(sqliteAfter, false);
  await sqliteAfter.close();
  report("SQLite (file-backed)", before, after);

  // Set DATABASE_URL to measure the network round trips a remote server pays.
  const url = process.env.DATABASE_URL;
  if (url) {
    // One schema per run, so the two passes do not see each other's rows.
    const schema = (label: string) =>
      `bench_${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const postgresBefore = await PostgresStorage.open(url, schema("per_event"));
    const pgBefore = await run(postgresBefore, true);
    await postgresBefore.close();
    const postgresAfter = await PostgresStorage.open(url, schema("per_ledger"));
    const pgAfter = await run(postgresAfter, false);
    await postgresAfter.close();
    report("PostgreSQL (local server)", pgBefore, pgAfter);
  } else {
    console.log("\nSet DATABASE_URL to measure PostgreSQL as well.");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
