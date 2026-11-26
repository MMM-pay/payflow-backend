import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  Account,
  Keypair,
  StrKey,
  Transaction,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { Keeper, classifyFailure, type KeeperRpc } from "../src/keeper.ts";
import { loadConfig } from "../src/config.ts";
import { logger } from "../src/lib/logger.ts";
import type { ChargeStreakEvent } from "../src/lib/webhooks.ts";
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
  toggles: { KEEPER_DRY_RUN?: boolean; KEEPER_BATCH?: boolean; KEEPER_BATCH_SIZE?: number } = {},
): Config {
  return {
    PLAN_REGISTRY_ID: CONTRACT,
    VAULT_ID: CONTRACT,
    SUBSCRIPTION_ID: CONTRACT,
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    ...(order ? { KEEPER_ORDER: order } : {}),
    KEEPER_FEE_PERCENTILE: "90",
    KEEPER_MAX_FEE: "100000",
    KEEPER_BATCH: false,
    KEEPER_BATCH_SIZE: 10,
    // Exact retry times: the jitter has its own tests.
    KEEPER_BACKOFF_JITTER: 0,
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
  merchant: string = MERCHANT,
): void {
  db.prepare(
    `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
     VALUES (?, ?, ?, 1, ?, 60, ?, 'Active', 1)`,
  ).run(id, SUBSCRIBER, merchant, amount, nextCharge);
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

describe("keeper channel accounts", () => {
  test("uses one charge_many transaction for multiple due mandates when batching is enabled", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    insertDue(db, 2, 1_001);
    const submitted: string[] = [];
    const keeper = new Keeper(
      db,
      fakeRpc(new Set([keyA.publicKey()]), submitted),
      keeperConfig({ KEEPER_SECRET: keyA.secret() }, undefined, {}, { KEEPER_BATCH: true }),
    );

    const results = await keeper.tick(10_000);
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.status === "settled"));
    assert.equal(submitted.length, 1, "two mandates should share one transaction");
    db.close();
  });

  test("falls back to single charges when charge_many is unsupported", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    insertDue(db, 2, 1_001);
    const submitted: string[] = [];
    let prepareCalls = 0;
    const base = fakeRpc(new Set([keyA.publicKey()]), submitted);
    const server = {
      ...base,
      prepareTransaction: async (tx: Transaction) => {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          throw new Error("trying to invoke non-existent contract function charge_many");
        }
        return tx;
      },
    } as KeeperRpc;
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret() }, undefined, {}, { KEEPER_BATCH: true }),
    );

    const results = await keeper.tick(10_000);
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.status === "settled"));
    assert.equal(submitted.length, 2, "unsupported batch must fall back to two charge transactions");
    db.close();
  });

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

