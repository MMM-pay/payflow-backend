import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  Account,
  Keypair,
  StrKey,
  Transaction,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { Keeper, type KeeperRpc } from "../src/keeper.ts";
import { loadConfig } from "../src/config.ts";
import { logger } from "../src/lib/logger.ts";
import type { Config } from "../src/config.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const keyA = Keypair.random();
const keyB = Keypair.random();

function keeperConfig(
  secrets: {
    KEEPER_SECRET?: string;
    KEEPER_SECRET_NEXT?: string;
    /** Post-loadConfig shape: the schema splits KEEPER_CHANNEL_SECRETS on commas. */
    KEEPER_CHANNEL_SECRETS?: string[];
  },
  order?: "oldest" | "largest",
  fees: { KEEPER_FEE_PERCENTILE?: string; KEEPER_MAX_FEE?: string } = {},
  toggles: { KEEPER_DRY_RUN?: boolean } = {},
): Config {
  return {
    PLAN_REGISTRY_ID: CONTRACT,
    VAULT_ID: CONTRACT,
    SUBSCRIPTION_ID: CONTRACT,
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    ...(order ? { KEEPER_ORDER: order } : {}),
    KEEPER_FEE_PERCENTILE: "90",
    KEEPER_MAX_FEE: "100000",
    ...fees,
    ...toggles,
    ...secrets,
  } as unknown as Config;
}

/**
 * A fake RPC node that only knows the accounts in `funded`: `getAccount`
 * fails for any other key, exactly like a missing or unfunded source account.
 * Everything else passes transactions through and reports success.
 */
function fakeRpc(funded: Set<string>, submitted: string[] = []): KeeperRpc {
  return {
    getFeeStats: async () => ({
      sorobanInclusionFee: { p90: "1000" },
    }) as never,
    getAccount: async (address: string) => {
      if (!funded.has(address)) {
        throw new Error(`The source account ${address} was not found`);
      }
      return new Account(address, "1") as never;
    },
    prepareTransaction: async (tx) => tx as Transaction,
    sendTransaction: async (tx) => {
      const hash = Buffer.from((tx as Transaction).hash()).toString("hex");
      submitted.push(hash);
      return {
        status: "PENDING",
        hash,
      } as never;
    },
    getTransaction: async () =>
      ({ status: rpc.Api.GetTransactionStatus.SUCCESS }) as never,
  };
}

function insertDue(db: ReturnType<typeof openDatabase>, id: number, nextCharge: number): void {
  insertMandate(db, id, nextCharge, "10");
}

function insertMandate(
  db: ReturnType<typeof openDatabase>,
  id: number,
  nextCharge: number,
  amount: string,
): void {
  db.prepare(
    `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
     VALUES (?, ?, ?, 1, ?, 60, ?, 'Active', 1)`,
  ).run(id, SUBSCRIBER, MERCHANT, amount, nextCharge);
}

/** Collect logger.info messages while running `fn`. */
async function captureInfoLog(fn: () => Promise<void>): Promise<string[]> {
  const messages: string[] = [];
  const original = logger.info;
  // keeper.ts holds the same logger instance, so the wrap is observed there.
  // Keep pino's `this` binding when delegating to the original method.
  (logger as { info: unknown }).info = function (this: unknown, ...args: unknown[]) {
    messages.push(typeof args[1] === "string" ? args[1] : String(args[0]));
    return (original as (this: unknown, ...a: unknown[]) => void).apply(this, args);
  };
  try {
    await fn();
  } finally {
    (logger as { info: unknown }).info = original;
  }
  return messages;
}

