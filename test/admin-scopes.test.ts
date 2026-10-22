import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { Indexer } from "../src/indexer.ts";
import { getProtocolFeeHistory } from "../src/lib/queries.ts";
import type { AdminHooks, AdminToken } from "../src/routes/admin.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";

const C = "C".repeat(56);

function config(extra: Partial<Record<string, unknown>>): Config {
  return {
    STELLAR_NETWORK: "testnet",
    PLAN_REGISTRY_ID: C,
    VAULT_ID: C,
    SUBSCRIPTION_ID: C,
    CORS_ORIGIN: "*",
    PORT: 0,
    ...extra,
  } as unknown as Config;
}

async function start(cfg: Config, hooks: AdminHooks = {}) {
  const db = openDatabase(":memory:");
  const app = createApp(db, cfg, undefined, hooks);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const call = async (method: string, path: string, token?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { call, stop: () => { server.close(); db.close(); } };
}

const hooks: AdminHooks = { reindex: async () => ({ ok: true }), keeperPass: async () => [] };

describe("scoped admin tokens", () => {
  test("a colon in ADMIN_TOKEN is part of the secret, not a scope separator", async () => {
    const { call, stop } = await start(config({ ADMIN_TOKEN: "s3cret-part-one:reindex" }), hooks);
    try {
      assert.equal((await call("POST", "/admin/reindex", "s3cret-part-one")).status, 401);
      assert.equal((await call("POST", "/admin/keeper/run", "s3cret-part-one:reindex")).status, 200);
    } finally {
      stop();
    }
  });

  test("ADMIN_TOKENS scopes and expiry are enforced", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tokens: AdminToken[] = [
      { token: "reindex-only-token-0001", scopes: ["reindex"] },
      { token: "expired-token-000000001", expiresAt: now - 10 },
      { token: "future-token-0000000001", expiresAt: now + 3600 },
    ];
    const { call, stop } = await start(config({ ADMIN_TOKENS: tokens }), hooks);
    try {
      assert.equal((await call("POST", "/admin/reindex", "reindex-only-token-0001")).status, 200);
      assert.equal((await call("POST", "/admin/keeper/run", "reindex-only-token-0001")).status, 403);
      assert.equal((await call("POST", "/admin/reindex", "expired-token-000000001")).status, 401);
      assert.equal((await call("POST", "/admin/keeper/run", "future-token-0000000001")).status, 200);
    } finally {
      stop();
    }
  });

  test("ADMIN_TOKENS is validated when the config loads", () => {
    // Real (checksummed) contract ids: the config validates them.
    const base = {
      PLAN_REGISTRY_ID: "CDQ5EJTVXXX2CBMHWP3BGGUDHSK6D4I25IF5XXH3QGL2TNTBMJUOFKDB",
      VAULT_ID: "CBNQEWSYYQOKNX5KB62OFT6ID5TCVSWN4PS4AXAJK6IWUEXOLVN6DXII",
      SUBSCRIPTION_ID: "CD5YZUJU6WLFIHGAV4J2BV42GCVZE5ZGDUGSW5CBRIA47TQHSZZW3XMM",
    };
    assert.throws(() => loadConfig({ ...base, ADMIN_TOKENS: "not json" }));
    assert.throws(() => loadConfig({ ...base, ADMIN_TOKENS: '[{"token":"short"}]' }));
    const ok = loadConfig({ ...base, ADMIN_TOKENS: '[{"token":"a-long-enough-token-1","scopes":["keeper"]}]' });
    assert.equal((ok.ADMIN_TOKENS as AdminToken[])[0]!.scopes![0], "keeper");
  });
});

describe("version endpoint", () => {
  test("reports the package version, network and contracts", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const { call, stop } = await start(config({}));
    try {
      const res = await call("GET", "/version");
      assert.equal(res.status, 200);
      assert.equal(res.body.version, pkg.version);
      assert.equal(res.body.network, "testnet");
      assert.deepEqual(res.body.contracts, { planRegistry: C, vault: C, subscription: C });
    } finally {
      stop();
    }
  });
});

describe("contract upgrades", () => {
  test("an upgraded event shows up as the contract's current code version", () => {
    const db = openDatabase(":memory:");
    const ix = new Indexer(db, {} as never, {} as never);
    const hash = Buffer.alloc(32, 0xab);
    const event = (ledger: number, tx: string, h: Buffer): DecodedEvent =>
      ({ name: "upgraded", contractId: C, ledger, txHash: tx, topics: [], data: { new_wasm_hash: h }, closeTime: 1_800_000_000 }) as unknown as DecodedEvent;
    assert.equal(ix.apply(event(10, "tx-a", Buffer.alloc(32, 0x01))), "applied");
    assert.equal(ix.apply(event(20, "tx-b", hash)), "applied");
    ix.apply(event(20, "tx-b", hash)); // replay is a no-op
    const body = getProtocolFeeHistory(db);
    assert.deepEqual(body.contract_versions.map((r) => ({ ...r })), [{ contract_id: C, wasm_hash: hash.toString("hex"), ledger: 20 }]);
  });
});
