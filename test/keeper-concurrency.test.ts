import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  Account,
  Keypair,
  Operation,
  Transaction,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { ChannelPool } from "../src/lib/channel-pool.ts";
import { claimCharge, holdClaim, pruneClaims } from "../src/lib/claims.ts";
import { metrics } from "../src/lib/metrics.ts";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import { Keeper, type KeeperRpc } from "../src/keeper.ts";
import type { Config } from "../src/config.ts";

/**
 * Issue #249: settle due mandates concurrently, bounded by
 * KEEPER_CONCURRENCY, each in-flight transaction on its own channel account,
 * with an atomic claim so no due charge is settled twice.
 */

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const NOW = 10_000;
/** A TransactionResult of txBAD_SEQ, as the RPC returns it in errorResultXdr. */
const BAD_SEQ = xdr.TransactionResult.fromXDR("AAAAAAAAAGT////7AAAAAA==", "base64");

type Db = ReturnType<typeof openDatabase>;

function config(
  secrets: { KEEPER_SECRET: string; KEEPER_CHANNEL_SECRETS?: string[] },
  extra: Partial<
    Record<"KEEPER_CONCURRENCY" | "KEEPER_CLAIM_TTL_S" | "KEEPER_BATCH" | "KEEPER_BACKOFF_JITTER", unknown>
  > = {},
): Config {
  return {
    PLAN_REGISTRY_ID: CONTRACT,
    VAULT_ID: CONTRACT,
    SUBSCRIPTION_ID: CONTRACT,
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    KEEPER_FEE_PERCENTILE: "90",
    KEEPER_MAX_FEE: "100000",
    KEEPER_BATCH: false,
    KEEPER_BATCH_SIZE: 10,
    KEEPER_BACKOFF_JITTER: 0,
    ...secrets,
    ...extra,
  } as unknown as Config;
}

function insertDue(db: Db, ...ids: number[]): void {
  for (const id of ids) {
    db.prepare(
      `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
       VALUES (?, ?, ?, 1, '10', 2592000, ?, 'Active', 1)`,
    ).run(id, SUBSCRIBER, MERCHANT, 1_000 + id);
  }
}

/** The mandate ids a `charge` or `charge_many` transaction carries. */
function mandatesOf(tx: Transaction): number[] {
  // SDK 17 exposes the decoded host function as plain fields.
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = (op.func as unknown as { invokeContract: { args: xdr.ScVal[] } }).invokeContract;
  const native: unknown = scValToNative(call.args[0]!);
  return Array.isArray(native) ? native.map(Number) : [Number(native)];
}

/** What the fake node does with one submission. */
type Behaviour =
  | "settle"
  | "contractError"
  | "authError"
  | "networkError"
  | "badSeq"
  | "badAuth"
  | "notFound"
  | "missingBatch";

interface Trace {
  /** Transactions between submission and confirmation right now. */
  inFlight: number;
  maxInFlight: number;
  /** Highest `keeper_in_flight` gauge value seen at any submission. */
  maxGauge: number;
  /** One account with two transactions in flight at once. */
  overlaps: string[];
  /** A submission whose sequence was not the account's next one. */
  collisions: string[];
  sends: { mandates: number[]; source: string; sequence: string }[];
  prepares: number[][];
  getAccounts: string[];
  /** Mandate ids whose transaction confirmed SUCCESS, in confirmation order. */
  confirmed: number[];
}

function trace(): Trace {
  return {
    inFlight: 0,
    maxInFlight: 0,
    maxGauge: 0,
    overlaps: [],
    collisions: [],
    sends: [],
    prepares: [],
    getAccounts: [],
    confirmed: [],
  };
}

/**
 * A fake RPC node that models sequence numbers the way the network does —
 * `getAccount` reports the last consumed sequence, an accepted submission
 * consumes it — and tracks how many transactions are in flight, overall and
 * per account. `behave` scripts each submission: it gets the mandate ids and
 * how many times those ids were submitted before.
 */