describe("keeper key rotation", () => {
  test("unusable primary rotates to KEEPER_SECRET_NEXT inside the same pass", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const submitted: string[] = [];
    // Only the standby key has a funded source account.
    const server = fakeRpc(new Set([keyB.publicKey()]), submitted);
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret(), KEEPER_SECRET_NEXT: keyB.secret() }),
    );
    assert.equal(keeper.publicKey, keyA.publicKey());

    const messages = await captureInfoLog(async () => {
      const results = await keeper.tick(10_000);
      assert.deepEqual(
        results.map((r) => r.status),
        ["settled"],
        "the mandate is settled despite the primary key being dead",
      );
      assert.equal(keeper.publicKey, keyB.publicKey(), "the keeper now signs with the new key");
      assert.equal(submitted.length, 1, "exactly one transaction hit the network");
    });

    assert.ok(
      messages.some((m) => m.includes("can now be retired")),
      "a successful pass with the next key logs that the old key can be retired",
    );
    db.close();
  });

  test("later passes keep settling and report the retirement only once", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    insertDue(db, 2, 1_001);
    const server = fakeRpc(new Set([keyB.publicKey()]));
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret(), KEEPER_SECRET_NEXT: keyB.secret() }),
    );

    const first = await keeper.tick(10_000);
    assert.equal(first[0]!.status, "settled");

    insertDue(db, 3, 1_002);
    const second = await keeper.tick(10_061);
    assert.equal(second[0]!.status, "settled", "rotation is sticky; no downtime next pass");
    assert.equal(keeper.publicKey, keyB.publicKey());
    db.close();
  });

  test("keys swap between passes via config reload, without a restart", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const server = fakeRpc(new Set([keyA.publicKey(), keyB.publicKey()]));
    const keeper = new Keeper(db, server, keeperConfig({ KEEPER_SECRET: keyA.secret() }));
    assert.equal(keeper.publicKey, keyA.publicKey());

    // Pass 1 settles with the old key.
    const before = await keeper.tick(10_000);
    assert.equal(before[0]!.status, "settled");

    // The operator replaces KEEPER_SECRET in the env and sends SIGHUP;
    // index.ts re-reads the config and calls exactly this.
    keeper.reloadFromConfig(keeperConfig({ KEEPER_SECRET: keyB.secret() }));

    insertDue(db, 2, 1_001);
    const messages = await captureInfoLog(async () => {
      const after = await keeper.tick(10_061);
      assert.equal(after[0]!.status, "settled", "the new key settles on the very next pass");
      assert.equal(keeper.publicKey, keyB.publicKey());
    });
    assert.ok(
      messages.some((m) => m.includes("can now be retired")),
      "after a swapped-in key succeeds, the old key is announced retireable",
    );
    db.close();
  });

  test("a mandate failing for non-key reasons does not rotate the key", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const server = {
      getAccount: async () => new Account(keyA.publicKey(), "1"),
      prepareTransaction: async () => {
        throw new Error("Simulation failed: InsufficientBalance");
      },
    } as unknown as KeeperRpc;
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret(), KEEPER_SECRET_NEXT: keyB.secret() }),
    );

    const results = await keeper.tick(10_000);
    assert.equal(results[0]!.status, "failed");
    assert.match(results[0]!.error ?? "", /InsufficientBalance/);
    assert.equal(keeper.publicKey, keyA.publicKey(), "an empty vault is not a key problem");
    db.close();
  });

  test("the keeper exposes only public keys, never secrets", () => {
    const keeper = new Keeper(
      openDatabase(":memory:"),
      fakeRpc(new Set()),
      keeperConfig({ KEEPER_SECRET: keyA.secret(), KEEPER_SECRET_NEXT: keyB.secret() }),
    );
    assert.deepEqual(keeper.keyPublicKeys, [keyA.publicKey(), keyB.publicKey()]);
    for (const k of keeper.keyPublicKeys) {
      assert.ok(k.startsWith("G"), "public keys only");
    }
  });

  test("KEEPER_SECRET_NEXT validates through the config schema", () => {
    const env = {
      PLAN_REGISTRY_ID: StrKey.encodeContract(Buffer.alloc(32)),
      VAULT_ID: StrKey.encodeContract(Buffer.alloc(32)),
      SUBSCRIPTION_ID: StrKey.encodeContract(Buffer.alloc(32)),
      KEEPER_SECRET: keyA.secret(),
      KEEPER_SECRET_NEXT: keyB.secret(),
    };
    const config = loadConfig(env as NodeJS.ProcessEnv);
    assert.equal(config.KEEPER_SECRET_NEXT, keyB.secret());
  });
});

/** Collect logger.warn messages while running `fn`. */
async function captureWarnLog(fn: () => Promise<void>): Promise<string[]> {
  const messages: string[] = [];
  const original = logger.warn;
  (logger as { warn: unknown }).warn = function (this: unknown, ...args: unknown[]) {
    messages.push(typeof args[1] === "string" ? args[1] : String(args[0]));
    return (original as (this: unknown, ...a: unknown[]) => void).apply(this, args);
  };
  try {
    await fn();
  } finally {
    (logger as { warn: unknown }).warn = original;
  }
  return messages;
}

