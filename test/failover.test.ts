import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { nativeToScVal, rpc } from "@stellar/stellar-sdk";
import type { Account } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { FailoverRpc, makeRpc, type Dial, type RpcLike } from "../src/lib/stellar.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import type { Config } from "../src/config.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const config = {
  PLAN_REGISTRY_ID: CONTRACT,
  VAULT_ID: CONTRACT,
  SUBSCRIPTION_ID: CONTRACT,
  INDEXER_START_LEDGER: 1_000,
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  CORS_ORIGIN: "*",
} as unknown as Config;

/** A raw RPC event for a plan_created in `ledger`. */
function rawEvent(ledger: number, planId: number): rpc.Api.EventResponse {
  return {
    ledger,
    txHash: `tx-${planId}`,
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

interface FakeNode {
  url: string;
  latest: number;
  oldest: number;
  down: boolean;
  calls: string[];
  events: rpc.Api.EventResponse[];
}

function node(url: string, latest: number): FakeNode {
  return { url, latest, oldest: 1, down: false, calls: [], events: [] };
}

function fakeServer(node: FakeNode): RpcLike {
  const use = (op: string): void => {
    node.calls.push(op);
    if (node.down) throw new Error(`${node.url} is down`);
  };
  return {
    getHealth: async () => {
      use("getHealth");
      return { latestLedger: node.latest, oldestLedger: node.oldest, status: "healthy" } as never;
    },
    getLatestLedger: async () => {
      use("getLatestLedger");
      return { sequence: node.latest } as never;
    },
    getEvents: async (req: rpc.Api.GetEventsRequest) => {
      use("getEvents");
      const start = req.startLedger ?? 0;
      const end = req.endLedger ?? Infinity;
      const events = node.events.filter((e) => e.ledger >= start && e.ledger < end);
      return { events, cursor: "", latestLedger: node.latest } as never;
    },
    getAccount: async (address: string) => {
      use("getAccount");
      return { accountId: node.url, address } as unknown as Account;
    },
    prepareTransaction: async () => {
      use("prepareTransaction");
      throw new Error("prepareTransaction not faked");
    },
    sendTransaction: async () => {
      use("sendTransaction");
      throw new Error("sendTransaction not faked");
    },
    getTransaction: async () => {
      use("getTransaction");
      throw new Error("getTransaction not faked");
    },
  } as unknown as RpcLike;
}

/** A dial that hands out fake servers for URLs the nodes list knows. */
function dialNodes(nodes: FakeNode[]): Dial {
  const byUrl = new Map(nodes.map((n) => [n.url, n]));
  return (url: string): RpcLike => {
    const found = byUrl.get(url);
    if (!found) throw new Error(`no fake node at ${url}`);
    return fakeServer(found);
  };
}

function plans(db: ReturnType<typeof openDatabase>): number[] {
  return (db.prepare("SELECT id FROM plans ORDER BY id").all() as { id: number }[]).map((r) => r.id);
}

describe("rpc failover", () => {
  test("a failing endpoint fails over to the next and stays there", async () => {
    const a = node("http://a", 100);
    a.down = true;
    const b = node("http://b", 100);
    const client = new FailoverRpc(["http://a", "http://b"], dialNodes([a, b]));
    assert.deepEqual(client.endpoints, ["http://a", "http://b"]);
    assert.equal(client.active, "http://a");

    const latest = await client.getLatestLedger();

    assert.equal(latest.sequence, 100);
    assert.equal(client.active, "http://b");
    assert.deepEqual(a.calls, ["getLatestLedger"]);
    assert.deepEqual(b.calls, ["getLatestLedger"]);

    // Once switched, later calls go straight to the healthy endpoint.
    await client.getLatestLedger();
    assert.deepEqual(a.calls, ["getLatestLedger"]);
    assert.deepEqual(b.calls, ["getLatestLedger", "getLatestLedger"]);
  });

  test("calls the keeper makes fail over too", async () => {
    const a = node("http://a", 100);
    a.down = true;
    const b = node("http://b", 100);
    const client = new FailoverRpc(["http://a", "http://b"], dialNodes([a, b]));

    const account = await client.getAccount(MERCHANT);

    assert.equal(account.accountId, "http://b");
    assert.equal(client.active, "http://b");
  });

  test("a lagging endpoint is swapped for the freshest one", async () => {
    const a = node("http://a", 100);
    const b = node("http://b", 1_000);
    const client = new FailoverRpc(["http://a", "http://b"], dialNodes([a, b]));

    const health = await client.getHealth();

    assert.equal(health.latestLedger, 1_000);
    assert.equal(client.active, "http://b");
    assert.deepEqual(a.calls, ["getHealth"]);
    assert.deepEqual(b.calls, ["getHealth"]);
  });

  test("endpoints at the same ledger keep the active one", async () => {
    const a = node("http://a", 500);
    const b = node("http://b", 500);
    const client = new FailoverRpc(["http://a", "http://b"], dialNodes([a, b]));

    await client.getHealth();

    assert.equal(client.active, "http://a");
  });

  test("a health probe survives an endpoint that is down", async () => {
    const a = node("http://a", 900);
    a.down = true;
    const b = node("http://b", 800);
    const client = new FailoverRpc(["http://a", "http://b"], dialNodes([a, b]));

    const health = await client.getHealth();

    assert.equal(health.latestLedger, 800);
    assert.equal(client.active, "http://b");
  });

  test("when every endpoint fails the last error is thrown", async () => {
    const a = node("http://a", 100);
    a.down = true;
    const b = node("http://b", 100);
    b.down = true;
    const client = new FailoverRpc(["http://a", "http://b"], dialNodes([a, b]));

    await assert.rejects(() => client.getLatestLedger(), /http:\/\/b is down/);
    await assert.rejects(() => client.getHealth(), /is down/);
    assert.equal(client.active, "http://a");
  });

  test("an indexer pass rides out an outage on the active endpoint", async () => {
    const db = openDatabase(":memory:");
    const a = node("http://a", 0);
    a.down = true;
    const b = node("http://b", 1_100);
    b.events = [rawEvent(1_050, 1)];
    const client = new FailoverRpc(["http://a", "http://b"], dialNodes([a, b]));
    const ix = new Indexer(db, client, config);

    const r = await ix.tick();

    assert.equal(r.cursor, 1_100);
    assert.deepEqual(plans(db), [1]);
    assert.equal(client.active, "http://b");
  });

  test("makeRpc fronts every configured endpoint", () => {
    const nodes = [node("http://a", 1), node("http://b", 2)];
    const client = makeRpc({ SOROBAN_RPC_URL: ["http://a", "http://b"] } as unknown as Config, dialNodes(nodes));

    assert.deepEqual(client.endpoints, ["http://a", "http://b"]);
    assert.equal(client.active, "http://a");
  });

  test("/health reports the active endpoint and the list", async () => {
    const db = openDatabase(":memory:");
    const client = new FailoverRpc(
      ["http://a", "http://b"],
      dialNodes([node("http://a", 1), node("http://b", 2)]),
    );
    const app = createApp(db, config, undefined, client);
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const addr = server.address();
      const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      const body = (await (await fetch(`${base}/health`)).json()) as {
        rpc: { active: string; endpoints: string[] } | null;
      };

      assert.equal(body.rpc?.active, "http://a");
      assert.deepEqual(body.rpc?.endpoints, ["http://a", "http://b"]);
    } finally {
      server.close();
      db.close();
    }
  });
});