describe("keeper merchant filter (KEEPER_MERCHANTS)", () => {
  const OTHER_MERCHANT = Keypair.random().publicKey();
  const THIRD_MERCHANT = Keypair.random().publicKey();

  function merchantKeeper(
    db: ReturnType<typeof openDatabase>,
    merchants: string[] | undefined,
    order?: "oldest" | "largest",
  ): Keeper {
    const config = keeperConfig({ KEEPER_SECRET: keyA.secret() }, order);
    return new Keeper(
      db,
      fakeRpc(new Set()),
      merchants === undefined ? config : ({ ...config, KEEPER_MERCHANTS: merchants } as Config),
    );
  }

  function seed(db: ReturnType<typeof openDatabase>): void {
    insertMandate(db, 1, 1_000, "100", MERCHANT);
    insertMandate(db, 2, 1_001, "900", OTHER_MERCHANT);
    insertMandate(db, 3, 1_002, "500", THIRD_MERCHANT);
  }

  test("an empty list settles every merchant's mandates", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    assert.deepEqual((await merchantKeeper(db, []).findDue(2_000)).map((m) => m.id), [1, 2, 3]);
    assert.deepEqual((await merchantKeeper(db, undefined).findDue(2_000)).map((m) => m.id), [1, 2, 3]);
    db.close();
  });

  test("only the listed merchants' mandates are due", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    assert.deepEqual((await merchantKeeper(db, [MERCHANT]).findDue(2_000)).map((m) => m.id), [1]);
    assert.deepEqual(
      (await merchantKeeper(db, [MERCHANT, THIRD_MERCHANT]).findDue(2_000)).map((m) => m.id),
      [1, 3],
    );
    db.close();
  });

  test("the filter applies to KEEPER_ORDER=largest too", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    assert.deepEqual(
      (await merchantKeeper(db, [MERCHANT, THIRD_MERCHANT], "largest").findDue(2_000)).map((m) => m.id),
      [3, 1],
    );
    db.close();
  });

  test("a pass never charges another merchant's mandate", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const submitted: string[] = [];
    const keeper = new Keeper(db, fakeRpc(new Set([keyA.publicKey()]), submitted), {
      ...keeperConfig({ KEEPER_SECRET: keyA.secret() }),
      KEEPER_MERCHANTS: [OTHER_MERCHANT],
    } as Config);
    const results = await keeper.tick(2_000);
    assert.deepEqual(results.map((r) => r.mandateId), [2]);
    assert.equal(submitted.length, 1);
    db.close();
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

  test("oldest-due first is the default when KEEPER_ORDER is unset", async () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_000, "5");
    insertMandate(db, 2, 1_001, "1000000"); // bigger, but due later
    const due = await orderingKeeper(db).findDue(2_000);
    assert.deepEqual(
      due.map((m) => m.id),
      [1, 2],
      "an unset order keeps today's oldest-due behaviour; callers are not reordered",
    );
    db.close();
  });

  test("KEEPER_ORDER=oldest sorts by due date regardless of amount", async () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_002, "9000000");
    insertMandate(db, 2, 1_000, "100");
    insertMandate(db, 3, 1_001, "500000000");
    const due = await orderingKeeper(db, "oldest").findDue(2_000);
    assert.deepEqual(
      due.map((m) => m.id),
      [2, 3, 1],
    );
    db.close();
  });

  test("KEEPER_ORDER=largest sorts by amount descending", async () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_000, "5");
    insertMandate(db, 2, 1_001, "1000000");
    insertMandate(db, 3, 1_002, "700");
    const due = await orderingKeeper(db, "largest").findDue(2_000);
    assert.deepEqual(
      due.map((m) => m.id),
      [2, 3, 1],
      "largest amount first, even though mandate 2 is also the oldest",
    );
    db.close();
  });

  test("largest compares decimal strings exactly, beyond float precision", async () => {
    const db = openDatabase(":memory:");
    // 2^53 + 1 and 2^53 are indistinguishable as JS numbers but not as BigInt.
    insertMandate(db, 1, 1_000, "9007199254740992");
    insertMandate(db, 2, 1_001, "9007199254740993");
    // A lexicographic TEXT sort would put "5..." before "10...".
    insertMandate(db, 3, 1_002, "5000000");
    insertMandate(db, 4, 1_003, "10000000000");
    const due = await orderingKeeper(db, "largest").findDue(2_000);
    assert.deepEqual(
      due.map((m) => m.id),
      [2, 1, 4, 3],
    );
    db.close();
  });

  test("largest breaks ties by oldest-due, then id", async () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_002, "700");
    insertMandate(db, 2, 1_000, "700");
    insertMandate(db, 3, 1_001, "700");
    const due = await orderingKeeper(db, "largest").findDue(2_000);
    assert.deepEqual(
      due.map((m) => m.id),
      [2, 3, 1],
      "equal amounts settle oldest-due first, so the order stays deterministic",
    );
    db.close();
  });

  test("largest still respects the batch limit", async () => {
    const db = openDatabase(":memory:");
    insertMandate(db, 1, 1_000, "5");
    insertMandate(db, 2, 1_001, "1000");
    insertMandate(db, 3, 1_002, "70");
    insertMandate(db, 4, 1_003, "400");
    const due = await orderingKeeper(db, "largest").findDue(2_000, 2);
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

    const nextBatch = await keeper.findDue(10_030);
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
      errorCode: "ERROR",
    });
  });

  test("send ERROR carries the transaction result code stellar-core rejected it with", async () => {
    // A TransactionResult of txBAD_SEQ, as the RPC returns it in errorResultXdr.
    const errorResult = xdr.TransactionResult.fromXDR("AAAAAAAAAGT////7AAAAAA==", "base64");
    const server = {
      ...fakeRpc(new Set([keyA.publicKey()])),
      sendTransaction: async () => ({ status: "ERROR", errorResult }),
    } as unknown as KeeperRpc;
    const result = await settleKeeper(server).settle(7);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "txBadSeq");
  });

  test("a refused simulation carries the host error as its code", async () => {
    const server = {
      getAccount: async () => new Account(keyA.publicKey(), "1"),
      prepareTransaction: async () => {
        throw new Error("HostError: Error(Contract, #3)\n\nEvent log (newest first): ...");
      },
    } as unknown as KeeperRpc;
    const result = await settleKeeper(server).settle(10);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "Error(Contract, #3)");
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
      errorCode: "SUBMIT_FAILED",
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

  test("zero vault balance is a shortfall even for the smallest mandate amount", async () => {
    const db = openDatabase(":memory:");
    insertPlan(db, 1, TOKEN);
    insertMandate(db, 1, 1_000, "1");
    const submitted: string[] = [];
    const keeper = new Keeper(
      db,
      balanceRpc(0n, submitted),
      keeperConfig({ KEEPER_SECRET: keyA.secret() }),
    );

    const results = await keeper.tick(10_000);

    assert.deepEqual(results, [], "nothing was settled when vault is empty");
    assert.equal(submitted.length, 0);
    const pass = keeper.passHistory()[0]!;
    assert.equal(pass.skipped?.length, 1);
    assert.equal(pass.skipped?.[0]?.balance, "0");
    assert.equal(pass.skipped?.[0]?.required, "1");
    assert.equal(pass.skipped?.[0]?.shortfall, "1");
    db.close();
  });

  test("balance exactly equal to the required amount is not a shortfall", async () => {
    const db = openDatabase(":memory:");
    insertPlan(db, 1, TOKEN);
    insertMandate(db, 1, 1_000, "777");
    const submitted: string[] = [];
    const keeper = new Keeper(
      db,
      balanceRpc(777n, submitted),
      keeperConfig({ KEEPER_SECRET: keyA.secret() }),
    );

    const results = await keeper.tick(10_000);

    assert.equal(results[0]!.status, "settled", "balance === required should settle");
    assert.equal(submitted.length, 1);
    assert.equal(keeper.passHistory()[0]!.skipped?.length, 0);
    db.close();
  });

  test("simulateTransaction returning { error } is treated as unknown balance, not a shortfall", async () => {
    const db = openDatabase(":memory:");
    insertPlan(db, 1, TOKEN);
    insertMandate(db, 1, 1_000, "1000");
    const submitted: string[] = [];
    const errorRpc: KeeperRpc = {
      ...fakeRpc(new Set([keyA.publicKey()]), submitted),
      simulateTransaction: async () =>
        ({ error: "HostError: contract execution failed" }) as never,
    } as unknown as KeeperRpc;
    const keeper = new Keeper(
      db,
      errorRpc,
      keeperConfig({ KEEPER_SECRET: keyA.secret() }),
    );

    const results = await keeper.tick(10_000);

    assert.equal(
      results[0]!.status,
      "settled",
      "an error response is treated as null balance and the mandate proceeds",
    );
    assert.equal(submitted.length, 1);
    assert.equal(keeper.passHistory()[0]!.skipped?.length, 0);
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

/** A node whose simulations refuse every charge while `state.failing` holds, and settle it after. */
function switchableRpc(state: { failing: boolean }): KeeperRpc {
  const settles = fakeRpc(new Set([keyA.publicKey()]));
  return {
    ...settles,
    prepareTransaction: async (tx: Transaction) => {
      if (state.failing) throw new Error("HostError: Error(Contract, #3)");
      return settles.prepareTransaction(tx);
    },
  } as KeeperRpc;
}

interface AttemptRecord {
  mandate_id: number;
  attempted_at: number;
  result: string;
  error_code: string | null;
  tx_hash: string | null;
  shortfall: string | null;
  failures: number;
  retry_at: number | null;
}

function attemptsOf(db: ReturnType<typeof openDatabase>): AttemptRecord[] {
  return db
    .prepare(
      `SELECT mandate_id, attempted_at, result, error_code, tx_hash, shortfall, failures, retry_at
         FROM charge_attempts ORDER BY id`,
    )
    .all() as unknown as AttemptRecord[];
}

/** Issue #144: every attempt is persisted, and the backoff outlives the process. */
describe("keeper charge attempts", () => {
  test("records each attempt's time, result, error code and transaction hash", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const state = { failing: true };
    const keeper = new Keeper(db, switchableRpc(state), keeperConfig({ KEEPER_SECRET: keyA.secret() }));

    await keeper.tick(10_000);
    state.failing = false;
    await keeper.tick(10_060);

    const [failed, settled] = attemptsOf(db);
    assert.deepEqual({ ...failed }, {
      mandate_id: 1,
      attempted_at: 10_000,
      result: "failed",
      error_code: "Error(Contract, #3)",
      tx_hash: null,
      shortfall: null,
      failures: 1,
      retry_at: 10_060,
    });
    assert.equal(settled!.result, "settled");
    assert.equal(settled!.attempted_at, 10_060);
    assert.equal(settled!.error_code, null);
    assert.match(settled!.tx_hash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(settled!.failures, 0, "a settlement ends the streak");
    assert.equal(settled!.retry_at, null);
    db.close();
  });

  test("backoff survives a restart", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    insertDue(db, 2, 1_001);
    const state = { failing: true };
    const config = keeperConfig({ KEEPER_SECRET: keyA.secret() });
    const before = new Keeper(db, switchableRpc(state), config);
    await before.tick(10_000);
    await before.tick(10_060);

    // A new process on the same database resumes where the old one stopped.
    const after = new Keeper(db, switchableRpc(state), config);
    await after.ready;
    assert.deepEqual(after.backoffList(10_100), before.backoffList(10_100));
    assert.equal(after.retryIn(1, 10_100), 80, "the second failure's 120 s wait still holds");
    assert.deepEqual(await after.findDue(10_100), [], "a backing-off mandate is not retried early");

    // The streak continues rather than starting over at one failure.
    await after.tick(10_180);
    assert.deepEqual(after.backoffList(10_180).map((b) => b.failures), [3, 3]);
    assert.equal(after.retryIn(1, 10_180), 240);
    db.close();
  });

  test("a settled mandate is not restored into backoff", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const state = { failing: true };
    const config = keeperConfig({ KEEPER_SECRET: keyA.secret() });
    const keeper = new Keeper(db, switchableRpc(state), config);
    await keeper.tick(10_000);
    state.failing = false;
    await keeper.tick(10_060);

    const restarted = new Keeper(db, switchableRpc(state), config);
    await restarted.ready;
    assert.deepEqual(restarted.backoffList(10_060), []);
    db.close();
  });

  test("attempts older than 90 days are pruned", async () => {
    const db = openDatabase(":memory:");
    const now = 100_000_000;
    const ninetyDays = 90 * 24 * 60 * 60;
    const insert = db.prepare(
      `INSERT INTO charge_attempts (mandate_id, attempted_at, result, failures)
       VALUES (?, ?, 'settled', 0)`,
    );
    insert.run(1, now - ninetyDays - 1);
    insert.run(2, now - ninetyDays);
    const keeper = new Keeper(db, fakeRpc(new Set([keyA.publicKey()])), keeperConfig({ KEEPER_SECRET: keyA.secret() }));

    await keeper.tick(now);

    assert.deepEqual(
      attemptsOf(db).map((a) => a.mandate_id),
      [2],
      "only the attempt from beyond 90 days is gone",
    );
    db.close();
  });

  test("a dry run records no attempt", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const keeper = new Keeper(
      db,
      switchableRpc({ failing: true }),
      keeperConfig({ KEEPER_SECRET: keyA.secret() }, undefined, {}, { KEEPER_DRY_RUN: true }),
    );

    await keeper.tick(10_000);

    assert.deepEqual(attemptsOf(db), []);
    db.close();
  });
});