describe("keeper channel accounts", () => {
  /**
   * A fake node that models account sequence numbers the way the real one
   * does: `getAccount` reports the last consumed sequence, `sendTransaction`
   * accepts only `last + 1` for the submitting account — anything else is
   * recorded as a collision — and accepting consumes the sequence.
   * `getTransaction` resolves after `confirmMs`, so channels that submit
   * inside the same window are in flight together; `state.maxInFlight`
   * records the peak.
   */
  function sequencingRpc(
    funded: Set<string>,
    state: {
      collisions: string[];
      submitted: { source: string; sequence: string }[];
      maxInFlight: number;
    },
    confirmMs = 50,
  ): KeeperRpc {
    const consumed = new Map<string, bigint>();
    let inFlight = 0;
    return {
      getFeeStats: async () => ({ sorobanInclusionFee: { p90: "1000" } }) as never,
      getAccount: async (address: string) => {
        if (!funded.has(address)) {
          throw new Error(`The source account ${address} was not found`);
        }
        return new Account(address, (consumed.get(address) ?? 0n).toString()) as never;
      },
      prepareTransaction: async (tx) => tx as Transaction,
      sendTransaction: async (tx) => {
        const t = tx as Transaction;
        const expected = (consumed.get(t.source) ?? 0n) + 1n;
        state.submitted.push({ source: t.source, sequence: t.sequence });
        if (BigInt(t.sequence) !== expected) {
          state.collisions.push(
            `${t.source} submitted sequence ${t.sequence}, expected ${expected}`,
          );
        }
        consumed.set(t.source, BigInt(t.sequence));
        inFlight += 1;
        if (inFlight > state.maxInFlight) state.maxInFlight = inFlight;
        return { status: "PENDING", hash: Buffer.from(t.hash()).toString("hex") } as never;
      },
      getTransaction: async () => {
        await new Promise((resolve) => setTimeout(resolve, confirmMs));
        inFlight -= 1;
        return { status: rpc.Api.GetTransactionStatus.SUCCESS } as never;
      },
    };
  }

  function channelState(): {
    collisions: string[];
    submitted: { source: string; sequence: string }[];
    maxInFlight: number;
  } {
    return { collisions: [], submitted: [], maxInFlight: 0 };
  }

  test("three channels settle in parallel with no sequence-number collisions", async () => {
    const db = openDatabase(":memory:");
    for (let id = 1; id <= 6; id += 1) insertDue(db, id, 1_000 + id);
    const channelA = Keypair.random();
    const channelB = Keypair.random();
    const channelC = Keypair.random();
    const state = channelState();
    const funded = new Set([
      channelA.publicKey(),
      channelB.publicKey(),
      channelC.publicKey(),
    ]);
    const keeper = new Keeper(
      db,
      sequencingRpc(funded, state),
      keeperConfig({
        KEEPER_SECRET: channelA.secret(),
        KEEPER_CHANNEL_SECRETS: [channelB.secret(), channelC.secret()],
      }),
    );
    assert.equal(keeper.channelCount, 3, "the primary key plus two channel accounts");

    const results = await keeper.tick(10_000);

    assert.deepEqual(
      results.map((r) => r.mandateId),
      [1, 2, 3, 4, 5, 6],
      "every due mandate settles and results stay in due order across channels",
    );
    assert.ok(
      results.every((r) => r.status === "settled"),
      `no mandate failed: ${results.map((r) => r.error ?? r.status).join(", ")}`,
    );
    assert.deepEqual(
      state.collisions,
      [],
      "each account's transactions advance its sequence by exactly one, never colliding",
    );
    assert.equal(state.submitted.length, 6, "one transaction per mandate");
    const expected = [channelA.publicKey(), channelB.publicKey(), channelC.publicKey()].sort();
    assert.deepEqual(
      [...new Set(state.submitted.map((s) => s.source))].sort(),
      expected,
      "all three channel accounts signed their own transactions",
    );
    assert.ok(
      state.maxInFlight >= 2,
      `channels settle in parallel, not one after another (peak in flight: ${state.maxInFlight})`,
    );
    db.close();
  });

  test("a channel whose key is dead is skipped and its mandates settle on live channels", async () => {
    const db = openDatabase(":memory:");
    for (let id = 1; id <= 4; id += 1) insertDue(db, id, 1_000 + id);
    const deadChannel = Keypair.random(); // deliberately unfunded
    const liveChannel = Keypair.random();
    const state = channelState();
    // Primary keyA and the third channel are funded; the middle one is not.
    const funded = new Set([keyA.publicKey(), liveChannel.publicKey()]);
    const keeper = new Keeper(
      db,
      sequencingRpc(funded, state),
      keeperConfig({
        KEEPER_SECRET: keyA.secret(),
        KEEPER_CHANNEL_SECRETS: [deadChannel.secret(), liveChannel.secret()],
      }),
    );

    const warnings = await captureWarnLog(async () => {
      const results = await keeper.tick(10_000);
      assert.deepEqual(results.map((r) => r.mandateId), [1, 2, 3, 4]);
      assert.ok(
        results.every((r) => r.status === "settled"),
        "the dead channel's share settles through the live channels in the same pass",
      );
    });

    assert.ok(
      warnings.some((m) => m.includes("skipping this channel")),
      "the dropped channel is logged",
    );
    assert.ok(
      !state.submitted.some((s) => s.source === deadChannel.publicKey()),
      "the dead key never signs a transaction",
    );
    assert.deepEqual(state.collisions, []);
    db.close();
  });

  test("a single-key setup is unchanged: one account, no liveness probe", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    insertDue(db, 2, 1_001);
    const inner = fakeRpc(new Set([keyA.publicKey()]));
    let accountLookups = 0;
    const server: KeeperRpc = {
      ...inner,
      getAccount: async (address: string) => {
        accountLookups += 1;
        return inner.getAccount(address);
      },
    };
    const keeper = new Keeper(db, server, keeperConfig({ KEEPER_SECRET: keyA.secret() }));
    assert.equal(keeper.channelCount, 1);

    const results = await keeper.tick(10_000);

    assert.deepEqual(results.map((r) => r.mandateId), [1, 2]);
    assert.ok(results.every((r) => r.status === "settled"));
    assert.equal(
      accountLookups,
      2,
      "exactly one getAccount per charge: a lone channel is never probed for liveness",
    );
    db.close();
  });

  test("KEEPER_CHANNEL_SECRETS repeating the primary key does not duplicate the channel", () => {
    const keeper = new Keeper(
      openDatabase(":memory:"),
      fakeRpc(new Set()),
      keeperConfig({
        KEEPER_SECRET: keyA.secret(),
        KEEPER_CHANNEL_SECRETS: [keyA.secret(), keyB.secret(), keyA.secret()],
      }),
    );
    assert.equal(keeper.channelCount, 2, "duplicates collapse into the existing channels");
    assert.deepEqual(keeper.keyPublicKeys, [keyA.publicKey(), keyB.publicKey()]);
  });
});