function fakeNode(
  t: Trace,
  behave: (mandates: number[], previousSends: number) => Behaviour = () => "settle",
  confirmMs = 20,
): KeeperRpc {
  const consumed = new Map<string, bigint>();
  const bySource = new Map<string, number>();
  const pending = new Map<string, { mandates: number[]; source: string; behaviour: Behaviour; open: boolean }>();
  const previous = (mandates: number[]): number =>
    t.sends.filter((send) => send.mandates[0] === mandates[0]).length;
  return {
    getFeeStats: async () => ({ sorobanInclusionFee: { p90: "1000" } }) as never,
    getAccount: async (address: string) => {
      t.getAccounts.push(address);
      return new Account(address, (consumed.get(address) ?? 0n).toString()) as never;
    },
    prepareTransaction: async (tx) => {
      const mandates = mandatesOf(tx as Transaction);
      t.prepares.push(mandates);
      const behaviour = behave(mandates, previous(mandates));
      if (behaviour === "contractError") throw new Error("HostError: Error(Contract, #3)");
      if (behaviour === "authError") {
        throw new Error("HostError: Error(Auth, InvalidAction)\n\nEvent log: require_auth failed");
      }
      if (behaviour === "missingBatch" && mandates.length > 1) {
        throw new Error("trying to invoke non-existent contract function charge_many");
      }
      return tx as Transaction;
    },
    sendTransaction: async (tx) => {
      const transaction = tx as Transaction;
      const mandates = mandatesOf(transaction);
      const behaviour = behave(mandates, previous(mandates));
      t.sends.push({ mandates, source: transaction.source, sequence: transaction.sequence });
      t.maxGauge = Math.max(t.maxGauge, Number(metrics.value("keeper_in_flight") ?? 0));
      if (behaviour === "networkError") throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
      if (behaviour === "badSeq") return { status: "ERROR", errorResult: BAD_SEQ } as never;
      if (behaviour === "badAuth") {
        return { status: "ERROR", errorResult: { result: { type: "txBadAuth" } } } as never;
      }
      const expected = (consumed.get(transaction.source) ?? 0n) + 1n;
      if (BigInt(transaction.sequence) !== expected) {
        t.collisions.push(`${transaction.source} sent ${transaction.sequence}, expected ${expected}`);
      }
      consumed.set(transaction.source, BigInt(transaction.sequence));
      const open = (bySource.get(transaction.source) ?? 0) + 1;
      bySource.set(transaction.source, open);
      if (open > 1) t.overlaps.push(`${transaction.source} has ${open} transactions in flight`);
      t.inFlight += 1;
      t.maxInFlight = Math.max(t.maxInFlight, t.inFlight);
      const hash = Buffer.from(transaction.hash()).toString("hex");
      pending.set(hash, { mandates, source: transaction.source, behaviour, open: true });
      return { status: "PENDING", hash } as never;
    },
    getTransaction: async (hash: string) => {
      await new Promise((resolve) => setTimeout(resolve, confirmMs));
      const entry = pending.get(hash)!;
      if (entry.open) {
        entry.open = false;
        t.inFlight -= 1;
        bySource.set(entry.source, bySource.get(entry.source)! - 1);
      }
      if (entry.behaviour === "notFound") {
        return { status: rpc.Api.GetTransactionStatus.NOT_FOUND } as never;
      }
      t.confirmed.push(...entry.mandates);
      return { status: rpc.Api.GetTransactionStatus.SUCCESS } as never;
    },
  };
}

function keys(count: number): Keypair[] {
  return Array.from({ length: count }, () => Keypair.random());
}

function channelConfig(
  channelKeys: Keypair[],
  extra: Parameters<typeof config>[1] = {},
): Config {
  const [primary, ...rest] = channelKeys;
  return config(
    { KEEPER_SECRET: primary!.secret(), KEEPER_CHANNEL_SECRETS: rest.map((key) => key.secret()) },
    extra,
  );
}