/**
 * Issue #324: the retry time after N consecutive failures follows the
 * documented policy — one minute, doubling, capped at six hours — and the
 * cap holds however long the streak lasts.
 */
describe("keeper backoff schedule", () => {
  /** The waits after the 1st, 2nd, ... failure: 60 s doubling, then 6 h flat. */
  const SCHEDULE = [60, 120, 240, 480, 960, 1_920, 3_840, 7_680, 15_360, 21_600, 21_600, 21_600];
  const START = 1_000_000;

  test("after each failure the next retry doubles from 60 s and caps at 6 h", async () => {
    const db = openDatabase(":memory:");
    // Due well before the first attempt; a failed charge never advances it.
    insertDue(db, 1, START - 10_000);
    const state = { failing: true };
    const keeper = new Keeper(db, switchableRpc(state), keeperConfig({ KEEPER_SECRET: keyA.secret() }));

    let now = START;
    for (const [index, wait] of SCHEDULE.entries()) {
      const results = await keeper.tick(now);
      assert.equal(results.length, 1, "the mandate is due at its retry time");
      assert.equal(results[0]!.status, "failed");

      const failures = index + 1;
      const retryAt = now + wait;
      assert.deepEqual(
        keeper.backoffList(now),
        [{ mandateId: 1, failures, retryAt, retryIn: wait }],
        `failure ${failures} schedules the next attempt ${wait} s out`,
      );
      assert.equal(keeper.retryIn(1, now), wait);

      // It is not retried early, and exactly at the computed time it is due.
      assert.deepEqual(await keeper.findDue(retryAt - 1), [], "no retry before the schedule");
      assert.deepEqual((await keeper.findDue(retryAt)).map((m) => m.id), [1]);

      // The persisted attempt carries the same streak and retry time the
      // in-memory backoff exposes, so a restart resumes the same schedule.
      const row = attemptsOf(db).at(-1)!;
      assert.equal(row.attempted_at, now);
      assert.equal(row.result, "failed");
      assert.equal(row.failures, failures);
      assert.equal(row.retry_at, retryAt);

      now = retryAt;
    }
    db.close();
  });

  test("a settlement clears the streak, so the next failure waits a minute again", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, START - 10_000);
    const state = { failing: true };
    const keeper = new Keeper(db, switchableRpc(state), keeperConfig({ KEEPER_SECRET: keyA.secret() }));

    // Four failures in a row: 60, 120, 240 and 480 s waits, next one 960 s.
    let now = START;
    for (const wait of SCHEDULE.slice(0, 4)) {
      await keeper.tick(now);
      now += wait;
    }
    assert.equal(keeper.backoffList(now)[0]!.failures, 4);

    state.failing = false;
    const settled = await keeper.tick(now);
    assert.equal(settled[0]!.status, "settled");
    assert.deepEqual(keeper.backoffList(now), [], "a success ends the backoff");
    const last = attemptsOf(db).at(-1)!;
    assert.equal(last.result, "settled");
    assert.equal(last.failures, 0);
    assert.equal(last.retry_at, null);

    // A later failure is a fresh streak, not a continuation of the old one.
    // The indexer advances next_charge after a settlement, so the next
    // attempt is for a new due charge (the settled one stays claimed, #249).
    db.prepare("UPDATE mandates SET next_charge = ? WHERE id = 1").run(now);
    state.failing = true;
    const next = now + 1;
    await keeper.tick(next);
    assert.deepEqual(keeper.backoffList(next), [
      { mandateId: 1, failures: 1, retryAt: next + 60, retryIn: 60 },
    ]);
    db.close();
  });

  test("mandates back off independently, each from its own last failure", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, START - 10_000);
    const state = { failing: true };
    const keeper = new Keeper(db, switchableRpc(state), keeperConfig({ KEEPER_SECRET: keyA.secret() }));

    // Mandate 1 fails once at START and waits until START + 60.
    await keeper.tick(START);
    // Mandate 2 appears before that retry, so it fails for the first time at
    // the same instant mandate 1 fails for the second time.
    insertDue(db, 2, START - 10_000);
    await keeper.tick(START + 60);
    assert.deepEqual(keeper.backoffList(START + 60), [
      { mandateId: 2, failures: 1, retryAt: START + 120, retryIn: 60 },
      { mandateId: 1, failures: 2, retryAt: START + 180, retryIn: 120 },
    ]);

    // Only mandate 2's retry has arrived; mandate 1 keeps waiting.
    assert.deepEqual((await keeper.findDue(START + 120)).map((m) => m.id), [2]);
    await keeper.tick(START + 120);
    assert.deepEqual(keeper.backoffList(START + 120), [
      { mandateId: 1, failures: 2, retryAt: START + 180, retryIn: 60 },
      { mandateId: 2, failures: 2, retryAt: START + 240, retryIn: 120 },
    ]);
    db.close();
  });

  test("an unusable signing account waits the base delay but never grows the mandate's backoff", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, START - 10_000);
    // No funded account: getAccount fails before simulation, the keeper-signer
    // failure path (#248). Every mandate would fail the same way until the
    // operator fixes the key, so it is not counted against the mandate: it
    // still waits the base delay (no tight retry), but the wait never grows.
    const keeper = new Keeper(db, fakeRpc(new Set()), keeperConfig({ KEEPER_SECRET: keyA.secret() }));

    let now = START;
    for (let pass = 0; pass < 4; pass += 1) {
      await keeper.tick(now);
      assert.deepEqual(keeper.backoffList(now), [
        { mandateId: 1, failures: 0, retryAt: now + 60, retryIn: 60 },
      ]);
      assert.deepEqual(await keeper.findDue(now + 59), [], "no retry before the base delay");
      now += 60;
    }
    assert.equal(attemptsOf(db).length, 4);
    assert.ok(attemptsOf(db).every((row) => row.error_code === "SUBMIT_FAILED" && row.failures === 0));
    db.close();
  });

  test("the streak and next retry survive a restart and continue where they left off", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, START - 10_000);
    const state = { failing: true };
    const config = keeperConfig({ KEEPER_SECRET: keyA.secret() });
    const before = new Keeper(db, switchableRpc(state), config);

    let now = START;
    for (const wait of SCHEDULE.slice(0, 4)) {
      await before.tick(now);
      now += wait;
    }
    // Four failures scheduled the next attempt 480 s out, at `now`.
    const retryAt = now;
    assert.equal(before.backoffList(now)[0]!.retryAt, retryAt);

    // The same database in a new process resumes the exact retry time.
    const after = new Keeper(db, switchableRpc(state), config);
    await after.ready;
    assert.deepEqual(after.backoffList(now), before.backoffList(now));
    assert.deepEqual(await after.findDue(retryAt - 1), []);

    // The fifth failure doubles the wait again, from 480 s to 960 s.
    await after.tick(retryAt);
    assert.deepEqual(after.backoffList(retryAt), [
      { mandateId: 1, failures: 5, retryAt: retryAt + 960, retryIn: 960 },
    ]);
    db.close();
  });
});

