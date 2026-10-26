import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import { PayflowClient } from "../src/client/index.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import { testAddress } from "./addresses.ts";

/**
 * The versioned API and its unversioned alias.
 *
 * `/api/v1/...` is the canonical surface and `/api/...` keeps answering the
 * same routes for clients written before versioning. Both are mounted from
 * one router, so this test pins the promise that they cannot drift apart:
 * every route the test knows about is fetched from both roots and the status,
 * content type and JSON body must be identical.
 */

const MERCHANT = testAddress(40);
const SUBSCRIBER = testAddress(41);
const TOKEN = "CDQ5EJTVXXX2CBMHWP3BGGUDHSK6D4I25IF5XXH3QGL2TNTBMJUOFKDB";

const testnet: NetworkConfig = {
  name: "testnet",
  rpcUrl: "https://rpc.invalid",
  networkPassphrase: "Test SDF Network ; September 2015",
  planRegistryId: "C".repeat(56),
  vaultId: "C".repeat(56),
  subscriptionId: "C".repeat(56),
  startLedger: 0,
  databasePath: ":memory:",
};
const mainnet: NetworkConfig = { ...testnet, name: "mainnet" };
const config = { CORS_ORIGIN: "*" } as unknown as Config;

const status = { cursor: 100, latest: 100, lastRunAt: null, lastError: null };
const db = openDatabase(":memory:");
const mainnetDb = openDatabase(":memory:");

let server: Server;
let base = "";

const ev = (
  name: string,
  topics: unknown[],
  data: Record<string, unknown>,
  tx = "t",
): DecodedEvent => ({ name, contractId: "C", ledger: 1, txHash: tx, topics, data });

before(async () => {
  const ix = new Indexer(db, {} as never, {} as never);
  ix.apply(ev("plan_created", [MERCHANT, 1n], {
    token: TOKEN, amount: 10_000_000n, period: 2_592_000n,
  }));
  ix.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 10_000_000n, period: 2_592_000n,
    next_charge: 1n, fee_bps: 100n,
  }, "tx-subscribed"));
  ix.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
    amount: 9_900_000n, fee: 100_000n, charges_made: 1n, next_charge: 4_000_000_000n,
  }, "tx-charge"));
  ix.apply(ev("deposit", [SUBSCRIBER, TOKEN], {
    amount: 20_000_000n, balance: 20_000_000n,
  }, "tx-deposit"));

  const app = createApp(
    [
      { config: testnet, db, indexer: status },
      { config: mainnet, db: mainnetDb },
    ],
    config,
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  db.close();
  mainnetDb.close();
});

/** Every route the test compares between the two roots. */
const ROUTES = [
  "/plans",
  "/plans/1",
  "/plans/1/stats",
  "/plans/9999",
  "/mandates",
  "/mandates/1",
  "/mandates/1/charges",
  "/mandates/1/timeline",
  "/due",
  "/protocol",
  "/protocol/fees",
  "/stats",
  `/merchants/${MERCHANT}/summary`,
  `/merchants/${MERCHANT}/subscribers`,
  `/merchants/${MERCHANT}/churn`,
  `/merchants/${MERCHANT}/revenue`,
  `/merchants/${MERCHANT}/forecast`,
  `/subscribers/${SUBSCRIBER}/summary`,
  `/subscribers/${SUBSCRIBER}/upcoming`,
  `/vault/${SUBSCRIBER}`,
  `/vault/${SUBSCRIBER}/events`,
  "/tokens/" + TOKEN,
  "/nope",
];

interface Answer {
  status: number;
  contentType: string | null;
  body: unknown;
}

/** Fetch one path with a fixed request id, so error envelopes are stable. */
async function get(path: string): Promise<Answer> {
  const res = await fetch(`${base}${path}`, { headers: { "x-request-id": "versioning" } });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

describe("the versioned API", () => {
  for (const route of ROUTES) {
    test(`${route} answers the same under /api and /api/v1`, async () => {
      const legacy = await get(`/api${route}`);
      const versioned = await get(`/api/v1${route}`);
      assert.deepEqual(
        versioned,
        legacy,
        `${route} differs between the versioned API and its alias`,
      );
    });
  }

  test("each network answers the same under both roots", async () => {
    for (const network of ["testnet", "mainnet"]) {
      const legacy = await get(`/api/${network}/plans`);
      const versioned = await get(`/api/v1/${network}/plans`);
      assert.deepEqual(versioned, legacy, `${network} differs between the two roots`);
      assert.equal(versioned.status, 200);
    }
  });

  test("the OpenAPI document is served identically under both roots", async () => {
    const legacy = await get("/api/openapi.json");
    const versioned = await get("/api/v1/openapi.json");
    assert.deepEqual(versioned, legacy);
    const spec = versioned.body as { paths: Record<string, unknown> };
    // The canonical versioned paths are documented, and so are the aliases.
    assert.ok("/api/v1/plans" in spec.paths);
    assert.ok("/api/plans" in spec.paths);
    assert.ok("/api/v1/mainnet/plans" in spec.paths);
    assert.ok("/api/mainnet/plans" in spec.paths);
  });

  test("the keeper history is answered under both roots", async () => {
    const keeperApp = createApp(
      db,
      { CORS_ORIGIN: "*", KEEPER_ENABLED: true } as unknown as Config,
      undefined,
      { keeperHistory: () => [{ pass: 1 }] },
    );
    const local = await new Promise<Server>((resolve) => {
      const s = keeperApp.listen(0, () => resolve(s));
    });
    try {
      const addr = local.address();
      const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      for (const path of ["/api/keeper", "/api/v1/keeper"]) {
        const res = await fetch(url + path);
        assert.equal(res.status, 200, `${path} answers`);
        assert.deepEqual(await res.json(), { passes: [{ pass: 1 }] });
      }
    } finally {
      local.close();
    }
  });

  test("the typed client names the version it was built against", async () => {
    const requested: string[] = [];
    const client = new PayflowClient({
      baseUrl: "http://payflow.invalid",
      fetch: (input) => {
        requested.push(String(input));
        return Promise.resolve(
          new Response(JSON.stringify({ plans: [], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });
    await client.plans();
    assert.equal(new URL(requested[0]!).pathname, "/api/v1/plans");
  });
});