interface AttemptRow {
  mandate_id: number;
  result: string;
  error_code: string | null;
  retry_at: number | null;
}

function attempts(db: Db): AttemptRow[] {
  return db
    .prepare("SELECT mandate_id, result, error_code, retry_at FROM charge_attempts ORDER BY id")
    .all() as unknown as AttemptRow[];
}

function claims(db: Db): { mandate_id: number; owner: string; expires_at: number }[] {
  return db
    .prepare("SELECT mandate_id, owner, expires_at FROM keeper_claims ORDER BY mandate_id")
    .all() as unknown as { mandate_id: number; owner: string; expires_at: number }[];
}

function count<T>(values: T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

describe("keeper concurrency cap (#249)", () => {
  test("with 8 due mandates and a cap of 2 over 4 channels, never more than 2 are in flight", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3, 4, 5, 6, 7, 8);
    const t = trace();
    const keeper = new Keeper(db, fakeNode(t), channelConfig(keys(4), { KEEPER_CONCURRENCY: 2 }));
    assert.equal(keeper.concurrency, 2);

    const results = await keeper.tick(NOW);

    assert.deepEqual(results.map((r) => r.mandateId), [1, 2, 3, 4, 5, 6, 7, 8], "every mandate is processed");
    assert.ok(results.every((r) => r.status === "settled"));
    assert.equal(t.maxInFlight, 2, "the cap is reached and never exceeded");
    assert.ok(t.maxGauge <= 2, `keeper_in_flight stays within the cap (saw ${t.maxGauge})`);
    assert.equal(metrics.value("keeper_in_flight"), 0, "the gauge drops back to zero after the pass");
    assert.deepEqual(t.collisions, []);
    assert.deepEqual(t.overlaps, []);
    db.close();
  });

  test("unset, the cap is one transaction per channel", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3, 4, 5, 6);
    const t = trace();
    const keeper = new Keeper(db, fakeNode(t), channelConfig(keys(3)));
    assert.equal(keeper.concurrency, 3);

    const results = await keeper.tick(NOW);
    assert.equal(results.filter((r) => r.status === "settled").length, 6);
    assert.equal(t.maxInFlight, 3);
    db.close();
  });

  test("a cap of 1 settles one at a time and still rotates over every channel", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3, 4, 5, 6);
    const t = trace();
    const channelKeys = keys(3);
    const keeper = new Keeper(db, fakeNode(t), channelConfig(channelKeys, { KEEPER_CONCURRENCY: 1 }));

    const results = await keeper.tick(NOW);
    assert.equal(results.filter((r) => r.status === "settled").length, 6);
    assert.equal(t.maxInFlight, 1);
    assert.deepEqual(
      [...new Set(t.sends.map((send) => send.source))].sort(),
      channelKeys.map((key) => key.publicKey()).sort(),
      "released channels go to the back of the line, so fees spread over every account",
    );
    db.close();
  });
});

describe("keeper channel XLM health (#252)", () => {
  test("routes due charges away from a channel below the configured balance threshold", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1);
    const channelKeys = keys(2);
    const t = trace();
    const server = fakeNode(t);
    let balanceReads = 0;
    server.getLedgerEntries = async () => ({
      entries: [{
        val: {
          type: "account",
          account: { balance: balanceReads++ === 0 ? 5_000_000n : 20_000_000n },
        },
      }],
      latestLedger: 1,
    }) as never;
    const keeper = new Keeper(db, server, channelConfig(channelKeys));

    const results = await keeper.tick(NOW);

    assert.equal(results[0]!.status, "settled");
    assert.deepEqual(t.sends.map((send) => send.source), [channelKeys[1]!.publicKey()]);
    db.close();
  });

  test("does not submit from channels confirmed below the minimum when none are healthy", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1);
    const t = trace();
    const server = fakeNode(t);
    server.getLedgerEntries = async () => ({
      entries: [{
        val: { type: "account", account: { balance: 5_000_000n } },
      }],
      latestLedger: 1,
    }) as never;
    const keeper = new Keeper(db, server, channelConfig(keys(1)));

    assert.deepEqual(await keeper.tick(NOW), []);
    assert.deepEqual(t.sends, []);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM charge_attempts").get()?.n,
      0,
    );
    db.close();
  });
});

