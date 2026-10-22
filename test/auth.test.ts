import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import pino from "pino";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
  type rpc,
} from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { WebhookDispatcher } from "../src/lib/webhooks.ts";
import { logger, redact } from "../src/lib/logger.ts";
import { loadConfig, type Config, type NetworkConfig } from "../src/config.ts";
import { Sep10Auth, sep10For } from "../src/routes/auth.ts";

const HOME = "payflow.example";
const WEB = "api.payflow.example";
const ISSUER = `https://${WEB}/api/testnet/auth`;
const JWT_SECRET = "a-jwt-secret-that-is-at-least-32-characters";
const TTL = 900;

const testnet: NetworkConfig = {
  name: "testnet",
  rpcUrl: "https://rpc.invalid",
  networkPassphrase: Networks.TESTNET,
  planRegistryId: "C".repeat(56),
  vaultId: "C".repeat(56),
  subscriptionId: "C".repeat(56),
  startLedger: 0,
  databasePath: ":memory:",
};

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** A ledger key for an account, as a lookup key for the fake RPC. */
const accountKey = (account: string): string =>
  xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrAccountId() }),
  ).toXdr("base64");

/** A real account ledger entry: thresholds are [master, low, medium, high]. */
function accountEntry(
  account: Keypair,
  thresholds: [number, number, number, number],
  signers: Array<[Keypair, number]>,
): rpc.Api.GetLedgerEntriesResponse {
  const entry = new xdr.AccountEntry({
    accountId: account.xdrAccountId(),
    balance: 100_000_000n,
    seqNum: 1n,
    numSubEntries: signers.length,
    inflationDest: null,
    flags: 0,
    homeDomain: "",
    thresholds: Uint8Array.from(thresholds),
    signers: signers.map(
      ([key, weight]) => new xdr.Signer({ key: xdr.SignerKey.signerKeyTypeEd25519(key.rawPublicKey()), weight }),
    ),
    ext: xdr.AccountEntryExt.v0(),
  });
  return { entries: [{ val: xdr.LedgerEntryData.account(entry) }], latestLedger: 1 } as unknown as rpc.Api.GetLedgerEntriesResponse;
}

/** Sign a challenge envelope with the client's keys, as a wallet does. */
function signed(envelope: string, ...keys: Keypair[]): string {
  const tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET) as Transaction;
  tx.sign(...keys);
  return tx.toXDR();
}