describe("keeper due-mandate ordering", () => {
  /** findDue never touches the network, so an unfunded fake RPC suffices. */
  function orderingKeeper(
    db: ReturnType<typeof openDatabase>,
    order?: "oldest" | "largest",
  ): Keeper {
    return new Keeper(
      db,
      fakeRpc(new Set()),
      keeperConfig({ KEEPER_SECRET: keyA.secret() }, order),
    );
  }

  test("oldest-due first is the default when KEEPER_ORDER is unset", () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_000, "5");
    insertMandate(db, 2, 1_001, "1000000"); // bigger, but due later
    const due = orderingKeeper(db).findDue(2_000);
    assert.deepEqual(
      due.map((m) => m.id),
      [1, 2],
      "an unset order keeps today's oldest-due behaviour; callers are not reordered",
    );
    db.close();
  });

  test("KEEPER_ORDER=oldest sorts by due date regardless of amount", () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_002, "9000000");
    insertMandate(db, 2, 1_000, "100");
    insertMandate(db, 3, 1_001, "500000000");
    const due = orderingKeeper(db, "oldest").findDue(2_000);
    assert.deepEqual(
      due.map((m) => m.id),
      [2, 3, 1],
    );
    db.close();
  });

  test("KEEPER_ORDER=largest sorts by amount descending", () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_000, "5");
    insertMandate(db, 2, 1_001, "1000000");
    insertMandate(db, 3, 1_002, "700");
    const due = orderingKeeper(db, "largest").findDue(2_000);
    assert.deepEqual(
      due.map((m) => m.id),
      [2, 3, 1],
      "largest amount first, even though mandate 2 is also the oldest",
    );
    db.close();
  });

  test("largest compares decimal strings exactly, beyond float precision", () => {
    const db = openDatabase(":memory:");
    // 2^53 + 1 and 2^53 are indistinguishable as JS numbers but not as BigInt.
    insertMandate(db, 1, 1_000, "9007199254740992");
    insertMandate(db, 2, 1_001, "9007199254740993");
    // A lexicographic TEXT sort would put "5..." before "10...".
    insertMandate(db, 3, 1_002, "5000000");
    insertMandate(db, 4, 1_003, "10000000000");
    const due = orderingKeeper(db, "largest").findDue(2_000);
    assert.deepEqual(
      due.map((m) => m.id),
      [2, 1, 4, 3],
    );
    db.close();
  });

  test("largest breaks ties by oldest-due, then id", () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_002, "700");
    insertMandate(db, 2, 1_000, "700");
    insertMandate(db, 3, 1_001, "700");
    const due = orderingKeeper(db, "largest").findDue(2_000);
    assert.deepEqual(
      due.map((m) => m.id),
      [2, 3, 1],
      "equal amounts settle oldest-due first, so the order stays deterministic",
    );
    db.close();
  });

  test("largest still respects the batch limit", () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_000, "5");
    insertMandate(db, 2, 1_001, "1000");
    insertMandate(db, 3, 1_002, "70");
    insertMandate(db, 4, 1_003, "400");
    const due = orderingKeeper(db, "largest").findDue(2_000, 2);
    assert.deepEqual(
      due.map((m) => m.id),
      [2, 4],
      "the batch is the two largest amounts, not the first two rows",
    );
    db.close();
  });

  test("largest skips mandates that are backing off after a failure", async () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_000, "900");
    insertMandate(db, 2, 1_001, "100");
    // The largest mandate fails simulation, so it enters backoff.
    const server = {
      ...fakeRpc(new Set([keyA.publicKey()])),
      prepareTransaction: async (tx: Transaction) => {
        // The charge call is operations[0].func.invokeContract.args[0].
        const { func } = tx.operations[0] as unknown as {
          func: { invokeContract: { args: Parameters<typeof scValToNative>[0][] } };
        };
        const mandateId = Number(scValToNative(func.invokeContract.args[0]!));
        if (mandateId === 1) throw new Error("Simulation failed: InsufficientFunds");
        return tx;
      },
    } as unknown as KeeperRpc;
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret() }, "largest"),
    );

    const first = await keeper.tick(10_000);
    assert.deepEqual(
      first.map((r) => r.mandateId),
      [1, 2],
      "the pass tries the largest first, whatever the outcome",
    );
    assert.equal(first[0]!.status, "failed");
    assert.equal(first[1]!.status, "settled");

    const nextBatch = keeper.findDue(10_030);
    assert.deepEqual(
      nextBatch.map((m) => m.id),
      [2],
      "mandate 1 is backing off and cannot fill the next batch",
    );
    db.close();
  });

  test("tick settles mandates in the configured largest order", async () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_000, "5");
    insertMandate(db, 2, 1_001, "1000000");
    insertMandate(db, 3, 1_002, "700");
    const server = fakeRpc(new Set([keyA.publicKey()]));
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret() }, "largest"),
    );

    const results = await keeper.tick(10_000);
    assert.deepEqual(
      results.map((r) => r.mandateId),
      [2, 3, 1],
      "settlement follows the configured order, not the due date",
    );
    db.close();
  });
});

