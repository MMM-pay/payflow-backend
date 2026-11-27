import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import pino from "pino";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { logger, maskAccount, maskIp, requestForLog } from "../src/lib/logger.ts";
import type { Config, NetworkConfig } from "../src/config.ts";

/**
 * #285: subscriber and merchant accounts, and client IP addresses, never
 * reach a log line at info level or above in full.
 */

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

const config = { CORS_ORIGIN: "*" } as unknown as Config;

describe("maskAccount", () => {
  test("shortens an account to its first and last four characters", () => {
    const account = Keypair.random().publicKey();
    assert.equal(maskAccount(account), `${account.slice(0, 4)}...${account.slice(-4)}`);
  });

  test("masks a muxed account and every account inside a longer string", () => {
    const account = Keypair.random().publicKey();
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([Keypair.random().rawPublicKey(), Buffer.alloc(8, 1)]));
    assert.equal(muxed.length, 69);
    const masked = maskAccount(`/api/subscribers/${account}/summary?merchant=${muxed}`);
    assert.ok(!masked.includes(account) && !masked.includes(muxed));
    assert.equal(masked, `/api/subscribers/${account.slice(0, 4)}...${account.slice(-4)}/summary?merchant=${muxed.slice(0, 4)}...${muxed.slice(-4)}`);
  });

  test("leaves contract ids, short strings and other text alone", () => {
    const contract = StrKey.encodeContract(Buffer.alloc(32, 7));
    for (const value of [contract, "GAAA", "", "mandate 42 settled", "g".repeat(56)]) {
      assert.equal(maskAccount(value), value);
    }
  });
});

describe("maskIp", () => {
  test("cuts IPv4 to its /24 and IPv6 to its /48", () => {
    assert.equal(maskIp("203.0.113.9"), "203.0.113.0");
    assert.equal(maskIp("::ffff:198.51.100.77"), "198.51.100.0");
    assert.equal(maskIp(" 192.0.2.1 "), "192.0.2.0");
    assert.equal(maskIp("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:db8:85a3::");
    assert.equal(maskIp("2001:db8::1"), "2001:db8::");
    assert.equal(maskIp("::1"), "::");
  });

  test("anything that is not an IP address is redacted outright", () => {
    assert.equal(maskIp("unknown"), "[Redacted]");
    assert.equal(maskIp("_hidden"), "[Redacted]");
  });
});

describe("requestForLog", () => {
  test("never changes the live request's headers", () => {
    const live = { "x-forwarded-for": "203.0.113.9, 10.0.0.1", host: "api.example" };
    const out = requestForLog({ url: "/", headers: live, remoteAddress: "10.0.0.2" });
    assert.equal(live["x-forwarded-for"], "203.0.113.9, 10.0.0.1");
    assert.equal(out.headers!["x-forwarded-for"], "203.0.113.0, 10.0.0.0");
    assert.equal(out.headers!.host, "api.example");
    assert.equal(out.remoteAddress, "10.0.0.0");
  });

  test("masks accounts in the query and params and redacts a Forwarded header", () => {
    const account = Keypair.random().publicKey();
    const out = requestForLog({
      url: `/x?merchant=${account}`,
      query: { merchant: account, limit: 5 },
      params: { address: account },
      headers: { forwarded: "for=203.0.113.9;proto=https", referer: `https://app.example/m/${account}` },
    });
    assert.ok(!JSON.stringify(out).includes(account));
    assert.equal(out.query!.limit, 5);
    assert.equal(out.headers!.forwarded, "[Redacted]");
  });
});

describe("access log lines", () => {
  const db = openDatabase(":memory:");
  const logged: string[] = [];
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => unknown }>)[pino.symbols.streamSym]!;
  const write = stream.write;
  const level = logger.level;
  let server: Server;
  let base = "";

  before(async () => {
    // Asserts on what was logged, so it raises the level itself: CI runs a
    // job with LOG_LEVEL=fatal, which would otherwise leave the capture empty.
    logger.level = "info";
    stream.write = function (line: string) {
      logged.push(String(line));
      return true;
    };
    const app = createApp([{ config: testnet, db }], config);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    stream.write = write;
    logger.level = level;
    server.close();
    db.close();
  });

  test("carry neither a full subscriber or merchant account nor a full client IP", async () => {
    const subscriber = Keypair.random().publicKey();
    const merchant = Keypair.random().publicKey();
    const forwarded = "203.0.113.9";
    for (const path of [
      `/api/subscribers/${subscriber}/summary`,
      `/api/subscribers/${subscriber}/upcoming`,
      `/api/merchants/${merchant}/subscribers?limit=5`,
      `/api/mandates?subscriber=${subscriber}&merchant=${merchant}`,
    ]) {
      const res = await fetch(`${base}${path}`, {
        headers: { "x-forwarded-for": forwarded, referer: `https://app.example/s/${subscriber}` },
      });
      await res.arrayBuffer();
    }
    // pino-http writes its line once the response has finished.
    await new Promise((resolve) => setImmediate(resolve));

    const access = logged.filter((line) => line.includes('"req":'));
    assert.ok(access.length >= 4, "every request was logged");
    const all = logged.join("\n");
    assert.ok(!all.includes(subscriber), "the subscriber account is never logged in full");
    assert.ok(!all.includes(merchant), "the merchant account is never logged in full");
    assert.ok(!all.includes(forwarded), "the forwarded client IP is never logged in full");
    assert.ok(!/"remoteAddress":"127\.0\.0\.1"/.test(all), "the socket address is never logged in full");

    // What is logged is still useful: the route and a recognisable account.
    const line = JSON.parse(access[0]!) as { req: { url: string; headers: Record<string, string>; remoteAddress: string } };
    assert.equal(line.req.url, `/api/subscribers/${maskAccount(subscriber)}/summary`);
    assert.equal(line.req.headers["x-forwarded-for"], "203.0.113.0");
    assert.equal(line.req.remoteAddress, "127.0.0.0");
  });
});