describe("keeper channel exclusivity (#249)", () => {
  test("no channel ever has two transactions in flight, and channels are reused after completion", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, ...Array.from({ length: 12 }, (_, i) => i + 1));
    const t = trace();
    const channelKeys = keys(4);
    const keeper = new Keeper(db, fakeNode(t), channelConfig(channelKeys, { KEEPER_CONCURRENCY: 4 }));

    const results = await keeper.tick(NOW);

    assert.equal(results.filter((r) => r.status === "settled").length, 12);
    assert.deepEqual(t.overlaps, [], "one account, one transaction in flight");
    assert.deepEqual(t.collisions, [], "every channel's sequence numbers run 1, 2, 3, ... with no gaps or repeats");
    const uses = count(t.sends.map((send) => send.source));
    for (const key of channelKeys) {
      assert.ok((uses.get(key.publicKey()) ?? 0) >= 2, "each channel settles several mandates in turn");
    }
    db.close();
  });

  test("a charge_many fallback settles its mandates one after another on its one channel", async () => {
    // Before #249 the fallback sent the group's single charges side by side
    // from the same account, so all but one raced for one sequence number.
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3);
    const t = trace();
    const keeper = new Keeper(
      db,
      fakeNode(t, () => "missingBatch"),
      channelConfig(keys(1), { KEEPER_BATCH: true }),
    );

    const results = await keeper.tick(NOW);

    assert.deepEqual(results.map((r) => r.status), ["settled", "settled", "settled"]);
    assert.equal(t.sends.length, 3, "three single charges after the refused charge_many");
    assert.deepEqual(t.collisions, []);
    assert.deepEqual(t.overlaps, []);
    db.close();
  });

  test("the pool hands a channel to one holder at a time and queues the rest", async () => {
    const pool = new ChannelPool(["a", "b"]);
    const first = await pool.acquire();
    const second = await pool.acquire();
    assert.notEqual(first, second);
    assert.equal(pool.inUse, 2);

    let third: string | undefined;
    const waiting = pool.acquire().then((channel) => (third = channel));
    await Promise.resolve();
    assert.equal(third, undefined, "nothing is free, so the third caller waits");

    pool.release(first);
    await waiting;
    assert.equal(third, first, "the released channel goes straight to the waiter");
    assert.equal(pool.inUse, 2);

    pool.release(second);
    pool.release(third!);
    assert.equal(pool.inUse, 0);
    assert.throws(() => pool.release("a"), /not leased/, "a double release is a bug, not a no-op");
  });
});

