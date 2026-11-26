import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { createApp } from "../src/app.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import { DEFAULT_NOTIFICATION_EVENTS } from "../src/lib/notification-preferences.ts";
import { openDatabase } from "../src/lib/db.ts";
import { WebhookDispatcher } from "../src/lib/webhooks.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";

const merchantKey = Keypair.random();
const merchant = merchantKey.publicKey();
const otherKey = Keypair.random();
const subscriber = Keypair.random().publicKey();
const config = { CORS_ORIGIN: "*" } as unknown as Config;
const network: NetworkConfig = {
  name: "testnet",
  rpcUrl: "https://rpc.invalid",
  networkPassphrase: "Test SDF Network ; September 2015",
  planRegistryId: "C".repeat(56),
  vaultId: "C".repeat(56),
  subscriptionId: "C".repeat(56),
  startLedger: 0,
  databasePath: ":memory:",
};
const db = openDatabase(":memory:");
const calls: string[] = [];
const payloads: string[] = [];
const dispatcher = new WebhookDispatcher({
  db,
  lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
  fetchImpl: async (input, init) => {
    calls.push(String(input));
    payloads.push(String(init?.body));
    return new Response("", { status: 200 });
  },
});

let server: Server;
let base = "";

before(async () => {
  const app = createApp([{ config: network, db, webhooks: dispatcher }], config);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const address = server.address();
      base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  db.close();
});

function sign(key: Keypair, message: string): string {
  return Buffer.from(key.sign(Buffer.from(message, "utf8"))).toString("base64");
}

function setProof(events: string[], key = merchantKey, timestamp = Math.floor(Date.now() / 1000)) {
  const canonicalEvents = [...events].sort().join(",");
  return {
    timestamp,
    signature: sign(
      key,
      `payflow-notification-preferences:set:v1:${merchant}:${canonicalEvents}:${timestamp}`,
    ),
  };
}

async function put(events: string[], key = merchantKey, timestamp = Math.floor(Date.now() / 1000)) {
  return fetch(`${base}/api/v1/merchants/${merchant}/notification-preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events, ...setProof(events, key, timestamp) }),
  });
}

function charged(txHash: string): DecodedEvent {
  return {
    name: "charged",
    contractId: network.subscriptionId,
    ledger: 1,
    txHash,
    topics: [1n, subscriber, merchant],
    data: { amount: 1_000n, fee: 10n },
  };
}

test("merchant notification preferences default to all supported events and persist updates", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign(
    merchantKey,
    `payflow-notification-preferences:get:v1:${merchant}:${timestamp}`,
  );
  const query = new URLSearchParams({ timestamp: String(timestamp), signature });
  const initial = await fetch(
    `${base}/api/v1/merchants/${merchant}/notification-preferences?${query}`,
  );
  assert.equal(initial.status, 200);
  assert.deepEqual((await initial.json()).events, DEFAULT_NOTIFICATION_EVENTS);

  const hook = await dispatcher.register(merchant, "https://merchant.example/hook", "secret");
  calls.length = 0;
  await dispatcher.onApplied(charged("tx-default"));
  assert.deepEqual(calls, ["https://merchant.example/hook"]);

  const updated = await put(["charged"]);
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).events, ["charged"]);
  assert.equal(
    (db.prepare("SELECT events FROM merchant_notification_preferences WHERE merchant = ?").get(merchant) as { events: string }).events,
    '["charged"]',
  );

  await put([]);
  await dispatcher.onApplied(charged("tx-disabled"));
  assert.equal(calls.length, 1, "an empty preference list disables all webhook deliveries");
  assert.equal(await dispatcher.pendingCount(hook.id), 0);

  await put(["charge.failing"]);
  await dispatcher.onChargeStreak({
    kind: "charge.failing",
    mandateId: 1,
    subscriber,
    merchant,
    failures: 3,
    attemptId: 1,
    shortfall: "100",
    nextRetryAt: Math.floor(Date.now() / 1000) + 60,
    errorCode: null,
  });
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(payloads.at(-1) ?? "{}").event, "charge.failing");
});

test("preference updates reject invalid, duplicate, stale and unauthorized requests", async () => {
  const invalid = await put(["unknown"]);
  assert.equal(invalid.status, 400);

  const duplicate = await put(["charged", "charged"]);
  assert.equal(duplicate.status, 400);

  const stale = await put(["charged"], merchantKey, Math.floor(Date.now() / 1000) - 11 * 60);
  assert.equal(stale.status, 401);

  const unauthorized = await put(["charged"], otherKey);
  assert.equal(unauthorized.status, 401);

  const badAddress = await fetch(`${base}/api/v1/merchants/not-an-address/notification-preferences`);
  assert.equal(badAddress.status, 400);
});

test("strict request bodies reject extra fields before preferences are stored", async () => {
  const before = (db.prepare(
    "SELECT events FROM merchant_notification_preferences WHERE merchant = ?",
  ).get(merchant) as { events: string } | undefined)?.events;
  const events = ["charged"];
  const res = await fetch(`${base}/api/v1/merchants/${merchant}/notification-preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events, ...setProof(events), unexpected: "ignored" }),
  });
  assert.equal(res.status, 400);
  const after = (db.prepare(
    "SELECT events FROM merchant_notification_preferences WHERE merchant = ?",
  ).get(merchant) as { events: string } | undefined)?.events;
  assert.equal(after, before);
});
