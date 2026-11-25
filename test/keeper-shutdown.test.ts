import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { Account, Keypair, Operation, Transaction, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { claimCharge } from "../src/lib/claims.ts";
import { asStorage } from "../src/lib/store/index.ts";
import type { Storage } from "../src/lib/store/types.ts";
import { Keeper, settleOnce, type KeeperRpc } from "../src/keeper.ts";
import type { Config } from "../src/config.ts";

/**
 * Issue #255: on SIGTERM the keeper stops picking up new mandates and lets
 * the submissions already in flight complete — and be recorded — before the
 * process exits. Confirmation is gated by the test, so every interleaving
 * here is deterministic and nothing touches a network.
 */

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const NOW = 10_000;

type Db = ReturnType<typeof openDatabase>;

function config(channels = 1): Config {
  const [primary, ...rest] = Array.from({ length: channels }, () => Keypair.random());
  return {
    PLAN_REGISTRY_ID: CONTRACT,
    VAULT_ID: CONTRACT,
    SUBSCRIPTION_ID: CONTRACT,
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    KEEPER_SECRET: primary!.secret(),
    KEEPER_CHANNEL_SECRETS: rest.map((key) => key.secret()),
    KEEPER_FEE_PERCENTILE: "90",
    KEEPER_MAX_FEE: "100000",
    KEEPER_BATCH: false,
    KEEPER_BATCH_SIZE: 10,
    KEEPER_BACKOFF_JITTER: 0,
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

function attempts(db: Db): { mandate_id: number; result: string; error_code: string | null }[] {
  return (
    db.prepare("SELECT mandate_id, result, error_code FROM charge_attempts ORDER BY id").all() as unknown as {
      mandate_id: number;
      result: string;
      error_code: string | null;
    }[]
  ).map((row) => ({ ...row }));
}

function mandatesOf(tx: Transaction): number[] {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = (op.func as unknown as { invokeContract: { args: xdr.ScVal[] } }).invokeContract;
  const native: unknown = scValToNative(call.args[0]!);
  return Array.isArray(native) ? native.map(Number) : [Number(native)];
}

/**
 * A node whose confirmations wait for the test: `confirm()` lets every
 * submission so far land. `failing` mandates land as FAILED; `authRefused`
 * ones are refused in simulation and never submitted.
 */
function gatedNode(
  options: { failing?: number[]; authRefused?: number[]; onPrepare?: (mandates: number[]) => void } = {},
) {
  const sends: number[][] = [];
  const outcome = new Map<string, number[]>();
  let open!: () => void;
  let gate = new Promise<void>((resolve) => (open = resolve));
  const server: KeeperRpc = {
    getFeeStats: async () => ({ sorobanInclusionFee: { p90: "1000" } }) as never,
    getAccount: async (address: string) => new Account(address, "1") as never,
    prepareTransaction: async (tx) => {
      options.onPrepare?.(mandatesOf(tx as Transaction));
      if (mandatesOf(tx as Transaction).some((id) => options.authRefused?.includes(id))) {
        throw new Error("HostError: Error(Auth, InvalidAction)");
      }
      return tx as Transaction;
    },
    sendTransaction: async (tx) => {
      const transaction = tx as Transaction;
      const mandates = mandatesOf(transaction);
      sends.push(mandates);
      const hash = Buffer.from(transaction.hash()).toString("hex");
      outcome.set(hash, mandates);
      return { status: "PENDING", hash } as never;
    },
    getTransaction: async (hash: string) => {
      await gate;
      const failed = outcome.get(hash)!.some((id) => options.failing?.includes(id));
      return {
        status: failed ? rpc.Api.GetTransactionStatus.FAILED : rpc.Api.GetTransactionStatus.SUCCESS,
      } as never;
    },
  };
  return {
    server,
    sends,
    confirm(): void {
      open();
      gate = new Promise<void>((resolve) => (open = resolve));
    },
  };
}

/** Yield until `condition` holds; the fake node never sleeps, so this is quick. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; !condition(); i++) {
    if (i > 10_000) throw new Error("condition never held");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("keeper graceful shutdown (#255)", () => {
  test("stop() resolves only once the in-flight charge has finished and been recorded", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3);
    const node = gatedNode();
    const keeper = new Keeper(db, node.server, config());

    const pass = keeper.tick(NOW);
    await until(() => node.sends.length === 1);
    let stopped = false;
    const stopping = keeper.stop().then(() => (stopped = true));
    assert.equal(keeper.isStopping, true);
    assert.equal(keeper.inFlight, 1);

    // Still waiting on the chain: stop() must not resolve yet.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, "stop() waits for the in-flight charge");
    assert.deepEqual(attempts(db), []);

    node.confirm();
    await stopping;
    const results = await pass;
    assert.deepEqual(results.map((r) => [r.mandateId, r.status]), [[1, "settled"]]);
    assert.deepEqual(node.sends, [[1]], "mandates 2 and 3 were never picked up");
    assert.deepEqual(attempts(db), [{ mandate_id: 1, result: "settled", error_code: null }]);
    assert.equal(keeper.inFlight, 0);
    db.close();
  });

  test("with several channels, every charge already in flight completes; nothing new starts", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3, 4, 5, 6);
    const node = gatedNode();
    const keeper = new Keeper(db, node.server, config(3));

    const pass = keeper.tick(NOW);
    await until(() => node.sends.length === 3);
    const stopping = keeper.stop();
    node.confirm();
    await stopping;

    assert.deepEqual((await pass).map((r) => r.mandateId), [1, 2, 3]);
    assert.equal(node.sends.length, 3);
    assert.deepEqual(attempts(db).map((row) => row.mandate_id).sort(), [1, 2, 3]);
    db.close();
  });

  test("an in-flight charge that fails on chain is still recorded and backs off", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2);
    const node = gatedNode({ failing: [1] });
    const keeper = new Keeper(db, node.server, config());

    const pass = keeper.tick(NOW);
    await until(() => node.sends.length === 1);
    const stopping = keeper.stop();
    node.confirm();
    await stopping;

    assert.deepEqual((await pass).map((r) => [r.mandateId, r.status]), [[1, "failed"]]);
    assert.deepEqual(attempts(db), [{ mandate_id: 1, result: "failed", error_code: "FAILED" }]);
    assert.equal(keeper.retryIn(1, NOW), 60, "the failure backs off like any other");
    db.close();
  });

  test("an authorization refusal finishing during shutdown is recorded, and nothing after it runs", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2);
    const ref: { keeper?: Keeper } = {};
    // SIGTERM lands while mandate 1's charge is being simulated — the
    // simulation then refuses authorization.
    const node = gatedNode({ authRefused: [1], onPrepare: () => void ref.keeper!.stop() });
    const keeper = (ref.keeper = new Keeper(db, node.server, config()));

    const results = await keeper.tick(NOW);

    assert.deepEqual(results.map((r) => [r.mandateId, r.status, r.errorCode]), [
      [1, "failed", "Error(Auth, InvalidAction)"],
    ]);
    assert.deepEqual(node.sends, [], "a refused simulation is never submitted");
    assert.deepEqual(attempts(db), [{ mandate_id: 1, result: "failed", error_code: "Error(Auth, InvalidAction)" }]);
    assert.ok(keeper.retryIn(1, NOW) > 0, "the refusal still schedules a retry");
    db.close();
  });

  test("stop() with nothing running resolves at once, is idempotent, and later passes do nothing", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1);
    const node = gatedNode();
    const keeper = new Keeper(db, node.server, config());

    await keeper.stop();
    await keeper.stop();
    assert.deepEqual(await keeper.tick(NOW), []);
    assert.deepEqual(node.sends, []);
    assert.deepEqual(attempts(db), []);
    db.close();
  });

  test("claims taken just as stop() lands are released, so another keeper can settle them at once", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1);
    const node = gatedNode();
    const base = asStorage(db);
    const ref: { keeper?: Keeper } = {};
    // Land stop() right after the claim's upsert commits, before submission.
    const storage = new Proxy(base, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== "get" || typeof value !== "function") return value;
        return async (sql: string, params?: unknown[]) => {
          const row = await (value as Storage["get"]).call(target, sql, params as never);
          if (sql.includes("INSERT INTO keeper_claims")) void ref.keeper!.stop();
          return row;
        };
      },
    }) as Storage;
    const keeper = (ref.keeper = new Keeper(storage, node.server, config()));

    assert.deepEqual(await keeper.tick(NOW), []);
    assert.deepEqual(node.sends, [], "the claimed charge was never submitted");
    const claim = db.prepare("SELECT expires_at FROM keeper_claims WHERE mandate_id = 1").get() as
      | { expires_at: number }
      | undefined;
    // Expired on the way out — and then pruned by the end of the pass.
    assert.ok(claim === undefined || claim.expires_at <= NOW, "the claim was released");
    assert.equal(
      await claimCharge(base, { mandateId: 1, dueAt: 1_001, owner: "other-keeper", now: NOW, ttlSeconds: 300 }),
      true,
      "another keeper wins it without waiting for the TTL",
    );
    assert.deepEqual(attempts(db), [], "an unsubmitted charge is not an attempt");
    db.close();
  });
});

describe("settleOnce: the standalone keeper command's SIGTERM handling (#255)", () => {
  test("SIGTERM mid-pass finishes the in-flight charge, reports the signal and removes its listeners", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2, 3);
    const node = gatedNode();
    const keeper = new Keeper(db, node.server, config());
    const signals = new EventEmitter();

    const run = settleOnce(keeper, { timeoutMs: 5_000, signals, now: NOW });
    await until(() => node.sends.length === 1);
    assert.equal(signals.listenerCount("SIGTERM"), 1);
    signals.emit("SIGTERM");
    signals.emit("SIGINT"); // a second signal changes nothing
    node.confirm();
    const outcome = await run;

    assert.equal(outcome.signal, "SIGTERM");
    assert.equal(outcome.timedOut, false);
    assert.deepEqual(outcome.results?.map((r) => [r.mandateId, r.status]), [[1, "settled"]]);
    assert.deepEqual(node.sends, [[1]]);
    assert.deepEqual(attempts(db).map((row) => row.mandate_id), [1]);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    db.close();
  });

  test("SIGINT is handled the same way", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2);
    const node = gatedNode();
    const keeper = new Keeper(db, node.server, config());
    const signals = new EventEmitter();

    const run = settleOnce(keeper, { timeoutMs: 5_000, signals, now: NOW });
    await until(() => node.sends.length === 1);
    signals.emit("SIGINT");
    node.confirm();
    const outcome = await run;

    assert.equal(outcome.signal, "SIGINT");
    assert.deepEqual(outcome.results?.map((r) => r.mandateId), [1]);
    db.close();
  });

  test("without a signal the whole pass runs", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2);
    const node = gatedNode();
    const keeper = new Keeper(db, node.server, config());
    const signals = new EventEmitter();

    const run = settleOnce(keeper, { timeoutMs: 5_000, signals, now: NOW });
    await until(() => node.sends.length === 1);
    node.confirm();
    await until(() => node.sends.length === 2);
    node.confirm();
    const outcome = await run;

    assert.equal(outcome.signal, undefined);
    assert.equal(outcome.timedOut, false);
    assert.deepEqual(outcome.results?.map((r) => r.mandateId), [1, 2]);
    db.close();
  });

  test("a charge stuck past the shutdown deadline is abandoned with timedOut", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 2);
    const node = gatedNode(); // never confirmed
    const keeper = new Keeper(db, node.server, config());
    const signals = new EventEmitter();

    const run = settleOnce(keeper, { timeoutMs: 20, signals, now: NOW });
    await until(() => node.sends.length === 1);
    signals.emit("SIGTERM");
    const outcome = await run;

    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.signal, "SIGTERM");
    assert.equal(outcome.results, undefined);
    assert.equal(keeper.inFlight, 1, "the stuck charge is still in flight; its claim will lapse");
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.deepEqual(node.sends, [[1]], "nothing new was started while waiting");
    node.confirm(); // let the abandoned pass finish so the database can close
    await keeper.stop();
    db.close();
  });

  test("a pass that throws comes back as an error instead of rejecting", async () => {
    const db = openDatabase(":memory:");
    const node = gatedNode();
    const broken = new Proxy(asStorage(db), {
      get(target, prop, receiver) {
        if (prop === "all") return async () => Promise.reject(new Error("database is locked"));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Storage;
    const keeper = new Keeper(broken, node.server, config());
    const signals = new EventEmitter();

    const outcome = await settleOnce(keeper, { timeoutMs: 5_000, signals, now: NOW });

    assert.match(String(outcome.error), /database is locked/);
    assert.equal(outcome.results, undefined);
    assert.equal(outcome.timedOut, false);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    db.close();
  });
});