describe("keeper congestion fee retry", () => {
  test("retries TRY_AGAIN_LATER once and caps the higher fee", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const fees: string[] = [];
    let attempts = 0;
    const server = {
      ...fakeRpc(new Set([keyA.publicKey()])),
      getFeeStats: async () => ({ sorobanInclusionFee: { p90: "1000" } }),
      sendTransaction: async (tx: Transaction) => {
        fees.push((tx as Transaction & { fee: string }).fee);
        attempts += 1;
        if (attempts === 1) return { status: "TRY_AGAIN_LATER" };
        return { status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex") };
      },
    } as unknown as KeeperRpc;
    const keeper = new Keeper(
      db,
      server,
      keeperConfig(
        { KEEPER_SECRET: keyA.secret() },
        undefined,
        { KEEPER_FEE_PERCENTILE: "90", KEEPER_MAX_FEE: "1500" },
      ),
    );

    const results = await keeper.tick(10_000);
    assert.equal(results[0]!.status, "settled");
    assert.deepEqual(fees, ["1000", "1500"]);
    db.close();
  });
});

describe("keeper settle transaction paths", () => {
  function settleKeeper(server: KeeperRpc): Keeper {
    return new Keeper(
      openDatabase(":memory:"),
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret() }),
    );
  }

  test("send ERROR returns a failed result", async () => {
    const server = {
      ...fakeRpc(new Set([keyA.publicKey()])),
      sendTransaction: async () => ({ status: "ERROR", errorResult: "contract rejected" }),
    } as unknown as KeeperRpc;
    const result = await settleKeeper(server).settle(7);
    assert.deepEqual(result, {
      mandateId: 7,
      status: "failed",
      error: "contract rejected",
    });
  });

  test("a transaction that remains NOT_FOUND returns a failed result", async (t) => {
    t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void) => {
      queueMicrotask(callback);
      return 0 as never;
    });
    let polls = 0;
    const server = {
      ...fakeRpc(new Set([keyA.publicKey()])),
      getTransaction: async () => {
        polls += 1;
        return { status: rpc.Api.GetTransactionStatus.NOT_FOUND };
      },
    } as unknown as KeeperRpc;
    const result = await settleKeeper(server).settle(8);
    assert.equal(result.mandateId, 8);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "NOT_FOUND");
    assert.ok(result.txHash);
    assert.equal(polls, 11);
  });

  test("a FAILED transaction returns its status", async () => {
    const server = {
      ...fakeRpc(new Set([keyA.publicKey()])),
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.FAILED }),
    } as unknown as KeeperRpc;
    const result = await settleKeeper(server).settle(9);
    assert.equal(result.mandateId, 9);
    assert.equal(result.status, "failed");
    assert.ok(result.txHash);
    assert.equal(result.error, rpc.Api.GetTransactionStatus.FAILED);
  });

  test("simulation errors return failed results without rotating", async () => {
    const server = {
      getAccount: async () => new Account(keyA.publicKey(), "1"),
      prepareTransaction: async () => {
        throw new Error("simulation rejected");
      },
    } as unknown as KeeperRpc;
    assert.deepEqual(await settleKeeper(server).settle(10), {
      mandateId: 10,
      status: "failed",
      error: "simulation rejected",
    });
  });

  test("a successful transaction returns its hash", async () => {
    const server = fakeRpc(new Set([keyA.publicKey()]));
    const result = await settleKeeper(server).settle(11);
    assert.equal(result.mandateId, 11);
    assert.equal(result.status, "settled");
    assert.match(result.txHash ?? "", /^[0-9a-f]{64}$/);
  });
});

