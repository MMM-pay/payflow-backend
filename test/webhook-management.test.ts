import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import { WebhookDispatcher } from "../src/lib/webhooks.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import type { WebhookDeliveriesResponse, WebhookRotation, WebhookTestResult } from "../src/routes/types.ts";

/**
 * Webhook management beyond registration: rotating a signing secret (#139),
 * sending a test event (#138) and reading the delivery history (#140).
 */

const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const OVERLAP_S = 3_600;

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

const nowSec = (): number => Math.floor(Date.now() / 1000);
const hmac = (secret: string, body: string): string =>
  `sha256=${createHmac("sha256", Buffer.from(secret, "utf8")).update(body).digest("hex")}`;
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe("webhook management", () => {
  const merchantKey = Keypair.random();
  const merchant = merchantKey.publicKey();
  const otherKey = Keypair.random();

  const db = openDatabase(":memory:");
  const ix = new Indexer(db, {} as never, {} as never);
  /** Every POST the dispatcher made. */
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  /** Per-URL scripted answers, consumed in order; then 200. "throw" is a network error. */
  const script = new Map<string, Array<number | "throw">>();
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    calls.push({ url, headers, body: String(init?.body ?? "") });
    const next = script.get(url)?.shift() ?? 200;
    if (next === "throw") throw new Error("connect ECONNREFUSED");
    return { status: next, ok: next >= 200 && next < 300, text: async () => "" } as unknown as Response;
  };
  const dispatcher = new WebhookDispatcher({
    db,
    events: ix.events,
    fetchImpl: fetchImpl as typeof fetch,
    secretOverlapSeconds: OVERLAP_S,
  });
  dispatcher.bind(ix.events);

  let http: Server;
  let base = "";

  before(async () => {
    const app = createApp([{ config: testnet, db, events: ix.events, webhooks: dispatcher }], config);
    await new Promise<void>((resolve) => {
      http = app.listen(0, () => {
        const addr = http.address();
        base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    http.close();
    db.close();
  });

  /** `{ merchant, timestamp, signature }` over `<prefix>:<merchant>:<id>:<timestamp>`. */
  const proof = (prefix: string, id: number, key: Keypair = merchantKey, timestamp = nowSec()) => ({
    merchant: key.publicKey(),
    timestamp,
    signature: Buffer.from(key.sign(Buffer.from(`${prefix}:${key.publicKey()}:${id}:${timestamp}`))).toString("base64"),
  });
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const rotate = (id: number, key?: Keypair) => post(`/api/webhooks/${id}/rotate`, proof("payflow-webhook-rotate:v1", id, key));
  const ping = (id: number, key?: Keypair) => post(`/api/webhooks/${id}/test`, proof("payflow-webhook-test:v1", id, key));
  const history = (id: number, key?: Keypair) =>
    fetch(`${base}/api/webhooks/${id}/deliveries?${new URLSearchParams(
      Object.entries(proof("payflow-webhook-deliveries:v1", id, key)).map(([k, v]) => [k, String(v)]),
    )}`);
  const charge = (mandateId: bigint, tx: string): void => {
    ix.apply({
      name: "charged",
      contractId: "C",
      ledger: 1,
      txHash: tx,
      topics: [mandateId, SUBSCRIBER, merchant],
      data: { amount: 1_000n, fee: 10n, charges_made: 1n, next_charge: 1n },
    } as DecodedEvent);
  };
  const deleteHook = (id: number): Promise<Response> =>
    fetch(`${base}/api/webhooks/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proof("payflow-webhook-delete:v1", id)),
    });

  describe("rotating a signing secret", () => {
    test("returns the new secret once and signs with both secrets during the overlap", async () => {
      const hook = dispatcher.register(merchant, "https://m.example/rotate", "old-secret-0001");
      const before = nowSec();
      const res = await rotate(hook.id);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const rotation = (await res.json()) as WebhookRotation;
      assert.equal(rotation.id, hook.id);
      assert.notEqual(rotation.secret, "old-secret-0001");
      assert.ok(rotation.previousSecretExpiresAt! >= before + OVERLAP_S && rotation.previousSecretExpiresAt! <= nowSec() + OVERLAP_S);
      assert.deepEqual(
        dispatcher.listForMerchant(merchant).find((w) => w.id === hook.id)?.secretLast4,
        rotation.secret.slice(-4),
        "the list shows the new secret's last four",
      );

      calls.length = 0;
      charge(1n, "tx-rotate-overlap");
      await flush();
      const call = calls.find((c) => c.url === "https://m.example/rotate")!;
      const [current, previous, ...rest] = call.headers["payflow-signature"]!.split(", ");
      assert.equal(rest.length, 0, "two signatures, no more");
      assert.equal(current, hmac(rotation.secret, call.body), "the new secret verifies");
      assert.equal(previous, hmac("old-secret-0001", call.body), "the old secret still verifies");
    });

    test("the old secret stops signing once the overlap has passed", async () => {
      const hook = dispatcher.register(merchant, "https://m.example/expired", "old-secret-0002");
      const rotation = (await (await rotate(hook.id)).json()) as WebhookRotation;
      db.prepare("UPDATE webhooks SET previous_secret_expires_at = ? WHERE id = ?").run(nowSec() - 1, hook.id);

      calls.length = 0;
      const result = await dispatcher.ping(merchant, hook.id);
      assert.equal(result?.status, "delivered");
      const call = calls[0]!;
      assert.equal(call.headers["payflow-signature"], hmac(rotation.secret, call.body), "only the new signature");
    });

    test("an overlap of zero retires the old secret at once", async () => {
      const immediate = new WebhookDispatcher({ db, fetchImpl: fetchImpl as typeof fetch, secretOverlapSeconds: 0 });
      const hook = immediate.register(merchant, "https://m.example/leaked", "leaked-secret");
      const rotation = immediate.rotateSecret(merchant, hook.id)!;
      assert.equal(rotation.previousSecretExpiresAt, null);
      const row = db.prepare("SELECT previous_secret FROM webhooks WHERE id = ?").get(hook.id) as { previous_secret: string | null };
      assert.equal(row.previous_secret, null);

      calls.length = 0;
      await immediate.ping(merchant, hook.id);
      assert.equal(calls[0]!.headers["payflow-signature"], hmac(rotation.secret, calls[0]!.body));
    });

    test("needs the merchant's proof, and only rotates the merchant's own live webhook", async () => {
      const hook = dispatcher.register(merchant, "https://m.example/guarded", "guarded-secret");
      assert.equal((await post(`/api/webhooks/${hook.id}/rotate`, { ...proof("payflow-webhook-rotate:v1", hook.id), signature: proof("payflow-webhook-delete:v1", hook.id).signature })).status, 401);
      assert.equal((await post(`/api/webhooks/${hook.id}/rotate`, proof("payflow-webhook-rotate:v1", hook.id, merchantKey, nowSec() - 11 * 60))).status, 401);
      assert.equal((await rotate(hook.id, otherKey)).status, 404, "another merchant's webhook");
      assert.equal((await rotate(999_999)).status, 404);
      assert.equal((await post(`/api/webhooks/abc/rotate`, {})).status, 400);
      const row = db.prepare("SELECT secret FROM webhooks WHERE id = ?").get(hook.id) as { secret: string };
      assert.equal(row.secret, "guarded-secret", "a refused rotation changes nothing");

      assert.equal((await deleteHook(hook.id)).status, 204);
      assert.equal((await rotate(hook.id)).status, 404, "a deleted webhook");
    });
  });

  describe("sending a test event", () => {
    test("delivers a ping signed exactly like a charge and reports status and latency", async () => {
      const hook = dispatcher.register(merchant, "https://m.example/ping", "ping-secret");
      calls.length = 0;
      charge(2n, "tx-before-ping");
      await flush();
      const chargeCall = calls.find((c) => c.url === "https://m.example/ping")!;

      calls.length = 0;
      const res = await ping(hook.id);
      assert.equal(res.status, 200);
      const result = (await res.json()) as WebhookTestResult;
      assert.equal(result.status, "delivered");
      assert.equal(result.statusCode, 200);
      assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
      assert.equal(result.error, null);
      assert.equal(result.nextRetryAt, null);
      assert.ok(result.deliveryId > 0);

      assert.equal(calls.length, 1);
      const call = calls[0]!;
      assert.equal(call.url, "https://m.example/ping");
      assert.deepEqual(Object.keys(call.headers).sort(), Object.keys(chargeCall.headers).sort(), "the same headers as a charge");
      assert.equal(call.headers["content-type"], "application/json");
      assert.equal(call.headers["idempotency-key"]!.length, 36);
      assert.equal(call.headers["payflow-signature"], hmac("ping-secret", call.body));
      assert.deepEqual(JSON.parse(call.body), { event: "ping", webhook_id: hook.id, merchant });
    });

    test("a failing endpoint is reported and retried on the normal path", async () => {
      const hook = dispatcher.register(merchant, "https://m.example/ping-down", "down-secret");
      script.set("https://m.example/ping-down", [503]);
      const before = nowSec();
      const result = (await (await ping(hook.id)).json()) as WebhookTestResult;
      assert.equal(result.status, "pending");
      assert.equal(result.statusCode, 503);
      assert.ok(result.nextRetryAt! >= before + 120 && result.nextRetryAt! <= nowSec() + 120, "first retry in two minutes");
      assert.equal(dispatcher.pendingCount(hook.id), 1);

      db.prepare("UPDATE webhook_deliveries SET retry_at = ? WHERE id = ?").run(before - 1, result.deliveryId);
      const pass = await dispatcher.retryDue(before);
      assert.equal(pass.delivered, 1);
      assert.equal(dispatcher.pendingCount(hook.id), 0);

      script.set("https://m.example/ping-down", ["throw"]);
      const unreachable = (await (await ping(hook.id)).json()) as WebhookTestResult;
      assert.equal(unreachable.statusCode, null);
      assert.equal(unreachable.error, "connect ECONNREFUSED");
    });

    test("needs the merchant's proof and a webhook that is receiving deliveries", async () => {
      const hook = dispatcher.register(merchant, "https://m.example/ping-guarded", "s");
      assert.equal((await ping(hook.id, otherKey)).status, 404);
      assert.equal((await post(`/api/webhooks/${hook.id}/test`, { ...proof("payflow-webhook-test:v1", hook.id), signature: "bm90" })).status, 401);
      assert.equal((await post(`/api/webhooks/${hook.id}/test`, {})).status, 400);
      db.prepare("UPDATE webhooks SET failed = 1 WHERE id = ?").run(hook.id);
      assert.equal((await ping(hook.id)).status, 404, "a webhook that gave up");
    });
  });

  describe("delivery history", () => {
    test("a delivery that failed and then succeeded shows both attempts", async () => {
      const hook = dispatcher.register(merchant, "https://m.example/flaky", "flaky-secret");
      script.set("https://m.example/flaky", [500]);
      const before = nowSec();
      charge(3n, "tx-flaky");
      await flush();
      const pending = db
        .prepare("SELECT id FROM webhook_deliveries WHERE webhook_id = ? AND status = 'pending'")
        .get(hook.id) as { id: number };
      db.prepare("UPDATE webhook_deliveries SET retry_at = ? WHERE id = ?").run(before - 1, pending.id);
      await dispatcher.retryDue(before);

      const res = await history(hook.id);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = (await res.json()) as WebhookDeliveriesResponse;
      assert.equal(body.webhookId, hook.id);
      const [succeeded, failed, ...rest] = body.deliveries;
      assert.equal(rest.length, 0);
      assert.deepEqual(
        { ...succeeded, id: 0, attemptedAt: 0 },
        { id: 0, deliveryId: pending.id, eventId: "charge:tx-flaky", attempt: 2, status: "delivered", statusCode: 200, error: null, nextRetryAt: null, attemptedAt: 0 },
      );
      assert.equal(failed!.deliveryId, pending.id);
      assert.equal(failed!.attempt, 1);
      assert.equal(failed!.status, "pending");
      assert.equal(failed!.statusCode, 500);
      assert.ok(failed!.nextRetryAt! >= before + 120, "the retry it scheduled");
      assert.ok(succeeded!.id > failed!.id, "newest first");
    });

    test("keeps only the newest 100 attempts per webhook", async () => {
      const busy = dispatcher.register(merchant, "https://m.example/busy", "busy");
      const quiet = dispatcher.register(merchant, "https://m.example/quiet", "quiet");
      await dispatcher.ping(merchant, quiet.id);
      const deliveryIds: number[] = [];
      for (let i = 0; i < 105; i += 1) deliveryIds.push((await dispatcher.ping(merchant, busy.id))!.deliveryId);

      const rows = (db.prepare("SELECT COUNT(*) AS n FROM webhook_attempts WHERE webhook_id = ?").get(busy.id) as { n: number }).n;
      assert.equal(rows, 100, "older rows are pruned from the table, not just hidden");
      const kept = dispatcher.history(merchant, busy.id)!;
      assert.equal(kept.length, 100);
      assert.deepEqual(kept.map((d) => d.deliveryId), deliveryIds.slice(5).reverse(), "the newest 100, newest first");
      assert.equal(dispatcher.history(merchant, quiet.id)!.length, 1, "another webhook's history is untouched");
    });

    test("needs the merchant's proof; a deleted webhook keeps its history", async () => {
      const hook = dispatcher.register(merchant, "https://m.example/history", "h");
      await dispatcher.ping(merchant, hook.id);
      assert.equal((await history(hook.id, otherKey)).status, 404, "another merchant's webhook");
      const stale = proof("payflow-webhook-deliveries:v1", hook.id, merchantKey, nowSec() - 11 * 60);
      const expired = await fetch(`${base}/api/webhooks/${hook.id}/deliveries?${new URLSearchParams({ ...stale, timestamp: String(stale.timestamp) })}`);
      assert.equal(expired.status, 401);
      assert.equal((await fetch(`${base}/api/webhooks/${hook.id}/deliveries`)).status, 400);

      assert.equal((await deleteHook(hook.id)).status, 204);
      const res = await history(hook.id);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as WebhookDeliveriesResponse).deliveries.length, 1);
    });
  });
});
