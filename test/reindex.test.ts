import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { nativeToScVal, rpc } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "../src/config.ts";
import type { IndexerRpc } from "../src/indexer.ts";
import { openDatabase, readCursor, writeCursor } from "../src/lib/db.ts";
import { acquireLock, DatabaseLockedError, lockHolder, lockPathFor } from "../src/lib/lock.ts";
import { backupPathFor, reindex } from "../src/lib/reindex.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const dir = mkdtempSync(join(tmpdir(), "payflow-reindex-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A PID with no process behind it: probe downward until one is free. */
function deadPid(): number {
  for (let pid = 99_999; pid > 1; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no free pid found");
}

let n = 0;
function dbPath(): string {
  n += 1;
  return join(dir, `payflow-${n}.db`);
}

function net(databasePath: string, startLedger = 100): NetworkConfig {
  return {
    name: "testnet",
    rpcUrl: "https://rpc.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    planRegistryId: CONTRACT,
    vaultId: CONTRACT,
    subscriptionId: CONTRACT,
    startLedger,
    databasePath,
  };
}

function planCreated(ledger: number, planId: number): rpc.Api.EventResponse {
  return {
    ledger,
    txHash: `tx-${planId}`,
    contractId: CONTRACT,
    topic: [
      nativeToScVal("plan_created", { type: "symbol" }),
      nativeToScVal(MERCHANT, { type: "address" }),
      nativeToScVal(planId, { type: "u64" }),
    ],
    value: nativeToScVal({ token: CONTRACT, amount: 10n, period: 60n, name: `p${planId}` }, {
      type: { token: ["symbol", "address"], amount: ["symbol", "i128"], period: ["symbol", "u64"], name: ["symbol", "string"] },
    }),
  } as unknown as rpc.Api.EventResponse;
}

/** An RPC node serving `events`, recording the start ledger of each range request. */
function fakeRpc(events: rpc.Api.EventResponse[], latest: number, starts: number[] = []): IndexerRpc {
  return {
    getLatestLedger: async () => ({ sequence: latest }) as never,
    getHealth: async () => ({ oldestLedger: 1, latestLedger: latest }) as never,
    getEvents: async (req: Record<string, unknown>) => {
      if (req.cursor === undefined) starts.push(req.startLedger as number);
      const start = (req.startLedger as number | undefined) ?? 0;
      const end = (req.endLedger as number | undefined) ?? Infinity;
      const page = req.cursor === undefined ? events.filter((e) => e.ledger >= start && e.ledger < end) : [];
      return { events: page, cursor: "end", latestLedger: latest } as never;
    },
  } as unknown as IndexerRpc;
}

describe("database lock", () => {
  test("a live holder blocks a second taker; release frees it", () => {
    const path = dbPath();
    const release = acquireLock(path);
    assert.equal(lockHolder(path), process.pid);
    release();
    assert.equal(existsSync(lockPathFor(path)), false);
    assert.equal(lockHolder(path), null);
  });

  test("a lock left by a dead process is stale and taken over", () => {
    const path = dbPath();
    writeFileSync(lockPathFor(path), `${deadPid()}\n`);
    assert.equal(lockHolder(path), null);
    const release = acquireLock(path);
    assert.equal(lockHolder(path), process.pid);
    release();
  });

  test("in-memory databases are never locked", () => {
    acquireLock(":memory:")();
    assert.equal(lockHolder(":memory:"), null);
  });
});

describe("reindex", () => {
  test("keeps the old file as a backup and rebuilds from INDEXER_START_LEDGER", async () => {
    const path = dbPath();
    const old = openDatabase(path);
    old.prepare(
      `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
       VALUES (99, ?, 'stale', ?, '1', 60, 1, 1)`,
    ).run(MERCHANT, CONTRACT);
    writeCursor(old, 5_000);
    old.close();

    const starts: number[] = [];
    const now = new Date("2026-10-21T10:15:00.123Z");
    const result = await reindex(
      net(path, 100),
      fakeRpc([planCreated(150, 1), planCreated(160, 2)], 200, starts),
      now,
    );

    assert.equal(result.backup, `${path}.bak-20261021T101500Z`);
    assert.equal(result.backup, backupPathFor(path, now));
    assert.equal(result.events, 2);
    assert.equal(starts[0], 100, "a fresh database starts at INDEXER_START_LEDGER, not the old cursor");

    const backup = openDatabase(result.backup!);
    assert.deepEqual(
      (backup.prepare("SELECT id FROM plans").all() as Array<{ id: number }>).map((r) => r.id),
      [99],
      "the backup still holds the old projection",
    );
    assert.equal(readCursor(backup, 0), 5_000);
    backup.close();

    const fresh = openDatabase(path);
    assert.deepEqual(
      (fresh.prepare("SELECT id FROM plans ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id),
      [1, 2],
    );
    fresh.close();
    assert.equal(existsSync(lockPathFor(path)), false, "the lock is released afterwards");
  });

  test("refuses to run while the server holds the database", async () => {
    const path = dbPath();
    openDatabase(path).close();
    // Another live process holds the lock, as the server would: the test
    // runner that started this process is alive for the whole test.
    const holder = process.ppid;
    writeFileSync(lockPathFor(path), `${holder}\n`);
    await assert.rejects(reindex(net(path), fakeRpc([], 200)), (err: unknown) => {
      assert.ok(err instanceof DatabaseLockedError);
      assert.equal(err.pid, holder);
      return true;
    });
    assert.ok(existsSync(path), "the database is left in place");
    assert.equal(
      readdirSync(dir).some((f) => f.startsWith(`payflow-${n}.db.bak-`)),
      false,
      "no backup is made",
    );
  });

  test("works when there is no database yet", async () => {
    const path = dbPath();
    const result = await reindex(net(path), fakeRpc([planCreated(150, 1)], 200));
    assert.equal(result.backup, null);
    assert.equal(result.events, 1);
  });
});