describe("keeper pass history", () => {
  test("records failures, backoff seconds and only the latest 20 passes", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const server = {
      getAccount: async () => {
        throw new Error(`account ${keyA.publicKey()} ${keyA.secret()} not found`);
      },
    } as unknown as KeeperRpc;
    const keeper = new Keeper(db, server, keeperConfig({ KEEPER_SECRET: keyA.secret() }));
    const failed = await keeper.tick(10_000);
    assert.equal(failed[0]!.status, "failed");
    const firstPass = keeper.passHistory()[0]!;
    assert.equal(firstPass.backoff[0]!.retryIn, 60);
    assert.equal(firstPass.backoff[0]!.retryAt, 10_060);

    for (let time = 10_001; time < 10_020; time += 1) await keeper.tick(time);
    const history = keeper.passHistory();
    assert.equal(history.length, 20);
    assert.equal(history[0]!.time, 10_019);
    assert.equal(history.at(-1)!.time, 10_000);

    const failure = keeper.passHistory().find((pass) => pass.failures.length > 0)!.failures[0]!;
    assert.doesNotMatch(failure.error, new RegExp(keyA.publicKey()));
    assert.doesNotMatch(failure.error, new RegExp(keyA.secret()));
    assert.equal(history.at(-1)!.backoff[0]!.retryIn, 60);
    db.close();
  });
});

/**
 * The keeper's vault balance check.
 *
 * `charge` pulls the whole amount out of the subscriber's vault, so a vault
 * that holds less cannot pay: the simulation fails and the transaction is
 * wasted. Reading `vault.balance` first skips those mandates.
 */