describe("keeper cap versus channel count (#249)", () => {
  test("a cap above the number of channels is rejected without printing a secret", () => {
    const channelKeys = keys(2);
    assert.throws(
      () => new Keeper(openDatabase(":memory:"), fakeNode(trace()), channelConfig(channelKeys, { KEEPER_CONCURRENCY: 3 })),
      (err: Error) => {
        assert.match(err.message, /KEEPER_CONCURRENCY=3 exceeds the 2 keeper channel account/);
        for (const key of channelKeys) assert.ok(!err.message.includes(key.secret()));
        return true;
      },
    );
  });

  test("a cap of 0 or a fractional cap is rejected", () => {
    for (const cap of [0, -1, 1.5]) {
      assert.throws(
        () => new Keeper(openDatabase(":memory:"), fakeNode(trace()), channelConfig(keys(2), { KEEPER_CONCURRENCY: cap })),
        /KEEPER_CONCURRENCY must be a whole number of at least 1/,
      );
    }
  });

  test("a reload with a cap the channels cannot carry is refused and the running keeper is unchanged", () => {
    const channelKeys = keys(2);
    const keeper = new Keeper(openDatabase(":memory:"), fakeNode(trace()), channelConfig(channelKeys));
    assert.throws(
      () => keeper.reloadFromConfig(channelConfig([channelKeys[0]!], { KEEPER_CONCURRENCY: 2 })),
      /exceeds the 1 keeper channel account/,
    );
    assert.equal(keeper.channelCount, 2);
    assert.equal(keeper.concurrency, 2);
  });

  test("when a channel is dead for the pass, concurrency shrinks to the live channels", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3, 4);
    const t = trace();
    const [primary, dead, live] = keys(3);
    const node = fakeNode(t);
    const server: KeeperRpc = {
      ...node,
      getAccount: async (address: string) => {
        if (address === dead!.publicKey()) throw new Error(`The source account ${address} was not found`);
        return node.getAccount(address);
      },
    };
    const keeper = new Keeper(db, server, channelConfig([primary!, dead!, live!], { KEEPER_CONCURRENCY: 3 }));

    const results = await keeper.tick(NOW);
    assert.equal(results.filter((r) => r.status === "settled").length, 4);
    assert.ok(t.maxInFlight <= 2, "only the two live channels carry transactions");
    assert.ok(!t.sends.some((send) => send.source === dead!.publicKey()));
    db.close();
  });
});

