import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Account, Keypair, StrKey, Transaction, nativeToScVal } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { openDatabase, readCursor, writeCursor } from "../src/lib/db.ts";
import { logger } from "../src/lib/logger.ts";
import { planCli, runCli, type CliDeps, type CliRpc } from "../src/cmd/cli.ts";
import type { Config, NetworkConfig } from "../src/config.ts";

// The keeper logs its own diagnostics; the CLI's own output is what a test
// asserts on, so the log is silenced rather than captured.
logger.level = "silent";

const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/** The moment the tests pretend it is; a fixed clock keeps them stable. */
const NOW = 1_700_000_000;

const key = Keypair.random();

function cliConfig(overrides: Partial<Config> = {}): Config {
  return {
    PLAN_REGISTRY_ID: CONTRACT,
    VAULT_ID: CONTRACT,
    SUBSCRIPTION_ID: CONTRACT,
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    KEEPER_FEE_PERCENTILE: "90",
    KEEPER_MAX_FEE: "100000",
    KEEPER_DRY_RUN: false,
    ...overrides,
  } as unknown as Config;
}

function cliNetwork(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
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

/**
 * A projection with one plan, one due mandate, one mandate that is not due
 * yet and one settled charge.
 *
 * The big amount is deliberate: `100000000000000000000` and the balance
 * `99999999999999999999` differ by one stroop, and both collapse onto
 * `1e20` as JavaScript numbers. A comparison done on numbers would call the
 * mandate funded; a comparison done on bigints does not.
 */
function seededProjection(): DatabaseSync {
  const db = openDatabase(":memory:");
  db.prepare(
    `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
     VALUES (1, ?, 'Pro Monthly', ?, '1000', 2592000, 1, 10)`,
  ).run(MERCHANT, TOKEN);
  db.prepare(
    `INSERT INTO mandates
       (id, subscriber, merchant, plan_id, amount, period, next_charge,
        last_charge, charges_made, max_charges, fee_bps, status, ledger)
     VALUES (7, ?, ?, 1, '1000', 2592000, ?, 0, 1, 0, 100, 'Active', 10)`,
  ).run(SUBSCRIBER, MERCHANT, NOW - 1_000);
  db.prepare(
    `INSERT INTO mandates
       (id, subscriber, merchant, plan_id, amount, period, next_charge,
        last_charge, charges_made, max_charges, fee_bps, status, ledger)
     VALUES (8, ?, ?, 1, '1000', 2592000, ?, 0, 0, 0, 100, 'Active', 10)`,
  ).run(SUBSCRIBER, MERCHANT, NOW + 1_000);
  db.prepare(
    `INSERT INTO mandates
       (id, subscriber, merchant, plan_id, amount, period, next_charge,
        last_charge, charges_made, max_charges, fee_bps, status, ledger)
     VALUES (9, ?, ?, 1, '100000000000000000000', 2592000, ?, 0, 0, 0, 100, 'Active', 10)`,
  ).run(SUBSCRIBER, MERCHANT, NOW - 1_000);
  db.prepare(
    `INSERT INTO charges
       (tx_hash, mandate_id, subscriber, merchant, amount, fee, charges_made,
        next_charge, ledger, created_at)
     VALUES ('tx-abc', 7, ?, ?, '1000', '10', 1, ?, 11, ?)`,
  ).run(SUBSCRIBER, MERCHANT, NOW + 2_592_000, (NOW - 5) * 1000);
  // The vault holds less than mandate 9's amount, and at least mandate 7's.
  db.prepare(
    `INSERT INTO vault_events (tx_hash, kind, user, token, counterparty, amount, balance, ledger)
     VALUES ('tx-vault', 'deposit', ?, ?, NULL, '1000', '99999999999999999999', 11)`,
  ).run(SUBSCRIBER, TOKEN);
  writeCursor(db, 100);
  return db;
}

interface FakeChain {
  latest: number;
  oldest: number;
  /** The events the node holds; none by default. */
  events?: rpc.Api.EventResponse[];
  /** Set to make the latest-ledger call fail, as an unreachable node does. */
  failLatest?: boolean;
  /** What `sendTransaction` answers. */
  sendStatus?: "PENDING" | "ERROR" | "TRY_AGAIN_LATER";
}

/**
 * A fake RPC node.
 *
 * It never reaches the network: the ledger range is answered from the events
 * the test put in it, and a submitted transaction is answered with a hash.
 */
function fakeRpc(
  chain: FakeChain,
  submitted: string[] = [],
  prepared: Transaction[] = [],
): CliRpc {
  const events = chain.events ?? [];
  return {
    getLatestLedger: async () => {
      if (chain.failLatest) throw new Error("rpc unreachable");
      return { sequence: chain.latest, closeTime: new Date(NOW * 1000).toISOString() } as never;
    },
    getHealth: async () =>
      ({ oldestLedger: chain.oldest, latestLedger: chain.latest }) as never,
    getEvents: async (request: Record<string, unknown>) => {
      // A cursor request continues after the cursor; a range request returns
      // the events in [startLedger, endLedger). The cursor the answer carries
      // names the next event, so a range is paged to its end.
      const cursor = request.cursor as string | undefined;
      const pool =
        cursor !== undefined
          ? events.slice(Number(cursor))
          : events.filter((event) => {
              const start = (request.startLedger as number | undefined) ?? 0;
              const end = (request.endLedger as number | undefined) ?? chain.latest;
              return event.ledger >= start && event.ledger < end;
            });
      const limit = (request.limit as number | undefined) ?? events.length;
      const page = pool.slice(0, limit);
      const last = page[page.length - 1];
      const offset = last === undefined ? 0 : events.indexOf(last) + 1;
      return { events: page, cursor: String(offset), latestLedger: chain.latest } as never;
    },
    getAccount: async (address: string) => new Account(address, "1") as never,
    getFeeStats: async () => ({ sorobanInclusionFee: { p90: "1000" } }) as never,
    getLedgerEntries: async () => ({ entries: [], latestLedger: chain.latest }) as never,
    prepareTransaction: async (tx) => {
      prepared.push(tx as Transaction);
      return tx as Transaction;
    },
    sendTransaction: async (tx) => {
      const hash = Buffer.from((tx as Transaction).hash()).toString("hex");
      submitted.push(hash);
      return {
        status: chain.sendStatus ?? "PENDING",
        hash,
        errorResult: chain.sendStatus === "ERROR" ? "txFAILED" : undefined,
      } as never;
    },
    getTransaction: async () => ({ status: "SUCCESS" }) as never,
    simulateTransaction: async () => ({}) as never,
  };
}

/** A `plan_created` event, as the RPC would report it. */
function rawPlanCreated(ledger: number): rpc.Api.EventResponse {
  return {
    ledger,
    txHash: `tx-plan-${ledger}`,
    contractId: CONTRACT,
    topic: [
      nativeToScVal("plan_created", { type: "symbol" }),
      nativeToScVal(MERCHANT, { type: "address" }),
      nativeToScVal(1n, { type: "u64" }),
    ],
    value: nativeToScVal(
      { token: TOKEN, amount: 1000n, period: 2_592_000n, name: "Pro Monthly" },
      {
        type: {
          token: ["symbol", "address"],
          amount: ["symbol", "i128"],
          period: ["symbol", "u64"],
          name: ["symbol", "string"],
        },
      },
    ),
  } as unknown as rpc.Api.EventResponse;
}

/** A `subscribed` event, as the RPC would report it. */
function rawSubscribed(ledger: number): rpc.Api.EventResponse {
  return {
    ledger,
    txHash: `tx-subscribed-${ledger}`,
    contractId: CONTRACT,
    topic: [
      nativeToScVal("subscribed", { type: "symbol" }),
      nativeToScVal(7n, { type: "u64" }),
      nativeToScVal(SUBSCRIBER, { type: "address" }),
      nativeToScVal(MERCHANT, { type: "address" }),
    ],
    value: nativeToScVal(
      {
        plan_id: 1n,
        amount: 1000n,
        period: 2_592_000n,
        next_charge: BigInt(NOW),
        max_charges: 0n,
        fee_bps: 100n,
      },
      {
        type: {
          plan_id: ["symbol", "u64"],
          amount: ["symbol", "i128"],
          period: ["symbol", "u64"],
          next_charge: ["symbol", "timepoint"],
          max_charges: ["symbol", "u32"],
          fee_bps: ["symbol", "u32"],
        },
      },
    ),
  } as unknown as rpc.Api.EventResponse;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Start a stand-in for the API and answer `/health` with `body`.
 *
 * The body is sent as JSON unless it is a string, which is sent as it is —
 * that is how a proxy or a different service answers, and the CLI has to
 * survive it.
 */
async function withStubApi(body: unknown, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

/**
 * Run the CLI with its collaborators replaced.
 *
 * The database is a fresh in-memory projection per command, the clock is
 * fixed and the RPC is the fake above, so no test needs a network or a file.
 */
async function run(argv: string[], deps: Partial<CliDeps> = {}): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    config: cliConfig(),
    networks: [cliNetwork()],
    now: () => NOW,
    openDb: () => seededProjection(),
    rpc: () => fakeRpc({ latest: 200, oldest: 0 }),
    ...deps,
    write: (line) => stdout.push(line),
    writeError: (line) => stderr.push(line),
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("cli help", () => {
  test("lists every command", () => {
    const plan = planCli(["--help"]);
    assert.equal(plan.kind, "help");
    const text = plan.kind === "help" ? plan.text : "";
    for (const name of ["status", "mandate", "due", "charge", "reindex"]) {
      assert.ok(text.includes(name), `the help mentions ${name}`);
    }
    assert.match(text, /Usage: npm run cli -- <command>/);
  });

  test("every command has its own help, with its arguments and options", () => {
    for (const name of ["status", "mandate", "due", "charge", "reindex"]) {
      const plan = planCli([name, "--help"]);
      assert.equal(plan.kind, "help", `${name} --help prints help`);
      const text = plan.kind === "help" ? plan.text : "";
      assert.match(text, new RegExp(`npm run cli -- ${name}`));
      assert.match(text, /Options:/);
      assert.match(text, /--json/);
      assert.match(text, /--network/);
    }
  });

  test("the commands that need an argument say which one", () => {
    for (const name of ["mandate", "charge"]) {
      const plan = planCli([name, "--help"]);
      const text = plan.kind === "help" ? plan.text : "";
      assert.match(text, /Arguments:/);
      assert.match(text, /<id>/);
    }
  });

  test("charge documents the confirmation and the secret it needs", () => {
    const plan = planCli(["charge", "--help"]);
    const text = plan.kind === "help" ? plan.text : "";
    assert.match(text, /--yes/);
    assert.match(text, /KEEPER_SECRET/);
  });

  test("reindex documents the confirmation it needs", () => {
    const plan = planCli(["reindex", "--help"]);
    const text = plan.kind === "help" ? plan.text : "";
    assert.match(text, /--yes/);
    assert.match(text, /--from/);
  });

  test("a command can be asked for help by name", () => {
    const plan = planCli(["help", "due"]);
    assert.equal(plan.kind, "help");
    assert.match(plan.kind === "help" ? plan.text : "", /npm run cli -- due/);
  });

  test("the help works without a usable configuration", async () => {
    const result = await run(["--help"], {
      config: cliConfig({ KEEPER_SECRET: undefined }),
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Commands:/);
  });
});

describe("cli argument parsing", () => {
  test("an unknown command is refused with a hint", () => {
    const plan = planCli(["frobnicate"]);
    assert.equal(plan.kind, "error");
    assert.match(plan.kind === "error" ? plan.message : "", /unknown command/);
    assert.match(plan.kind === "error" ? (plan.hint ?? "") : "", /Known commands/);
  });

  test("no command at all is refused", () => {
    const plan = planCli([]);
    assert.equal(plan.kind, "error");
    assert.match(plan.kind === "error" ? plan.message : "", /no command given/);
  });

  test("an unknown option is refused instead of ignored", () => {
    const plan = planCli(["due", "--colour"]);
    assert.equal(plan.kind, "error");
    assert.match(plan.kind === "error" ? plan.message : "", /unknown option '--colour'/);
  });

  test("an option that needs a value says so", () => {
    const plan = planCli(["due", "--limit"]);
    assert.equal(plan.kind, "error");
    assert.match(plan.kind === "error" ? plan.message : "", /needs a value/);
  });

  test("a flag refuses a value", () => {
    const plan = planCli(["charge", "7", "--yes=1"]);
    assert.equal(plan.kind, "error");
    assert.match(plan.kind === "error" ? plan.message : "", /does not take a value/);
  });

  test("the wrong number of arguments is refused", () => {
    const plan = planCli(["mandate"]);
    assert.equal(plan.kind, "error");
    assert.match(plan.kind === "error" ? plan.message : "", /takes 1 argument/);
  });

  test("a value may be given with an equals sign", () => {
    const plan = planCli(["due", "--limit=5"]);
    assert.equal(plan.kind, "run");
    assert.equal(plan.kind === "run" ? plan.args.options.limit : undefined, "5");
  });

  test("a value may be given as the next argument", () => {
    const plan = planCli(["due", "--limit", "5"]);
    assert.equal(plan.kind, "run");
    assert.equal(plan.kind === "run" ? plan.args.options.limit : undefined, "5");
    assert.deepEqual(plan.kind === "run" ? plan.args.positionals : [], []);
  });

  test("a flag is recorded as true", () => {
    const plan = planCli(["charge", "7", "--yes"]);
    assert.equal(plan.kind, "run");
    assert.equal(plan.kind === "run" ? plan.args.options.yes : undefined, true);
  });
});

describe("cli status", () => {
  test("reports the projection without calling the RPC when asked to stay offline", async () => {
    const result = await run(["status", "--offline"], {
      rpc: () => {
        throw new Error("the RPC must not be called");
      },
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /network:\s+testnet/);
    assert.match(result.stdout, /cursor 100/);
    assert.match(result.stdout, /not probed/);
    assert.match(result.stdout, /due now:\s+2/);
  });

  test("reports an unreachable RPC without failing", async () => {
    const result = await run(["status"], {
      rpc: () => fakeRpc({ latest: 200, oldest: 0, failLatest: true }),
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /unreachable/);
  });

  test("reports the lag against the network's latest ledger", async () => {
    const result = await run(["status"], {
      rpc: () => fakeRpc({ latest: 500, oldest: 0 }),
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /lag 400/);
    assert.match(result.stdout, /catching_up/);
  });

  test("prints JSON when asked for it", async () => {
    const result = await run(["status", "--json", "--offline"]);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout) as {
      network: string;
      projection: { cursor: number; lag: number | null; dueMandates: number };
      counts: { mandates: number; charges: number };
    };
    assert.equal(payload.network, "testnet");
    assert.equal(payload.projection.cursor, 100);
    assert.equal(payload.projection.lag, null);
    assert.equal(payload.projection.dueMandates, 2);
    assert.equal(payload.counts.mandates, 3);
    assert.equal(payload.counts.charges, 1);
  });

  test("never prints the keeper secret", async () => {
    const secret = key.secret();
    const result = await run(["status"], {
      config: cliConfig({ KEEPER_SECRET: secret }),
    });
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.includes(secret), "the secret is not in the output");
    assert.ok(!result.stderr.includes(secret), "the secret is not in the errors");
    assert.ok(result.stdout.includes(key.publicKey()), "the public key is shown instead");
  });

  test("refuses a network it does not know", async () => {
    const result = await run(["status", "--network", "mainnet"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown network 'mainnet'/);
  });

  test("includes the health of a running API when asked", async () => {
    // A stand-in for the API: the probe asks it for /health.
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", network: "testnet" }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    try {
      const result = await run(["status", "--offline", "--api", `http://127.0.0.1:${address.port}`]);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /api:\s+.*\/health — ok on testnet/);
    } finally {
      server.close();
    }
  });

  test("reports an API that is not running without failing", async () => {
    const result = await run(["status", "--offline", "--api", "http://127.0.0.1:1"]);
    assert.equal(result.code, 0, "an API that is down does not fail the command");
    assert.match(result.stdout, /api:\s+.*unreachable/);
  });

  test("reports the live indexer's health, which the projection does not hold", async () => {
    await withStubApi(
      {
        status: "catching_up",
        network: "testnet",
        indexer: {
          cursor: 100,
          latestLedger: 400,
          lag: 300,
          paused: true,
          freshnessSeconds: 42,
          lastRunAt: "2026-10-20T00:00:00.000Z",
          lastError: "rpc timeout",
          mismatchedEvents: 3,
          reconciliations: 7,
          corrections: 1,
        },
      },
      async (url) => {
        const result = await run(["status", "--offline", "--api", url]);
        assert.equal(result.code, 0);
        assert.match(result.stdout, /api:\s+.*catching_up on testnet/);
        assert.match(result.stdout, /indexer:\s+cursor 100, latest 400, lag 300, paused/);
        assert.match(result.stdout, /freshness:\s+42s/);
        assert.match(result.stdout, /last run:\s+2026-10-20T00:00:00.000Z/);
        assert.match(result.stdout, /last error: rpc timeout/);
        assert.match(result.stdout, /mismatched: 3 event\(s\) failed validation/);
      },
    );
  });

  test("the JSON output carries the API's health", async () => {
    await withStubApi(
      {
        status: "ok",
        network: "testnet",
        indexer: { cursor: 100, latestLedger: 100, lag: 0, paused: false },
      },
      async (url) => {
        const result = await run(["status", "--offline", "--api", url, "--json"]);
        assert.equal(result.code, 0);
        const payload = JSON.parse(result.stdout) as {
          api: {
            reachable: boolean;
            health: { status: string; indexer: { cursor: number; lag: number; paused: boolean } };
          };
        };
        assert.equal(payload.api.reachable, true);
        assert.equal(payload.api.health.status, "ok");
        assert.equal(payload.api.health.indexer.cursor, 100);
        assert.equal(payload.api.health.indexer.lag, 0);
        assert.equal(payload.api.health.indexer.paused, false);
      },
    );
  });

  test("an API that answers with something else is tolerated", async () => {
    await withStubApi({ hello: "world" }, async (url) => {
      const result = await run(["status", "--offline", "--api", url]);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /api:\s+.*— unknown/);
    });
  });

  test("an API that answers with no JSON at all is tolerated", async () => {
    await withStubApi("not json at all", async (url) => {
      const result = await run(["status", "--offline", "--api", url]);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /api:\s+.*— unknown/);
    });
  });
});

describe("cli mandate", () => {
  test("shows the mandate and the charges it settled", async () => {
    const result = await run(["mandate", "7"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /mandate 7/);
    assert.match(result.stdout, /subscriber:\s+GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR/);
    assert.match(result.stdout, /amount:\s+1000/);
    assert.match(result.stdout, /charges \(1\):/);
    assert.match(result.stdout, /tx-abc/);
  });

  test("prints JSON when asked for it", async () => {
    const result = await run(["mandate", "7", "--json"]);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout) as {
      mandate: { id: number; amount: string };
      charges: { tx_hash: string; amount: string }[];
    };
    assert.equal(payload.mandate.id, 7);
    assert.equal(payload.mandate.amount, "1000");
    assert.equal(payload.charges.length, 1);
    assert.equal(payload.charges[0]!.amount, "1000");
  });

  test("refuses an id that is not a number", async () => {
    const result = await run(["mandate", "seven"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /must be a positive integer/);
  });

  test("says so when the mandate is unknown", async () => {
    const result = await run(["mandate", "999"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no mandate 999/);
  });

  test("never calls the RPC", async () => {
    const result = await run(["mandate", "7"], {
      rpc: () => {
        throw new Error("the RPC must not be called");
      },
    });
    assert.equal(result.code, 0);
  });
});

describe("cli due", () => {
  test("lists the mandates that are due and marks the funded ones", async () => {
    const result = await run(["due", "--json"]);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout) as {
      due: { id: number; amount: string; funded: boolean }[];
    };
    assert.deepEqual(
      payload.due.map((row) => row.id),
      [7, 9],
      "only the mandates that have fallen due are listed",
    );
    assert.equal(payload.due[0]!.funded, true);
    assert.equal(
      payload.due[1]!.funded,
      false,
      "a balance one stroop short does not cover the amount",
    );
    assert.equal(payload.due[1]!.amount, "100000000000000000000");
  });

  test("prints a readable list", async () => {
    const result = await run(["due"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /2 mandate\(s\) due for charging/);
    assert.match(result.stdout, /funded yes/);
    assert.match(result.stdout, /funded no/);
  });

  test("says so when nothing is due", async () => {
    const result = await run(["due"], {
      openDb: () => {
        const db = openDatabase(":memory:");
        db.prepare(
          `INSERT INTO mandates
             (id, subscriber, merchant, plan_id, amount, period, next_charge,
              last_charge, charges_made, max_charges, fee_bps, status, ledger)
           VALUES (1, ?, ?, 1, '1000', 60, ?, 0, 0, 0, 0, 'Active', 1)`,
        ).run(SUBSCRIBER, MERCHANT, NOW + 1_000);
        return db;
      },
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no mandate is due for charging/);
  });

  test("never calls the RPC", async () => {
    const result = await run(["due"], {
      rpc: () => {
        throw new Error("the RPC must not be called");
      },
    });
    assert.equal(result.code, 0);
  });
});

describe("cli charge", () => {
  test("refuses to run without the confirmation", async () => {
    const submitted: string[] = [];
    const result = await run(["charge", "7"], {
      config: cliConfig({ KEEPER_SECRET: key.secret() }),
      rpc: () => fakeRpc({ latest: 200, oldest: 0 }, submitted),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing to charge without --yes/);
    assert.equal(submitted.length, 0, "nothing was submitted");
  });

  test("refuses to run without a keeper secret", async () => {
    const result = await run(["charge", "7", "--yes"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /KEEPER_SECRET is not set/);
  });

  test("settles the mandate through the keeper", async () => {
    const submitted: string[] = [];
    const result = await run(["charge", "7", "--yes"], {
      config: cliConfig({ KEEPER_SECRET: key.secret() }),
      rpc: () => fakeRpc({ latest: 200, oldest: 0 }, submitted),
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /charging mandate 7/);
    assert.match(result.stdout, /settled: [0-9a-f]{64}/);
    assert.equal(submitted.length, 1, "exactly one transaction hit the network");
  });

  test("never prints the keeper secret", async () => {
    const secret = key.secret();
    const result = await run(["charge", "7", "--yes"], {
      config: cliConfig({ KEEPER_SECRET: secret }),
      rpc: () => fakeRpc({ latest: 200, oldest: 0 }),
    });
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.includes(secret));
    assert.ok(!result.stderr.includes(secret));
  });

  test("a dry run simulates the charge and submits nothing", async () => {
    const submitted: string[] = [];
    const result = await run(["charge", "7", "--yes"], {
      config: cliConfig({ KEEPER_SECRET: key.secret(), KEEPER_DRY_RUN: true }),
      rpc: () => fakeRpc({ latest: 200, oldest: 0 }, submitted),
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /simulated/);
    assert.equal(submitted.length, 0, "a dry run never submits");
  });

  test("a charge the network refuses is reported as a failure", async () => {
    const result = await run(["charge", "7", "--yes"], {
      config: cliConfig({ KEEPER_SECRET: key.secret() }),
      rpc: () => fakeRpc({ latest: 200, oldest: 0, sendStatus: "ERROR" }),
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /failed:/);
  });

  test("--json prints the outcome and nothing else, so it stays parseable", async () => {
    const result = await run(["charge", "7", "--yes", "--json"], {
      config: cliConfig({ KEEPER_SECRET: key.secret() }),
      rpc: () => fakeRpc({ latest: 200, oldest: 0 }),
    });
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout) as {
      mandateId: number;
      status: string;
      txHash: string;
    };
    assert.equal(payload.mandateId, 7);
    assert.equal(payload.status, "settled");
    assert.match(payload.txHash, /^[0-9a-f]{64}$/);
  });

  test("charges the contracts of the network it operates on", async () => {
    // A second network with its own contracts: the charge must be built
    // against those, not against the default network's.
    const other = StrKey.encodeContract(Buffer.alloc(32, 7));
    const prepared: Transaction[] = [];
    const result = await run(["charge", "7", "--yes", "--network", "mainnet"], {
      config: cliConfig({ KEEPER_SECRET: key.secret() }),
      networks: [cliNetwork(), cliNetwork({ name: "mainnet", subscriptionId: other })],
      rpc: () => fakeRpc({ latest: 200, oldest: 0 }, [], prepared),
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /settled:/);
    const operation = prepared[0]!.operations[0] as unknown as {
      func: {
        invokeContract: {
          contractAddress: { type: string; contractId: { value: Uint8Array } };
        };
      };
    };
    const address = operation.func.invokeContract.contractAddress;
    assert.equal(address.type, "scAddressTypeContract");
    assert.equal(
      StrKey.encodeContract(Buffer.from(address.contractId.value)),
      other,
      "the charge calls the selected network's subscription contract",
    );
  });

  test("says so when the mandate is unknown", async () => {
    const result = await run(["charge", "999", "--yes"], {
      config: cliConfig({ KEEPER_SECRET: key.secret() }),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no mandate 999/);
  });
});

describe("cli reindex", () => {
  test("refuses to run without the confirmation", async () => {
    const result = await run(["reindex"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing to re-index without --yes/);
  });

  test("re-applies the events from the given ledger", async () => {
    const events = [rawPlanCreated(120), rawSubscribed(121)];
    const dir = await mkdtemp(join(tmpdir(), "payflow-cli-"));
    const path = join(dir, "payflow.db");
    try {
      const result = await run(["reindex", "--from", "120", "--yes"], {
        openDb: () => openDatabase(path),
        rpc: () => fakeRpc({ latest: 200, oldest: 0, events }),
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /re-indexed testnet from ledger 120/);
      assert.match(result.stdout, /2 event\(s\) applied/);
      // The projection holds what the events say, and the cursor caught up.
      const projection = openDatabase(path);
      const mandate = projection
        .prepare("SELECT * FROM mandates WHERE id = 7")
        .get() as { subscriber: string; amount: string } | undefined;
      assert.equal(mandate?.subscriber, SUBSCRIBER);
      assert.equal(mandate?.amount, "1000");
      assert.equal(readCursor(projection, 0), 200);
      projection.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-indexing twice leaves the projection unchanged", async () => {
    const events = [rawPlanCreated(120), rawSubscribed(121)];
    const dir = await mkdtemp(join(tmpdir(), "payflow-cli-"));
    const path = join(dir, "payflow.db");
    const rpc = () => fakeRpc({ latest: 200, oldest: 0, events });
    try {
      const first = await run(["reindex", "--from", "120", "--yes"], {
        openDb: () => openDatabase(path),
        rpc,
      });
      assert.equal(first.code, 0);
      const after = openDatabase(path).prepare("SELECT * FROM mandates WHERE id = 7").get();
      const charges = openDatabase(path).prepare("SELECT COUNT(*) AS n FROM charges").get();

      // The same range, applied again: every write is an idempotent upsert, so
      // the projection must not move.
      const second = await run(["reindex", "--from", "120", "--yes"], {
        openDb: () => openDatabase(path),
        rpc,
      });
      assert.equal(second.code, 0);
      const projection = openDatabase(path);
      assert.deepEqual(projection.prepare("SELECT * FROM mandates WHERE id = 7").get(), after);
      assert.deepEqual(projection.prepare("SELECT COUNT(*) AS n FROM charges").get(), charges);
      projection.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a ledger that is not a number", async () => {
    const result = await run(["reindex", "--from", "soon", "--yes"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--from must be a non-negative integer/);
  });

  test("refuses to move the cursor forward, which would skip the ledgers in between", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payflow-cli-"));
    const path = join(dir, "payflow.db");
    try {
      // A projection that has already been indexed up to ledger 100.
      const seed = openDatabase(path);
      writeCursor(seed, 100);
      seed.close();

      const result = await run(["reindex", "--from", "150", "--yes"], {
        openDb: () => openDatabase(path),
        rpc: () => fakeRpc({ latest: 200, oldest: 0 }),
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /refusing to move the cursor forward from 100 to 150/);
      assert.match(result.stderr, /--skip-ahead/);

      // The refused command changed nothing: the cursor is where it was.
      const projection = openDatabase(path);
      assert.equal(readCursor(projection, 0), 100);
      projection.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--skip-ahead accepts the gap the operator asked for", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payflow-cli-"));
    const path = join(dir, "payflow.db");
    try {
      const seed = openDatabase(path);
      writeCursor(seed, 100);
      seed.close();

      const result = await run(["reindex", "--from", "150", "--yes", "--skip-ahead"], {
        openDb: () => openDatabase(path),
        rpc: () => fakeRpc({ latest: 200, oldest: 0 }),
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /re-indexed testnet from ledger 150/);

      const projection = openDatabase(path);
      assert.equal(readCursor(projection, 0), 200);
      projection.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