describe("keeper vault balance check", () => {
  /** The token the seeded plans are denominated in. */
  const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  /** A plan, so a mandate knows which token its vault balance is about. */
  function insertPlan(db: ReturnType<typeof openDatabase>, id: number, token: string): void {
    db.prepare(
      `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
       VALUES (?, ?, 'p', ?, '1000', 60, 1, 1)`,
    ).run(id, MERCHANT, token);
  }

  /**
   * A node that answers the vault balance with `balance`, and refuses to
   * answer when it is null. Every simulation is recorded, so a test can see
   * which subscriber and token were asked about.
   */
  function balanceRpc(
    balance: bigint | null,
    submitted: string[],
    asked: { subscriber: string; token: string }[] = [],
  ): KeeperRpc {
    return {
      ...fakeRpc(new Set([keyA.publicKey()]), submitted),
      simulateTransaction: async (tx: Transaction) => {
        const { func } = tx.operations[0] as unknown as {
          func: { invokeContract: { functionName?: string; args: unknown[] } };
        };
        asked.push({
          subscriber: String(scValToNative(func.invokeContract.args[0]! as never)),
          token: String(scValToNative(func.invokeContract.args[1]! as never)),
        });
        if (balance === null) throw new Error("rpc unavailable");
        return {
          result: { retval: nativeToScVal(balance, { type: "i128" }) },
        } as never;
      },
    } as unknown as KeeperRpc;
  }

  test("reads the subscriber's balance for the mandate's token before settling", async () => {
    const db = openDatabase(":memory:");
    insertPlan(db, 1, TOKEN);
    insertMandate(db, 1, 1_000, "1000");
    const submitted: string[] = [];
    const asked: { subscriber: string; token: string }[] = [];
    const keeper = new Keeper(
      db,
      balanceRpc(1_000n, submitted, asked),
      keeperConfig({ KEEPER_SECRET: keyA.secret() }),
    );

    const results = await keeper.tick(10_000);

    assert.deepEqual(asked, [{ subscriber: SUBSCRIBER, token: TOKEN }]);
    assert.equal(results[0]!.status, "settled", "a vault that can cover the charge settles it");
    assert.equal(submitted.length, 1);
    db.close();
  });

  test("skips a mandate the vault cannot cover, and logs the shortfall once", async () => {
    const db = openDatabase(":memory:");
    insertPlan(db, 1, TOKEN);
    insertMandate(db, 1, 1_000, "1000");
    const submitted: string[] = [];
    const keeper = new Keeper(
      db,
      balanceRpc(400n, submitted),
      keeperConfig({ KEEPER_SECRET: keyA.secret() }),
    );

    const warnings = await captureWarnLog(async () => {
      const results = await keeper.tick(10_000);
      assert.deepEqual(results, [], "nothing was settled");
    });

    assert.equal(submitted.length, 0, "no transaction was built for a mandate the vault cannot cover");
    assert.equal(
      warnings.filter((message) => message.includes("cannot cover")).length,
      1,
      "the skipped mandate is logged once",
    );
    const pass = keeper.passHistory()[0]!;
    assert.equal(pass.skipped?.length, 1);
    assert.deepEqual(pass.skipped?.[0], {
      mandateId: 1,
      required: "1000",
      balance: "400",
      shortfall: "600",
    });
    db.close();
  });

  test("a skipped mandate does not take the batch's place", async () => {
    const db = openDatabase(":memory:");
    insertPlan(db, 1, TOKEN);
    // Two mandates of the same subscriber: the first one costs more than the
    // vault holds, the second one fits in what is left.
    insertMandate(db, 1, 1_000, "1000");
    insertMandate(db, 2, 1_001, "100");
    const submitted: string[] = [];
    const keeper = new Keeper(
      db,
      balanceRpc(400n, submitted),
      keeperConfig({ KEEPER_SECRET: keyA.secret() }),
    );

    const results = await keeper.tick(10_000);

    assert.deepEqual(results.map((r) => r.mandateId), [2], "the affordable mandate still settles");
    assert.equal(results[0]!.status, "settled");
    assert.equal(submitted.length, 1, "only the affordable mandate was charged");
    const pass = keeper.passHistory()[0]!;
    assert.equal(pass.skipped?.length, 1);
    assert.equal(pass.skipped?.[0]?.mandateId, 1);
    assert.equal(pass.skipped?.[0]?.shortfall, "600");
    db.close();
  });

  test("a balance that cannot be read leaves the charge to decide", async () => {
    const db = openDatabase(":memory:");
    insertPlan(db, 1, TOKEN);
    insertMandate(db, 1, 1_000, "1000");
    const submitted: string[] = [];
    const keeper = new Keeper(
      db,
      balanceRpc(null, submitted),
      keeperConfig({ KEEPER_SECRET: keyA.secret() }),
    );

    const results = await keeper.tick(10_000);

    assert.equal(results[0]!.status, "settled", "an unreadable balance is not a shortfall");
    assert.equal(submitted.length, 1);
    assert.equal(keeper.passHistory()[0]!.skipped?.length, 0);
    db.close();
  });

  test("an RPC without simulations settles exactly as before", async () => {
    const db = openDatabase(":memory:");
    insertPlan(db, 1, TOKEN);
    insertMandate(db, 1, 1_000, "1000");
    const submitted: string[] = [];
    const keeper = new Keeper(
      db,
      fakeRpc(new Set([keyA.publicKey()]), submitted),
      keeperConfig({ KEEPER_SECRET: keyA.secret() }),
    );

    const results = await keeper.tick(10_000);

    assert.equal(results[0]!.status, "settled");
    assert.equal(submitted.length, 1);
    db.close();
  });
});