describe("keeper claims prevent double settlement (#249)", () => {
  test("two keeper instances racing on the same due mandates settle each exactly once", async () => {
    const db = openDatabase(":memory:");
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    insertDue(db, ...ids);
    const t = trace();
    // One fake network for both, as in production: the two keepers have
    // their own channel accounts but share the chain and the database.
    const node = fakeNode(t, () => "settle", 15);
    const first = new Keeper(db, node, channelConfig(keys(2)));
    const second = new Keeper(db, node, channelConfig(keys(2)));
    assert.notEqual(first.instanceId, second.instanceId);

    const [a, b] = await Promise.all([first.tick(NOW), second.tick(NOW)]);

    const settled = [...a, ...b].filter((r) => r.status === "settled").map((r) => r.mandateId);
    assert.deepEqual([...settled].sort((x, y) => x - y), ids, "every mandate settles, none twice");
    assert.ok(a.length > 0 && b.length > 0, "both keepers did part of the work");
    for (const [mandate, sends] of count(t.sends.map((send) => send.mandates[0]!))) {
      assert.equal(sends, 1, `mandate ${mandate} is submitted exactly once`);
    }
    db.close();
  });

  test("two keeper processes on separate connections to one SQLite file settle each exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payflow-claims-"));
    const path = join(dir, "payflow.db");
    const seed = openDatabase(path);
    const ids = Array.from({ length: 8 }, (_, i) => i + 1);
    insertDue(seed, ...ids);
    seed.close();
    const left = openDatabase(path);
    const right = openDatabase(path);
    try {
      const t = trace();
      const node = fakeNode(t, () => "settle", 10);
      const [a, b] = await Promise.all([
        new Keeper(left, node, channelConfig(keys(2))).tick(NOW),
        new Keeper(right, node, channelConfig(keys(2))).tick(NOW),
      ]);
      const settled = [...a, ...b].filter((r) => r.status === "settled").map((r) => r.mandateId);
      assert.deepEqual([...settled].sort((x, y) => x - y), ids);
      assert.equal(t.sends.length, ids.length, "no due charge reached the network twice");
    } finally {
      left.close();
      right.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a settled due charge stays claimed, so a stale due list does not settle it again", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1);
    const t = trace();
    const keeper = new Keeper(db, fakeNode(t), channelConfig(keys(1), { KEEPER_CLAIM_TTL_S: 300 }));

    assert.equal((await keeper.tick(NOW))[0]!.status, "settled");
    // The indexer has not advanced next_charge yet: the mandate still looks due.
    assert.deepEqual(await keeper.tick(NOW + 60), [], "the same due charge is not attempted twice");
    assert.equal(t.sends.length, 1);

    // Once the indexer advances next_charge, the next period is a new charge.
    db.prepare("UPDATE mandates SET next_charge = ? WHERE id = 1").run(NOW + 60);
    assert.equal((await keeper.tick(NOW + 120))[0]!.status, "settled");
    assert.equal(t.sends.length, 2);
    db.close();
  });

  test("a claim abandoned by a crashed keeper becomes eligible once it expires", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2);
    // A keeper claimed mandate 1's due charge and died before settling it.
    db.prepare("INSERT INTO keeper_claims (mandate_id, due_at, owner, expires_at) VALUES (1, 1001, 'crashed:1:dead', ?)").run(
      NOW + 120,
    );
    const t = trace();
    const keeper = new Keeper(db, fakeNode(t), channelConfig(keys(2)));

    const before = await keeper.tick(NOW);
    assert.deepEqual(before.map((r) => r.mandateId), [2], "the live claim is respected");

    const after = await keeper.tick(NOW + 120);
    assert.deepEqual(after.map((r) => [r.mandateId, r.status]), [[1, "settled"]], "the expired claim is taken over");
    const claim = claims(db).find((row) => row.mandate_id === 1)!;
    assert.equal(claim.owner, keeper.instanceId);
    db.close();
  });

  test("a failed charge keeps its claim until the backoff's retry time, for every keeper", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1);
    const t = trace();
    const failing = new Keeper(db, fakeNode(t, () => "contractError"), channelConfig(keys(1)));
    assert.equal((await failing.tick(NOW))[0]!.status, "failed");
    assert.deepEqual(claims(db).map((row) => row.expires_at), [NOW + 60]);

    // Another keeper that cannot even see the attempt log (so restores no
    // backoff) still does not retry early: the claim alone holds it off.
    db.exec("DELETE FROM charge_attempts");
    const other = new Keeper(db, fakeNode(trace()), channelConfig(keys(1)));
    assert.deepEqual(await other.tick(NOW + 30), []);
    assert.deepEqual((await other.tick(NOW + 60)).map((r) => r.status), ["settled"], "after the backoff it may retry");
    db.close();
  });

  test("the claim upsert gives a due charge to exactly one owner and lets an expired one be taken over", async () => {
    const storage = await SqliteStorage.open(":memory:");
    try {
      const request = { mandateId: 7, dueAt: 1_007, now: NOW, ttlSeconds: 300 };
      assert.equal(await claimCharge(storage, { ...request, owner: "a" }), true);
      assert.equal(await claimCharge(storage, { ...request, owner: "b" }), false, "held by a");
      assert.equal(await claimCharge(storage, { ...request, owner: "a" }), false, "even a cannot claim it twice");
      assert.equal(
        await claimCharge(storage, { ...request, dueAt: 2_007, owner: "b" }),
        true,
        "the next period is a separate charge",
      );

      // Only the owner can re-time its claim.
      await holdClaim(storage, { mandateId: 7, dueAt: 1_007, owner: "b", until: NOW + 1 });
      assert.equal(await claimCharge(storage, { ...request, now: NOW + 1, owner: "b" }), false);

      assert.equal(await claimCharge(storage, { ...request, now: NOW + 300, owner: "b" }), true, "expired: taken over");

      await pruneClaims(storage, NOW + 10_000);
      assert.deepEqual(await storage.all("SELECT * FROM keeper_claims"), []);
    } finally {
      await storage.close();
    }
  });
});