/** Issue #145: the merchant hears about a failing mandate once per streak. */
describe("keeper failing streaks", () => {
  const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  function streakKeeper(
    db: ReturnType<typeof openDatabase>,
    server: KeeperRpc,
    events: ChargeStreakEvent[],
  ): Keeper {
    return new Keeper(db, server, keeperConfig({ KEEPER_SECRET: keyA.secret() }), async (event) => {
      events.push(event);
    });
  }

  /**
   * Run passes at each mandate's retry time, so every pass makes one attempt:
   * the waits double from 60 s (10_000, 10_060, 10_180, 10_420, 10_900...).
   */
  async function passes(keeper: Keeper, count: number, from = 10_000): Promise<number> {
    let now = from;
    for (let i = 0; i < count; i += 1) {
      await keeper.tick(now);
      now += keeper.retryIn(1, now);
    }
    return now;
  }

  test("charge.failing fires once, on the third consecutive failure", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const events: ChargeStreakEvent[] = [];
    const keeper = streakKeeper(db, switchableRpc({ failing: true }), events);

    await passes(keeper, 2);
    assert.deepEqual(events, [], "two failures are not yet a streak");
    await passes(keeper, 1, 10_180);
    await passes(keeper, 2, 10_420);

    const thirdAttemptId = (
      db.prepare("SELECT id FROM charge_attempts WHERE failures = 3").get() as { id: number }
    ).id;
    assert.deepEqual(events, [
      {
        mandateId: 1,
        subscriber: SUBSCRIBER,
        merchant: MERCHANT,
        attemptId: thirdAttemptId,
        kind: "charge.failing",
        failures: 3,
        shortfall: null,
        nextRetryAt: 10_420,
        errorCode: "Error(Contract, #3)",
      },
    ], "the fourth and fifth failures do not fire it again");
    db.close();
  });

  test("charge.recovered fires once when a failing mandate settles", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const state = { failing: true };
    const events: ChargeStreakEvent[] = [];
    const keeper = streakKeeper(db, switchableRpc(state), events);

    const next = await passes(keeper, 4);
    state.failing = false;
    await keeper.tick(next);
    // Settled: the mandate is due again only after its next charge, so a
    // second pass at the same instant finds nothing to recover from.
    await keeper.tick(next);

    const recovered = events.filter((e) => e.kind === "charge.recovered");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.mandateId, 1);
    assert.equal(recovered[0]!.failures, 4, "it reports the length of the streak that ended");
    assert.match((recovered[0] as { txHash: string }).txHash, /^[0-9a-f]{64}$/);
    db.close();
  });

  test("a streak that ends before the threshold raises nothing", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const state = { failing: true };
    const events: ChargeStreakEvent[] = [];
    const keeper = streakKeeper(db, switchableRpc(state), events);

    const next = await passes(keeper, 2);
    state.failing = false;
    await keeper.tick(next);

    assert.deepEqual(events, []);
    db.close();
  });

  test("a restart mid-streak neither repeats charge.failing nor forgets to recover", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const state = { failing: true };
    const first: ChargeStreakEvent[] = [];
    let next = await passes(streakKeeper(db, switchableRpc(state), first), 3);
    assert.deepEqual(first.map((e) => e.kind), ["charge.failing"]);

    const second: ChargeStreakEvent[] = [];
    const restarted = streakKeeper(db, switchableRpc(state), second);
    next = await passes(restarted, 1, next);
    state.failing = false;
    await restarted.tick(next);

    assert.deepEqual(second.map((e) => e.kind), ["charge.recovered"]);
    db.close();
  });

  test("a vault shortfall counts toward the streak and rides on charge.failing", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
       VALUES (1, ?, 'p', ?, '1000', 60, 1, 1)`,
    ).run(MERCHANT, TOKEN);
    insertMandate(db, 1, 1_000, "1000");
    const submitted: string[] = [];
    const server = {
      ...fakeRpc(new Set([keyA.publicKey()]), submitted),
      simulateTransaction: async () => ({ result: { retval: nativeToScVal(400n, { type: "i128" }) } }),
    } as unknown as KeeperRpc;
    const events: ChargeStreakEvent[] = [];
    const keeper = streakKeeper(db, server, events);

    await passes(keeper, 3);

    assert.equal(submitted.length, 0, "nothing was submitted for an empty vault");
    const skipped = attemptsOf(db);
    assert.deepEqual(
      skipped.map((a) => [a.result, a.error_code, a.shortfall, a.failures]),
      [
        ["skipped", "INSUFFICIENT_BALANCE", "600", 1],
        ["skipped", "INSUFFICIENT_BALANCE", "600", 2],
        ["skipped", "INSUFFICIENT_BALANCE", "600", 3],
      ],
    );
    assert.equal(events.length, 1);
    const failing = events[0]!;
    assert.equal(failing.kind, "charge.failing");
    assert.equal((failing as { shortfall: string | null }).shortfall, "600");
    assert.equal((failing as { nextRetryAt: number }).nextRetryAt, 10_420);
    db.close();
  });

  test("a listener that rejects is logged, never thrown into the pass", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const keeper = new Keeper(
      db,
      switchableRpc({ failing: true }),
      keeperConfig({ KEEPER_SECRET: keyA.secret() }),
      async () => {
        throw new Error("webhook store unavailable");
      },
    );

    const errors: string[] = [];
    const original = logger.error;
    (logger as { error: unknown }).error = (...args: unknown[]) => {
      errors.push(String(args[1]));
    };
    try {
      await passes(keeper, 3);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      (logger as { error: unknown }).error = original;
    }

    assert.deepEqual(errors, ["charge streak notification failed"]);
    assert.equal(keeper.backoffList(10_420)[0]!.failures, 3, "the pass completed");
    db.close();
  });
});

/**
 * Issue #347: the keeper reuses a single RPC client across an entire pass.
 *
 * The Keeper stores `server` once in its constructor and never calls makeRpc
 * internally, so the same FailoverRpc instance handles all calls within a pass.
 * This test measures that: with N mandates, getFeeStats is called once per pass
 * (not once per mandate) and all getAccount calls go to the same instance,
 * confirming no per-mandate client reconstruction occurs.
 */
describe("keeper RPC client reuse (#347)", () => {
  test("a single RPC instance handles all mandates in one pass", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    insertDue(db, 2, 1_001);
    insertDue(db, 3, 1_002);

    let feeStatsCalls = 0;
    let getAccountCalls = 0;
    const countingRpc: KeeperRpc = {
      getFeeStats: async () => {
        feeStatsCalls += 1;
        return { sorobanInclusionFee: { p90: "1000" } } as never;
      },
      getAccount: async (address: string) => {
        getAccountCalls += 1;
        return new Account(address, "1") as never;
      },
      prepareTransaction: async (tx) => tx as Transaction,
      sendTransaction: async (tx) => ({
        status: "PENDING",
        hash: Buffer.from((tx as Transaction).hash()).toString("hex"),
      } as never),
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS } as never),
    };

    const keeper = new Keeper(db, countingRpc, keeperConfig({ KEEPER_SECRET: keyA.secret() }));
    await keeper.tick(10_000);

    // getFeeStats is called once per pass, not once per mandate.
    assert.equal(feeStatsCalls, 1, "fee stats fetched once for the whole pass, not per mandate");
    // getAccount is called exactly once per mandate (for the sequence number).
    assert.equal(getAccountCalls, 3, "each mandate needs one account lookup for its sequence number");
    db.close();
  });

  test("configurable charge attempt retention uses CHARGE_ATTEMPT_RETENTION_DAYS", async () => {
    const db = openDatabase(":memory:");
    const now = 100_000_000;
    const thirtyDays = 30 * 24 * 60 * 60;
    const insert = db.prepare(
      `INSERT INTO charge_attempts (mandate_id, attempted_at, result, failures)
       VALUES (?, ?, 'settled', 0)`,
    );
    insert.run(1, now - thirtyDays - 1);
    insert.run(2, now - thirtyDays);
    // Config overrides the default 90-day retention to 30 days.
    const config = keeperConfig({ KEEPER_SECRET: keyA.secret() });
    (config as unknown as Record<string, unknown>).CHARGE_ATTEMPT_RETENTION_DAYS = 30;
    const keeper = new Keeper(db, fakeRpc(new Set([keyA.publicKey()])), config);

    await keeper.tick(now);

    assert.deepEqual(
      attemptsOf(db).map((a) => a.mandate_id),
      [2],
      "only the attempt from beyond 30 days is gone when CHARGE_ATTEMPT_RETENTION_DAYS=30",
    );
    db.close();
  });
});

/**
 * Issue #248: a mandate that keeps failing backs off exponentially, by the
 * configured schedule and with jitter, and only for failures that are its
 * own: an RPC outage or a refused keeper signer never pushes it into the
 * future. The backoff lives in `charge_attempts` and is applied by the due
 * query, so every keeper sharing the database honours it.
 */
describe("keeper per-mandate backoff (#248)", () => {
  const START = 1_000_000;

  /** How every charge of a pass ends; see `scriptedRpc`. */
  type Outcome = "settle" | "shortfall" | "network" | "tryAgain" | "badSeq" | "auth" | `contract:${number}`;

  /**
   * A node whose charges end as `state.outcome` says. `shortfall` answers a
   * vault balance below the amount, so the keeper skips the charge — the
   * persistently short vault #248 is about; every other outcome is the
   * charge's own: settled, refused by the contract or the host, or lost to
   * the network.
   */
  function scriptedRpc(state: { outcome: Outcome }): KeeperRpc {
    const settles = fakeRpc(new Set([keyA.publicKey()]));
    return {
      ...settles,
      simulateTransaction: async () =>
        ({
          result: {
            retval: nativeToScVal(state.outcome === "shortfall" ? 1n : 1_000_000n, { type: "i128" }),
          },
        }) as never,
      prepareTransaction: async (tx: Transaction) => {
        if (state.outcome === "auth") throw new Error("HostError: Error(Auth, InvalidAction)");
        if (state.outcome.startsWith("contract:")) {
          throw new Error(`HostError: Error(Contract, #${state.outcome.slice("contract:".length)})`);
        }
        return tx;
      },
      sendTransaction: async (tx: Transaction) => {
        if (state.outcome === "network") throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
        if (state.outcome === "tryAgain") return { status: "TRY_AGAIN_LATER" } as never;
        if (state.outcome === "badSeq") {
          return { status: "ERROR", errorResult: { result: { type: "txBadSeq" } } } as never;
        }
        return settles.sendTransaction(tx);
      },
    } as unknown as KeeperRpc;
  }

  type Settings = Partial<
    Record<"KEEPER_BACKOFF_BASE_S" | "KEEPER_BACKOFF_MULTIPLIER" | "KEEPER_BACKOFF_MAX_S" | "KEEPER_BACKOFF_JITTER", number>
  >;

  function backoffConfig(settings: Settings = {}): Config {
    return { ...keeperConfig({ KEEPER_SECRET: keyA.secret() }), ...settings } as Config;
  }

  /** A database with one plan (so the vault balance is read) and due mandates. */
  function dueDb(...ids: number[]): ReturnType<typeof openDatabase> {
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
       VALUES (1, ?, 'p', ?, '10', 60, 1, 1)`,
    ).run(MERCHANT, CONTRACT);
    for (const id of ids) insertDue(db, id, START - 10_000 + id);
    return db;
  }

  /** Collect the keeper's warn and error log lines, fields and message. */
  async function captureBackoffLogs(
    fn: () => Promise<void>,
  ): Promise<{ level: string; fields: Record<string, unknown>; message: string }[]> {
    const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
    const originals = { warn: logger.warn, error: logger.error };
    for (const level of ["warn", "error"] as const) {
      (logger as unknown as Record<string, unknown>)[level] = function (this: unknown, ...args: unknown[]) {
        if (typeof args[0] === "object" && typeof args[1] === "string") {
          lines.push({ level, fields: args[0] as Record<string, unknown>, message: args[1] });
        }
        return (originals[level] as (this: unknown, ...a: unknown[]) => void).apply(this, args);
      };
    }
    try {
      await fn();
    } finally {
      (logger as { warn: unknown }).warn = originals.warn;
      (logger as { error: unknown }).error = originals.error;
    }
    return lines;
  }

  test("repeated vault shortfalls wait base x multiplier^(n-1), capped at the maximum", async () => {
    const db = dueDb(1);
    const settings = { KEEPER_BACKOFF_BASE_S: 30, KEEPER_BACKOFF_MULTIPLIER: 3, KEEPER_BACKOFF_MAX_S: 1_000 };
    const keeper = new Keeper(db, scriptedRpc({ outcome: "shortfall" }), backoffConfig(settings));

    let now = START;
    for (const [index, wait] of [30, 90, 270, 810, 1_000, 1_000, 1_000].entries()) {
      assert.deepEqual(await keeper.tick(now), [], "a vault shortfall submits nothing");
      const failures = index + 1;
      const row = attemptsOf(db).at(-1)!;
      assert.deepEqual(
        { result: row.result, code: row.error_code, failures: row.failures, retryAt: row.retry_at },
        { result: "skipped", code: "INSUFFICIENT_BALANCE", failures, retryAt: now + wait },
        `shortfall ${failures} waits ${wait} s`,
      );
      assert.deepEqual(await keeper.findDue(now + wait - 1), [], "not retried early");
      assert.deepEqual((await keeper.findDue(now + wait)).map((m) => m.id), [1], "due at its retry time");
      now += wait;
    }
    db.close();
  });

  test("a fractional multiplier grows the wait in whole seconds", async () => {
    const db = dueDb(1);
    const settings = { KEEPER_BACKOFF_BASE_S: 10, KEEPER_BACKOFF_MULTIPLIER: 1.5, KEEPER_BACKOFF_MAX_S: 30 };
    const keeper = new Keeper(db, scriptedRpc({ outcome: "shortfall" }), backoffConfig(settings));

    const waits: number[] = [];
    let now = START;
    for (let pass = 0; pass < 5; pass += 1) {
      await keeper.tick(now);
      waits.push(keeper.retryIn(1, now));
      now += waits.at(-1)!;
    }
    assert.deepEqual(waits, [10, 15, 22, 30, 30]);
    db.close();
  });

  test("jitter shortens a wait by at most its share and never exceeds the cap", async () => {
    const db = dueDb(1);
    const draws = [0, 0.5, 0.999_999, 0.25, 0.999_999];
    const keeper = new Keeper(
      db,
      scriptedRpc({ outcome: "shortfall" }),
      backoffConfig({ KEEPER_BACKOFF_BASE_S: 100, KEEPER_BACKOFF_MAX_S: 300, KEEPER_BACKOFF_JITTER: 0.2 }),
      undefined,
      { random: () => draws.shift()! },
    );

    const waits: number[] = [];
    let now = START;
    for (let pass = 0; pass < 5; pass += 1) {
      await keeper.tick(now);
      waits.push(keeper.retryIn(1, now));
      now += waits.at(-1)!;
    }
    // Unjittered: 100, 200, 300, 300, 300. Each draw takes up to 20% off.
    assert.deepEqual(waits, [100, 180, 241, 285, 241]);
    db.close();
  });

  test("a backed-off mandate is left out of the due query, so it never takes a place in the batch", async () => {
    const db = dueDb(1, 2);
    const keeper = new Keeper(db, scriptedRpc({ outcome: "settle" }), backoffConfig());
    await keeper.ready;
    // Another keeper sharing the database recorded mandate 1's failure after
    // this one started: its cache knows nothing, the query still does.
    db.prepare(
      `INSERT INTO charge_attempts (mandate_id, attempted_at, result, error_code, failures, retry_at)
       VALUES (1, ?, 'skipped', 'INSUFFICIENT_BALANCE', 1, ?)`,
    ).run(START, START + 60);
    assert.deepEqual(keeper.backoffList(START), []);

    assert.deepEqual((await keeper.findDue(START, 1)).map((m) => m.id), [2], "the oldest-due mandate is skipped");
    assert.deepEqual((await keeper.findDue(START + 59)).map((m) => m.id), [2]);
    assert.deepEqual((await keeper.findDue(START + 60)).map((m) => m.id), [1, 2], "back once its wait is over");
    assert.deepEqual((await keeper.tick(START)).map((r) => [r.mandateId, r.status]), [[2, "settled"]]);
    db.close();
  });

  test("keepers sharing a database continue one streak", async () => {
    const db = dueDb(1);
    const state = { outcome: "shortfall" as Outcome };
    const first = new Keeper(db, scriptedRpc(state), backoffConfig());
    const second = new Keeper(db, scriptedRpc(state), backoffConfig());
    await Promise.all([first.ready, second.ready]);

    await first.tick(START);
    await second.tick(START + 60);
    await first.tick(START + 180);
    assert.deepEqual(
      attemptsOf(db).map((row) => [row.failures, row.retry_at]),
      [[1, START + 60], [2, START + 180], [3, START + 420]],
      "each keeper picks the streak up from the attempt log, not from its own memory",
    );
    db.close();
  });

  test("a top-up after a run of shortfalls settles, resets the streak, and the next failure starts over", async () => {
    const db = dueDb(1);
    const state = { outcome: "shortfall" as Outcome };
    const keeper = new Keeper(db, scriptedRpc(state), backoffConfig());

    let now = START;
    for (const wait of [60, 120, 240]) {
      await keeper.tick(now);
      now += wait;
    }
    assert.equal(attemptsOf(db).at(-1)!.failures, 3);

    state.outcome = "settle"; // the subscriber topped the vault up
    assert.deepEqual((await keeper.tick(now)).map((r) => r.status), ["settled"]);
    const settled = attemptsOf(db).at(-1)!;
    assert.deepEqual([settled.result, settled.failures, settled.retry_at], ["settled", 0, null]);
    assert.deepEqual(keeper.backoffList(now), []);

    // The indexer advances next_charge; the next period's vault is short again.
    db.prepare("UPDATE mandates SET next_charge = ? WHERE id = 1").run(now + 1);
    state.outcome = "shortfall";
    await keeper.tick(now + 1);
    assert.deepEqual(keeper.backoffList(now + 1), [
      { mandateId: 1, failures: 1, retryAt: now + 61, retryIn: 60 },
    ]);
    db.close();
  });

  test("network, congestion and sequence failures retry after the base delay without growing the streak", async () => {
    const db = dueDb(1);
    const state = { outcome: "shortfall" as Outcome };
    const keeper = new Keeper(db, scriptedRpc(state), backoffConfig());

    // Two shortfalls: the streak is 2 and the next wait would be 240 s.
    await keeper.tick(START);
    await keeper.tick(START + 60);
    let now = START + 180;

    // An RPC outage lasting many passes: the mandate keeps coming back every
    // base delay, its streak untouched, instead of drifting hours away.
    for (const outcome of ["network", "tryAgain", "badSeq", "network", "network", "network"] as const) {
      state.outcome = outcome;
      assert.equal((await keeper.tick(now))[0]!.status, "failed");
      assert.deepEqual(keeper.backoffList(now), [{ mandateId: 1, failures: 2, retryAt: now + 60, retryIn: 60 }]);
      now += 60;
    }
    assert.deepEqual(
      attemptsOf(db).slice(2, 5).map((row) => row.error_code),
      ["SUBMIT_FAILED", "TRY_AGAIN_LATER", "txBadSeq"],
    );

    // The vault is still short once the network is back: the streak resumes.
    state.outcome = "shortfall";
    await keeper.tick(now);
    assert.deepEqual(keeper.backoffList(now), [{ mandateId: 1, failures: 3, retryAt: now + 240, retryIn: 240 }]);
    db.close();
  });

  test("a refused keeper authorization is logged as the keeper's fault and never grows the streak", async () => {
    const db = dueDb(1, 2);
    const keeper = new Keeper(db, scriptedRpc({ outcome: "auth" }), backoffConfig());

    const logs = await captureBackoffLogs(async () => {
      await keeper.tick(START);
      await keeper.tick(START + 60);
    });

    assert.deepEqual(
      attemptsOf(db).map((row) => [row.mandate_id, row.error_code, row.failures, row.retry_at]),
      [
        [1, "Error(Auth, InvalidAction)", 0, START + 60],
        [2, "Error(Auth, InvalidAction)", 0, START + 60],
        [1, "Error(Auth, InvalidAction)", 0, START + 120],
        [2, "Error(Auth, InvalidAction)", 0, START + 120],
      ],
      "every mandate retries after the base delay, none is penalised",
    );
    const refused = logs.filter((line) => line.fields.reason === "keeper");
    assert.equal(refused.length, 4);
    assert.ok(refused.every((line) => line.level === "error" && /keeper signer or authorization/.test(line.message)));
    db.close();
  });

  test("a permanent contract refusal waits the maximum at once", async () => {
    for (const code of [2003, 2005, 2009, 2036]) {
      const db = dueDb(1);
      const keeper = new Keeper(db, scriptedRpc({ outcome: `contract:${code}` }), backoffConfig());
      await keeper.tick(START);
      assert.deepEqual(
        keeper.backoffList(START),
        [{ mandateId: 1, failures: 1, retryAt: START + 21_600, retryIn: 21_600 }],
        `Error(Contract, #${code}) is not retried before the cap`,
      );
      db.close();
    }
  });

  test("a vault refusal surfaced by the simulation grows like a shortfall", async () => {
    // 3004 InsufficientBalance and 3009 AllowanceInsufficient, from the vault.
    for (const code of [3004, 3009]) {
      const db = dueDb(1);
      const keeper = new Keeper(db, scriptedRpc({ outcome: `contract:${code}` }), backoffConfig());
      await keeper.tick(START);
      await keeper.tick(START + 60);
      assert.deepEqual(keeper.backoffList(START + 60), [
        { mandateId: 1, failures: 2, retryAt: START + 180, retryIn: 120 },
      ]);
      db.close();
    }
  });

  test("each backoff is logged with the mandate, streak, reason and next attempt", async () => {
    const db = dueDb(1);
    const state = { outcome: "shortfall" as Outcome };
    const keeper = new Keeper(db, scriptedRpc(state), backoffConfig());

    const logs = await captureBackoffLogs(async () => {
      await keeper.tick(START);
      state.outcome = "network";
      await keeper.tick(START + 60);
    });

    const lines = logs.filter((line) => "retryAt" in line.fields);
    assert.deepEqual(lines.map((line) => [line.level, line.message, line.fields]), [
      [
        "warn",
        "mandate backing off after a failed charge",
        { mandateId: 1, failures: 1, reason: "mandate", errorCode: "INSUFFICIENT_BALANCE", retryAt: START + 60, retryIn: 60 },
      ],
      [
        "warn",
        "charge failed on the network, not the mandate; retrying without growing its backoff",
        { mandateId: 1, failures: 1, reason: "infrastructure", errorCode: "SUBMIT_FAILED", retryAt: START + 120, retryIn: 60 },
      ],
    ]);
    db.close();
  });

  test("a network blip in a failing streak does not send charge.failing again", async () => {
    const db = dueDb(1);
    const state = { outcome: "shortfall" as Outcome };
    const events: ChargeStreakEvent[] = [];
    const keeper = new Keeper(db, scriptedRpc(state), backoffConfig(), async (event) => {
      events.push(event);
    });

    let now = START;
    for (const outcome of ["shortfall", "shortfall", "shortfall", "network", "network", "shortfall"] as const) {
      state.outcome = outcome;
      await keeper.tick(now);
      now += keeper.retryIn(1, now);
    }
    assert.deepEqual(
      events.map((event) => [event.kind, event.failures]),
      [["charge.failing", 3]],
      "the threshold is crossed once; streak 3 held through the blip is not a new crossing",
    );
    db.close();
  });

  test("failures are classified by who is at fault", () => {
    const cases: [string | null, string | null, string][] = [
      ["INSUFFICIENT_BALANCE", null, "mandate"],
      ["Error(Contract, #3004)", "HostError: Error(Contract, #3004)", "mandate"],
      ["Error(Contract, #3)", null, "mandate"],
      ["CHARGE_MANY_SKIPPED", null, "mandate"],
      ["FAILED", "FAILED", "mandate"],
      ["SUBMIT_FAILED", "Simulation failed: InsufficientBalance", "mandate"],
      ["Error(Contract, #2005)", null, "permanent"],
      ["Error(Contract, #2003)", null, "permanent"],
      ["Error(Contract, #2039)", null, "infrastructure"],
      ["Error(Auth, InvalidAction)", null, "keeper"],
      ["txBadAuth", null, "keeper"],
      ["txInsufficientBalance", null, "keeper"],
      ["SUBMIT_FAILED", "The source account [redacted] was not found", "keeper"],
      ["TRY_AGAIN_LATER", "TRY_AGAIN_LATER", "infrastructure"],
      ["NOT_FOUND", "NOT_FOUND", "infrastructure"],
      ["txBadSeq", null, "infrastructure"],
      ["SUBMIT_FAILED", "tx_bad_seq", "infrastructure"],
      ["txInsufficientFee", null, "infrastructure"],
      ["SUBMIT_FAILED", "connect ECONNREFUSED 127.0.0.1:8000", "infrastructure"],
      ["SUBMIT_FAILED", "request timed out after 30000 ms", "infrastructure"],
      ["SUBMIT_FAILED", "Request failed with status code 503", "infrastructure"],
      [null, null, "mandate"],
    ];
    for (const [code, message, expected] of cases) {
      assert.equal(classifyFailure(code, message), expected, `${String(code)} / ${String(message)}`);
    }
  });

  test("invalid backoff settings are refused by the keeper, and a refused reload changes nothing", async () => {
    const invalid: [Settings | Record<string, number>, RegExp][] = [
      [{ KEEPER_BACKOFF_BASE_S: 0 }, /KEEPER_BACKOFF_BASE_S/],
      [{ KEEPER_BACKOFF_BASE_S: -5 }, /KEEPER_BACKOFF_BASE_S/],
      [{ KEEPER_BACKOFF_MULTIPLIER: 0.5 }, /KEEPER_BACKOFF_MULTIPLIER/],
      [{ KEEPER_BACKOFF_BASE_S: 600, KEEPER_BACKOFF_MAX_S: 300 }, /KEEPER_BACKOFF_MAX_S=300 is below/],
      [{ KEEPER_BACKOFF_JITTER: 0.9 }, /KEEPER_BACKOFF_JITTER/],
      [{ KEEPER_BACKOFF_MAX_S: 2 * 86_400, CHARGE_ATTEMPT_RETENTION_DAYS: 1 }, /outlasts/],
    ];
    const db = dueDb(1);
    for (const [settings, message] of invalid) {
      assert.throws(
        () => new Keeper(db, scriptedRpc({ outcome: "settle" }), { ...backoffConfig(), ...settings } as Config),
        message,
      );
    }

    const keeper = new Keeper(db, scriptedRpc({ outcome: "shortfall" }), backoffConfig({ KEEPER_BACKOFF_BASE_S: 45 }));
    assert.throws(() => keeper.reloadFromConfig(backoffConfig({ KEEPER_BACKOFF_MULTIPLIER: 0 })), /MULTIPLIER/);
    await keeper.tick(START);
    assert.equal(keeper.retryIn(1, START), 45, "the running keeper kept its settings");

    keeper.reloadFromConfig(backoffConfig({ KEEPER_BACKOFF_BASE_S: 45, KEEPER_BACKOFF_MULTIPLIER: 4 }));
    await keeper.tick(START + 45);
    assert.equal(keeper.retryIn(1, START + 45), 180, "a valid reload applies to the next failure");
    db.close();
  });
});