/**
 * `KEEPER_DRY_RUN=true`: a pass builds and simulates every charge exactly as
 * a real one would, then stops — no signing, no `sendTransaction`, and no
 * bookkeeping changes (backoff, pass history, metrics). The acceptance
 * criterion for the issue is the first test: zero sendTransaction calls.
 */
describe("keeper dry run", () => {
  test("simulates every due charge and never calls sendTransaction", async () => {
    const db = openDatabase(":memory:");
    for (let id = 1; id <= 3; id += 1) insertDue(db, id, 1_000 + id);
    // fakeRpc records a submission only from its sendTransaction, so an
    // empty list is direct evidence the submit path was never reached.
    const submitted: string[] = [];
    const server = fakeRpc(new Set([keyA.publicKey()]), submitted);
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret() }, undefined, {}, { KEEPER_DRY_RUN: true }),
    );

    const messages = await captureInfoLog(async () => {
      const results = await keeper.tick(10_000);
      assert.deepEqual(
        results.map((r) => [r.mandateId, r.status]),
        [
          [1, "simulated"],
          [2, "simulated"],
          [3, "simulated"],
        ],
        "each due mandate reports its simulation outcome, in due order",
      );
      assert.ok(
        results.every((r) => r.txHash === undefined),
        "a simulated result carries no transaction hash: nothing landed",
      );
    });

    assert.equal(submitted.length, 0, "no sendTransaction call in dry run");
    assert.ok(
      messages.some((m) => m.includes("dry run")),
      "the mode and the outcomes are logged for the operator",
    );
    assert.equal(keeper.passHistory().length, 0, "a dry run records no pass history");
    assert.equal(keeper.retryIn(1, 10_000), 0, "no backoff comes from a dry run");
    assert.equal(keeper.backoffList(10_000).length, 0);
    db.close();
  });

  test("a failed simulation is reported per mandate and retried next pass", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    insertDue(db, 2, 1_001);
    insertDue(db, 3, 1_002);
    const submitted: string[] = [];
    const server = {
      ...fakeRpc(new Set([keyA.publicKey()]), submitted),
      prepareTransaction: async (tx: Transaction) => {
        const { func } = tx.operations[0] as unknown as {
          func: { invokeContract: { args: Parameters<typeof scValToNative>[0][] } };
        };
        const mandateId = Number(scValToNative(func.invokeContract.args[0]!));
        if (mandateId === 2) throw new Error("Simulation failed: InsufficientBalance");
        return tx;
      },
    } as unknown as KeeperRpc;
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret() }, undefined, {}, { KEEPER_DRY_RUN: true }),
    );

    const warnings = await captureWarnLog(async () => {
      const first = await keeper.tick(10_000);
      assert.deepEqual(
        first.map((r) => r.status),
        ["simulated", "simulated", "simulated"],
        "a dry run reports simulations, never real outcomes",
      );
      assert.match(
        first[1]!.error ?? "",
        /InsufficientBalance/,
        "the simulation's refusal rides along on the result",
      );
      assert.equal(first[0]!.error, undefined, "a charge that would succeed carries no error");

      // Nothing entered backoff, so the next dry pass rehearses everything.
      const second = await keeper.tick(10_001);
      assert.deepEqual(
        second.map((r) => r.mandateId),
        [1, 2, 3],
        "a dry-run failure does not back its mandate off",
      );
    });

    assert.ok(
      warnings.some((m) => m.includes("dry run: charge simulation failed")),
      "the would-fail charge is logged as a simulation failure",
    );
    assert.equal(keeper.retryIn(2, 10_001), 0);
    assert.equal(keeper.passHistory().length, 0, "still no pass history from dry runs");
    assert.equal(submitted.length, 0, "no sendTransaction call in either pass");
    db.close();
  });

  test("KEEPER_DRY_RUN=false submits and records exactly as before", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    insertDue(db, 2, 1_001);
    const submitted: string[] = [];
    const server = fakeRpc(new Set([keyA.publicKey()]), submitted);
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret() }, undefined, {}, { KEEPER_DRY_RUN: false }),
    );

    const results = await keeper.tick(10_000);

    assert.deepEqual(
      results.map((r) => r.status),
      ["settled", "settled"],
      "a real pass still reports on-chain outcomes",
    );
    assert.equal(submitted.length, 2, "one transaction per mandate");
    assert.equal(keeper.passHistory().length, 1, "real passes still record history");
    assert.match(results[0]!.txHash ?? "", /^[0-9a-f]{64}$/);
    db.close();
  });
});