describe("keeper backoff with claims (#248, #249)", () => {
  test("when a backoff ends, two keepers racing for the mandate settle it exactly once", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3);
    const t = trace();
    // Mandate 1's first submission is lost to the network (a base-delay
    // retry); once the wait is over it settles.
    const node = fakeNode(t, ([id], previous) => (id === 1 && previous === 0 ? "networkError" : "settle"), 10);
    const first = new Keeper(db, node, channelConfig(keys(2)));
    const second = new Keeper(db, node, channelConfig(keys(2)));
    await first.tick(NOW);
    const retryAt = attempts(db).find((row) => row.mandate_id === 1)!.retry_at!;
    assert.equal(retryAt, NOW + 60);

    // Before the retry time neither keeper loads it, whoever recorded it.
    const early = await Promise.all([first.tick(retryAt - 1), second.tick(retryAt - 1)]);
    assert.deepEqual(early.flat(), []);

    const [a, b] = await Promise.all([first.tick(retryAt), second.tick(retryAt)]);
    assert.deepEqual([...a, ...b].map((r) => [r.mandateId, r.status]), [[1, "settled"]]);
    assert.equal(t.sends.filter((send) => send.mandates[0] === 1).length, 2, "one failed, then one settling submission");
    db.close();
  });

  test("a jittered retry time is the claim's expiry too, so other keepers wait exactly as long", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1);
    const failing = new Keeper(
      db,
      fakeNode(trace(), () => "contractError"),
      channelConfig(keys(1), { KEEPER_BACKOFF_JITTER: 0.5 }),
      undefined,
      { random: () => 0.5 },
    );
    await failing.tick(NOW);
    // 60 s less a quarter (0.5 jitter x 0.5 draw).
    assert.deepEqual(attempts(db).map((row) => row.retry_at), [NOW + 45]);
    assert.deepEqual(claims(db).map((row) => row.expires_at), [NOW + 45]);

    const other = new Keeper(db, fakeNode(trace()), channelConfig(keys(1)));
    assert.deepEqual(await other.tick(NOW + 44), []);
    assert.deepEqual((await other.tick(NOW + 45)).map((r) => r.status), ["settled"]);
    db.close();
  });
});

describe("keeper failure isolation (#249)", () => {
  test("a contract error, a network error and a timeout fail alone while the others settle", async (t) => {
    // The poll's one-second waits run immediately; the confirm delay too.
    t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void) => {
      queueMicrotask(callback);
      return 0 as never;
    });
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3, 4, 5, 6);
    const tr = trace();
    const behaviour: Record<number, Behaviour> = { 2: "contractError", 3: "networkError", 4: "notFound" };
    const channelKeys = keys(3);
    const keeper = new Keeper(
      db,
      fakeNode(tr, ([id]) => behaviour[id!] ?? "settle"),
      channelConfig(channelKeys),
    );

    const results = await keeper.tick(NOW);

    assert.deepEqual(
      results.map((r) => [r.mandateId, r.status, r.errorCode ?? null]),
      [
        [1, "settled", null],
        [2, "failed", "Error(Contract, #3)"],
        [3, "failed", "SUBMIT_FAILED"],
        [4, "failed", "NOT_FOUND"],
        [5, "settled", null],
        [6, "settled", null],
      ],
    );
    assert.match(results[2]!.error ?? "", /ECONNREFUSED/);
    assert.deepEqual(
      attempts(db).filter((row) => row.result === "failed").map((row) => [row.mandate_id, row.error_code]).sort(),
      [[2, "Error(Contract, #3)"], [3, "SUBMIT_FAILED"], [4, "NOT_FOUND"]],
      "every failure is recorded with its reason",
    );
    assert.equal(keeper.inFlight, 0, "every channel came back");

    // The channels the failures used are free: the next pass uses all three.
    insertDue(db, 7, 8, 9);
    const next = await keeper.tick(NOW + 1);
    assert.deepEqual(next.map((r) => [r.mandateId, r.status]), [[7, "settled"], [8, "settled"], [9, "settled"]]);
    db.close();
  });

  test("txBadSeq refreshes the channel's sequence from the network and resubmits", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1);
    const t = trace();
    const keeper = new Keeper(
      db,
      fakeNode(t, (_mandates, previous) => (previous === 0 ? "badSeq" : "settle")),
      channelConfig(keys(1)),
    );

    const results = await keeper.tick(NOW);

    assert.equal(results[0]!.status, "settled");
    assert.equal(t.sends.length, 2, "one refused submission, one accepted");
    assert.equal(t.getAccounts.length, 2, "the account is re-read before the resubmission");
    assert.deepEqual(t.collisions, []);
    db.close();
  });

  test("txBadSeq retries are bounded, then the mandate fails and backs off", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2);
    const t = trace();
    const keeper = new Keeper(
      db,
      fakeNode(t, ([id]) => (id === 1 ? "badSeq" : "settle")),
      channelConfig(keys(2)),
    );

    const results = await keeper.tick(NOW);

    assert.deepEqual(results.map((r) => [r.mandateId, r.status, r.errorCode ?? null]), [
      [1, "failed", "txBadSeq"],
      [2, "settled", null],
    ]);
    assert.equal(t.sends.filter((send) => send.mandates[0] === 1).length, 3, "the first try plus two retries");
    assert.equal(keeper.retryIn(1, NOW), 60);
    db.close();
  });

  test("a charge_many refused with txBadSeq is resubmitted with a fresh sequence", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3);
    const t = trace();
    const keeper = new Keeper(
      db,
      fakeNode(t, (mandates, previous) => (mandates.length > 1 && previous === 0 ? "badSeq" : "settle")),
      channelConfig(keys(1), { KEEPER_BATCH: true }),
    );

    const results = await keeper.tick(NOW);

    assert.deepEqual(results.map((r) => r.status), ["settled", "settled", "settled"]);
    assert.equal(t.sends.length, 2);
    assert.ok(t.sends.every((send) => send.mandates.length === 3), "both submissions were the batch");
    db.close();
  });
});