/** An HS256 JWT signed with `secret`, for forging expired or foreign tokens. */
function forge(claims: Record<string, unknown>, secret = JWT_SECRET, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }): string {
  const body = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

const claimsOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;

describe("SEP-10 sign-in", () => {
  const server = Keypair.random();
  const client = Keypair.random();
  const accounts = new Map<string, rpc.Api.GetLedgerEntriesResponse>();
  let rpcDown = false;
  const fakeRpc = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse> => {
      if (rpcDown) throw new Error("rpc unreachable");
      return accounts.get(keys[0]!.toXdr("base64")) ?? { entries: [], latestLedger: 1 };
    },
  };
  const config = {
    CORS_ORIGIN: "http://localhost:3000",
    SEP10_SIGNING_KEY: server.secret(),
    SEP10_JWT_SECRET: JWT_SECRET,
    SEP10_HOME_DOMAIN: HOME,
    SEP10_WEB_AUTH_DOMAIN: WEB,
    SEP10_JWT_TTL_S: TTL,
  } as unknown as Config;

  const db = openDatabase(":memory:");
  const auth = sep10For(config, testnet, fakeRpc)!;
  const issued: string[] = [];
  const logged: string[] = [];
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => unknown }>)[pino.symbols.streamSym]!;
  const write = stream.write;
  let http: Server;
  let base = "";

  before(async () => {
    // Every line the service logs during these tests, to prove no key is in one.
    stream.write = function (line: string) {
      logged.push(String(line));
      return write.call(this, line);
    };
    const dispatcher = new WebhookDispatcher({
      db,
      fetchImpl: (async () => ({ status: 200, ok: true, text: async () => "ok" })) as unknown as typeof fetch,
    });
    const app = createApp([{ config: testnet, db, webhooks: dispatcher, auth }], config);
    await new Promise<void>((resolve) => {
      http = app.listen(0, () => {
        const addr = http.address();
        base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    stream.write = write;
    http.close();
    db.close();
  });

  const challenge = async (account: string): Promise<string> => {
    const res = await fetch(`${base}/api/auth?account=${account}`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { transaction: string }).transaction;
  };
  const exchange = async (transaction: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.token === "string") issued.push(body.token);
    return { status: res.status, body };
  };
  const signIn = async (key: Keypair = client): Promise<string> => {
    const res = await exchange(signed(await challenge(key.publicKey()), key));
    assert.equal(res.status, 200);
    return res.body.token as string;
  };
  const errorMessage = (body: Record<string, unknown>): string => (body.error as { message: string }).message;

  test("the challenge is a SEP-10 challenge transaction", async () => {
    const before = nowSec();
    const res = await fetch(`${base}/api/auth?account=${client.publicKey()}`, {
      headers: { origin: "https://wallet.example" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as { transaction: string; network_passphrase: string };
    assert.equal(body.network_passphrase, Networks.TESTNET);

    const tx = TransactionBuilder.fromXDR(body.transaction, Networks.TESTNET) as Transaction;
    assert.equal(tx.sequence, "0", "an invalid sequence number, so it can never be submitted");
    assert.equal(tx.source, server.publicKey());
    const minTime = Number(tx.timeBounds!.minTime);
    const maxTime = Number(tx.timeBounds!.maxTime);
    assert.ok(minTime >= before - 1 && minTime <= nowSec());
    assert.equal(maxTime - minTime, 900, "fifteen minutes, as SEP-10 recommends");

    const [first, second, ...rest] = tx.operations;
    assert.equal(rest.length, 0);
    assert.equal(first!.type, "manageData");
    assert.equal(first!.source, client.publicKey());
    assert.equal((first as Operation.ManageData).name, `${HOME} auth`);
    const nonce = (first as Operation.ManageData).value!;
    assert.equal(nonce.length, 64, "64 bytes on the wire");
    assert.equal(Buffer.from(Buffer.from(nonce).toString("utf8"), "base64").length, 48, "a base64-encoded 48-byte nonce");
    assert.equal(second!.type, "manageData");
    assert.equal(second!.source, server.publicKey());
    assert.equal((second as Operation.ManageData).name, "web_auth_domain");
    assert.equal(Buffer.from((second as Operation.ManageData).value!).toString("utf8"), WEB);

    assert.equal(tx.signatures.length, 1);
    assert.ok(server.verify(Buffer.from(tx.hash()), Buffer.from(tx.signatures[0]!.signature.toBytes())), "signed by the server");
  });

  test("the challenge refuses what a merchant sign-in cannot be", async () => {
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([client.rawPublicKey(), Buffer.alloc(8)]));
    for (const query of [
      "",
      "account=not-an-account",
      `account=${muxed}`,
      `account=${StrKey.encodeContract(Buffer.alloc(32))}`,
      `account=${client.publicKey()}&memo=1`,
      `account=${client.publicKey()}&home_domain=other.example`,
    ]) {
      const res = await fetch(`${base}/api/auth?${query}`, { headers: { origin: "https://wallet.example" } });
      assert.equal(res.status, 400, query);
      assert.equal(res.headers.get("access-control-allow-origin"), "*", "errors carry the SEP-10 CORS header too");
    }
    // The configured home domain itself is accepted; client_domain is ignored.
    const ok = await fetch(`${base}/api/auth?account=${client.publicKey()}&home_domain=${HOME}&client_domain=wallet.example`);
    assert.equal(ok.status, 200);
  });

  test("other routes keep the configured CORS origin", async () => {
    const res = await fetch(`${base}/api/plans`, { headers: { origin: "https://wallet.example" } });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  test("a signed challenge for an account not on the network is exchanged for a JWT", async () => {
    const transaction = signed(await challenge(client.publicKey()), client);
    const before = nowSec();
    const res = await exchange(transaction);
    assert.equal(res.status, 200);
    const token = res.body.token as string;
    const claims = claimsOf(token);
    assert.equal(claims.iss, ISSUER);
    assert.equal(claims.sub, client.publicKey());
    assert.ok((claims.iat as number) >= before);
    assert.equal((claims.exp as number) - (claims.iat as number), TTL);
    const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET) as Transaction;
    assert.equal(claims.jti, Buffer.from(tx.hash()).toString("hex"), "jti is the challenge's hash");
    assert.equal(auth.verify(token), client.publicKey());
  });

  test("the token endpoint accepts a form-encoded challenge", async () => {
    const transaction = signed(await challenge(client.publicKey()), client);
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ transaction }).toString(),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    issued.push(((await res.json()) as { token: string }).token);
  });

  test("a challenge is exchanged for at most one token", async () => {
    const transaction = signed(await challenge(client.publicKey()), client);
    assert.equal((await exchange(transaction)).status, 200);
    const again = await exchange(transaction);
    assert.equal(again.status, 400);
    assert.match(errorMessage(again.body), /already been used/);
  });

  test("a challenge without the client's signature, or signed by another key, is refused", async () => {
    const unsigned = await challenge(client.publicKey());
    assert.equal((await exchange(unsigned)).status, 400);
    assert.equal((await exchange(signed(unsigned, Keypair.random()))).status, 400);
    // Signed twice by the client: SEP-10 wants exactly one master signature.
    assert.equal((await exchange(signed(unsigned, client, client))).status, 400);
    // The refusals did not burn the challenge.
    assert.equal((await exchange(signed(unsigned, client))).status, 200);
  });

  test("a challenge another server signed, or a malformed one, is refused", async () => {
    const otherServer = new Sep10Auth({
      signingKey: Keypair.random().secret(),
      jwtSecret: JWT_SECRET,
      homeDomain: HOME,
      webAuthDomain: WEB,
      networkPassphrase: Networks.TESTNET,
      issuer: ISSUER,
      tokenTtlS: TTL,
      loadAccount: async () => null,
    });
    const foreign = signed(otherServer.challenge(client.publicKey()).transaction, client);
    assert.equal((await exchange(foreign)).status, 400);
    assert.equal((await exchange("not-a-transaction")).status, 400);
    const missing = await fetch(`${base}/api/auth`, { method: "POST" });
    assert.equal(missing.status, 400);
  });

  test("an expired challenge is refused", async () => {
    // Past its time bounds and the five-minute grace the verifier allows.
    const now = nowSec();
    const tx = new TransactionBuilder(new Account(server.publicKey(), "-1"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: now - 2_000, maxTime: now - 1_100 },
    })
      .addOperation(Operation.manageData({ name: `${HOME} auth`, value: randomBytes(48).toString("base64"), source: client.publicKey() }))
      .addOperation(Operation.manageData({ name: "web_auth_domain", value: WEB, source: server.publicKey() }))
      .build();
    tx.sign(server, client);
    const res = await exchange(tx.toXDR());
    assert.equal(res.status, 400);
    assert.match(errorMessage(res.body), /expired/);
  });

  test("an existing account must meet its medium threshold with its own signers", async () => {
    const merchant = Keypair.random();
    const cosignerA = Keypair.random();
    const cosignerB = Keypair.random();
    // Master key disabled (weight 0); two co-signers of weight 1; medium 2.
    accounts.set(accountKey(merchant.publicKey()), accountEntry(merchant, [0, 1, 2, 3], [[cosignerA, 1], [cosignerB, 1]]));

    const byMaster = await exchange(signed(await challenge(merchant.publicKey()), merchant));
    assert.equal(byMaster.status, 400, "a disabled master key cannot sign in");
    const short = await exchange(signed(await challenge(merchant.publicKey()), cosignerA));
    assert.equal(short.status, 400, "one co-signer is below the medium threshold");
    assert.match(errorMessage(short.body), /threshold/);

    const res = await exchange(signed(await challenge(merchant.publicKey()), cosignerA, cosignerB));
    assert.equal(res.status, 200);
    assert.equal(claimsOf(res.body.token as string).sub, merchant.publicKey());
  });

  test("an existing account with default thresholds signs in with its master key", async () => {
    const merchant = Keypair.random();
    accounts.set(accountKey(merchant.publicKey()), accountEntry(merchant, [1, 0, 0, 0], []));
    const res = await exchange(signed(await challenge(merchant.publicKey()), merchant));
    assert.equal(res.status, 200);
  });

  test("an RPC failure is an error, not an account that does not exist", async () => {
    const transaction = signed(await challenge(client.publicKey()), client);
    rpcDown = true;
    try {
      const res = await exchange(transaction);
      assert.equal(res.status, 500);
    } finally {
      rpcDown = false;
    }
    assert.equal((await exchange(transaction)).status, 200, "the challenge can be retried");
  });

  describe("bearer tokens on merchant-only routes", () => {
    const list = (token: string, query = ""): Promise<Response> =>
      fetch(`${base}/api/webhooks${query}`, { headers: { authorization: `Bearer ${token}` } });

    test("register, list, rotate and delete a webhook with a token instead of signatures", async () => {
      const token = await signIn();
      const registered = await fetch(`${base}/api/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: "https://merchant.example/hooks" }),
      });
      assert.equal(registered.status, 200);
      const hook = (await registered.json()) as { id: number; merchant: string };
      assert.equal(hook.merchant, client.publicKey(), "the merchant is the token's account");

      const listed = await list(token);
      assert.equal(listed.status, 200);
      const body = (await listed.json()) as { merchant: string; webhooks: Array<{ id: number }> };
      assert.equal(body.merchant, client.publicKey());
      assert.ok(body.webhooks.some((w) => w.id === hook.id));

      const auth = { authorization: `Bearer ${token}` };
      const rotated = await fetch(`${base}/api/webhooks/${hook.id}/rotate`, { method: "POST", headers: auth });
      assert.equal(rotated.status, 200);
      const history = await fetch(`${base}/api/webhooks/${hook.id}/deliveries`, { headers: auth });
      assert.equal(history.status, 200);
      const deleted = await fetch(`${base}/api/webhooks/${hook.id}`, { method: "DELETE", headers: auth });
      assert.equal(deleted.status, 204);
    });

    test("a token for one account cannot act for another", async () => {
      const token = await signIn();
      const other = Keypair.random().publicKey();
      assert.equal((await list(token, `?merchant=${other}`)).status, 401);
      const res = await fetch(`${base}/api/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ merchant: other, url: "https://merchant.example/x" }),
      });
      assert.equal(res.status, 401);
      // Naming its own account is fine.
      assert.equal((await list(token, `?merchant=${client.publicKey()}`)).status, 200);
    });

    test("expired, tampered, foreign and malformed tokens are refused", async () => {
      const token = await signIn();
      const claims = claimsOf(token);
      const now = nowSec();
      const [header, , signature] = token.split(".");
      const tampered = `${header}.${Buffer.from(JSON.stringify({ ...claims, sub: Keypair.random().publicKey() })).toString("base64url")}.${signature}`;
      for (const bad of [
        forge({ ...claims, iat: now - 2 * TTL, exp: now - TTL }),
        tampered,
        `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`,
        forge(claims, "another-secret-that-is-also-32-characters"),
        forge({ ...claims, iss: `https://${WEB}/api/mainnet/auth` }),
        forge(claims, JWT_SECRET, { alg: "none", typ: "JWT" }),
        `${token.split(".").slice(0, 2).join(".")}.`,
        "not-a-jwt",
      ]) {
        const res = await list(bad);
        assert.equal(res.status, 401, bad);
        assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unauthorized");
      }
      const basic = await fetch(`${base}/api/webhooks`, { headers: { authorization: "Basic dXNlcjpwYXNz" } });
      assert.equal(basic.status, 401);
    });

    test("signed messages keep working beside tokens", async () => {
      const t = nowSec();
      const signature = Buffer.from(client.sign(Buffer.from(`payflow-webhook-list:v1:${client.publicKey()}:${t}`))).toString("base64");
      const res = await fetch(`${base}/api/webhooks?${new URLSearchParams({ merchant: client.publicKey(), timestamp: String(t), signature })}`);
      assert.equal(res.status, 200);
    });
  });

  test("the server key and JWT secret never reach a log line or a serialised object", () => {
    assert.ok(logged.length > 0, "the log capture saw the requests above");
    const all = logged.join("\n");
    assert.ok(!all.includes(server.secret()), "the server seed is never logged");
    assert.ok(!all.includes(JWT_SECRET), "the JWT secret is never logged");
    for (const token of issued) assert.ok(!all.includes(token), "issued tokens are never logged");
    const serialised = JSON.stringify(auth);
    assert.ok(!serialised.includes(server.secret()) && !serialised.includes(JWT_SECRET));

    // And a config object logged by mistake has both keys redacted.
    const lines: string[] = [];
    const log = pino({ redact }, { write: (line: string) => lines.push(line) });
    log.info({ SEP10_SIGNING_KEY: server.secret(), SEP10_JWT_SECRET: JWT_SECRET }, "top level");
    log.info({ config: { SEP10_SIGNING_KEY: server.secret(), SEP10_JWT_SECRET: JWT_SECRET } }, "nested");
    assert.ok(!lines.join("").includes(server.secret()));
    assert.ok(!lines.join("").includes(JWT_SECRET));
  });
});