describe("keeper authorization failures (#249)", () => {
  test("a refused authorization fails with a clear reason and is not retried within the pass", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3);
    const t = trace();
    const behaviour: Record<number, Behaviour> = { 1: "authError", 2: "badAuth" };
    const keeper = new Keeper(db, fakeNode(t, ([id]) => behaviour[id!] ?? "settle"), channelConfig(keys(2)));

    const results = await keeper.tick(NOW);

    assert.deepEqual(results.map((r) => [r.mandateId, r.status, r.errorCode ?? null]), [
      [1, "failed", "Error(Auth, InvalidAction)"],
      [2, "failed", "txBadAuth"],
      [3, "settled", null],
    ]);
    assert.match(results[0]!.error ?? "", /Error\(Auth, InvalidAction\)/);
    assert.equal(t.prepares.filter(([id]) => id === 1).length, 1, "a refused auth is simulated once");
    assert.equal(t.sends.filter((send) => send.mandates[0] === 2).length, 1, "a txBadAuth is submitted once");

    // They back off like any failure instead of being hammered every pass.
    assert.equal(keeper.retryIn(1, NOW), 60);
    assert.equal(keeper.retryIn(2, NOW), 60);
    assert.deepEqual(await keeper.tick(NOW + 1), []);
    db.close();
  });
});

describe("keeper graceful shutdown (#249)", () => {
  test("stop lets in-flight settlements finish and starts no new ones", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3, 4, 5, 6);
    const t = trace();
    const keeper = new Keeper(db, fakeNode(t, () => "settle", 40), channelConfig(keys(2)));

    const pass = keeper.tick(NOW);
    while (t.sends.length < 2) await new Promise((resolve) => setImmediate(resolve));
    keeper.stop();
    const results = await pass;

    assert.deepEqual(results.map((r) => [r.mandateId, r.status]), [[1, "settled"], [2, "settled"]]);
    assert.equal(t.sends.length, 2, "nothing was submitted after stop");
    assert.deepEqual(attempts(db).map((row) => row.mandate_id), [1, 2], "the in-flight ones were recorded");
    assert.equal(keeper.inFlight, 0);
    assert.deepEqual(await keeper.tick(NOW + 1), [], "a stopped keeper starts no new pass");
    db.close();
  });
});