describe("SEP-10 configuration", () => {
  const BASE = {
    PLAN_REGISTRY_ID: StrKey.encodeContract(Buffer.alloc(32)),
    VAULT_ID: StrKey.encodeContract(Buffer.alloc(32)),
    SUBSCRIPTION_ID: StrKey.encodeContract(Buffer.alloc(32)),
  };
  const seed = Keypair.random().secret();
  const rpcNever = { getLedgerEntries: async () => assert.fail("no RPC call is expected") };

  test("sign-in is off until a signing key is configured", () => {
    const config = loadConfig({ ...BASE, SEP10_SIGNING_KEY: "", SEP10_JWT_SECRET: "", SEP10_HOME_DOMAIN: "" });
    assert.equal(sep10For(config, testnet, rpcNever), undefined);
  });

  test("a signing key needs a JWT secret and a home domain", () => {
    assert.throws(() => loadConfig({ ...BASE, SEP10_SIGNING_KEY: seed }), /SEP10_JWT_SECRET and SEP10_HOME_DOMAIN/);
    assert.throws(() => loadConfig({ ...BASE, SEP10_SIGNING_KEY: "not-a-seed", SEP10_JWT_SECRET: JWT_SECRET, SEP10_HOME_DOMAIN: HOME }), /SEP10_SIGNING_KEY/);
    assert.throws(() => loadConfig({ ...BASE, SEP10_SIGNING_KEY: seed, SEP10_JWT_SECRET: "short", SEP10_HOME_DOMAIN: HOME }), /SEP10_JWT_SECRET/);
    assert.throws(() => loadConfig({ ...BASE, SEP10_SIGNING_KEY: seed, SEP10_JWT_SECRET: JWT_SECRET, SEP10_HOME_DOMAIN: "https://payflow.example" }), /SEP10_HOME_DOMAIN/);
    assert.throws(() => loadConfig({ ...BASE, SEP10_SIGNING_KEY: seed, SEP10_JWT_SECRET: JWT_SECRET, SEP10_HOME_DOMAIN: `${"a".repeat(57)}.io` }), /SEP10_HOME_DOMAIN/);
  });

  test("the web auth domain defaults to the home domain and names the issuer", async () => {
    const config = loadConfig({ ...BASE, SEP10_SIGNING_KEY: seed, SEP10_JWT_SECRET: JWT_SECRET, SEP10_HOME_DOMAIN: "localhost:8080" });
    assert.equal(config.SEP10_JWT_TTL_S, 3_600);
    const auth = sep10For(config, { ...testnet, name: "mainnet", networkPassphrase: Networks.PUBLIC }, { getLedgerEntries: async () => ({ entries: [], latestLedger: 1 }) as never })!;
    assert.equal(auth.webAuthDomain, "localhost:8080");
    const client = Keypair.random();
    const { transaction, network_passphrase } = auth.challenge(client.publicKey());
    assert.equal(network_passphrase, Networks.PUBLIC);
    const tx = TransactionBuilder.fromXDR(transaction, Networks.PUBLIC) as Transaction;
    tx.sign(client);
    const { token } = await auth.token(tx.toXDR());
    assert.equal(claimsOf(token).iss, "https://localhost:8080/api/mainnet/auth");
  });
});
