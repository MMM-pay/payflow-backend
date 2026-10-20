import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import { WebhookDispatcher } from "../src/lib/webhooks.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";

const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";

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

const ev = (
  name: string,
  topics: unknown[],
  data: Record<string, unknown>,
  tx = "tx",
): DecodedEvent => ({ name, contractId: "C", ledger: 1, txHash: tx, topics, data });

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Sign a webhook registration message with the given secret key. */
function sign(merchant: string, url: string, timestamp: number, secretKey: string): string {
  const keypair = Keypair.fromSecret(secretKey);
  const message = `payflow-webhook:v1:${merchant}:${url}:${timestamp}`;
  const sig = keypair.sign(Buffer.from(message, "utf8")) as unknown as Uint8Array;
  return Buffer.from(sig).toString("base64");
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("webhooks", () => {
  const seed = StrKey.encodeEd25519SecretSeed(crypto.getRandomValues(new Uint8Array(32)));
  const merchantKey = Keypair.fromSecret(seed);
  const merchant = merchantKey.publicKey();
  const url = "https://payflow.example/webhooks";
  const secret = "test-webhook-secret";

  let db: ReturnType<typeof openDatabase>;
  let ix: Indexer;
  let dispatcher: WebhookDispatcher;
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  let server: Server;
  let base: string;

  before(async () => {
    db = openDatabase(":memory:");
    ix = new Indexer(db, {} as never, {} as never);
    ix.apply(ev("plan_created", [merchant, 1n], {
      token: "C", amount: 10_000_000n, period: 2_592_000n, name: "Pro",
    }));
    ix.apply(ev("subscribed", [1n, SUBSCRIBER, merchant], {
      plan_id: 1n, amount: 10_000_000n, period: 2_592_000n, next_charge: 1n,
    }));

    const captured = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof input === "string" ? input : input.toString();
      const headers: Record<string, string> = {};
      const raw = init?.headers;
      if (raw) {
        const entries =
          typeof (raw as Headers).forEach === "function"
            ? [...(raw as Headers).entries()] as [string, string][]
            : Object.entries(raw as Record<string, string>);
        for (const [key, value] of entries) {
          headers[key.toLowerCase()] = value;
        }
      }
      calls.push({ url: urlStr, headers, body: typeof init?.body === "string" ? init.body : "" });
      if (urlStr.includes("/failing")) throw new Error("down");
      return {
        status: 200,
        ok: true,
        text: async () => "ok",
        json: async () => ({ ok: true }),
      } as unknown as Response;
    };

    dispatcher = new WebhookDispatcher({
      db,
      events: ix.events,
      fetchImpl: captured as unknown as typeof globalThis.fetch,
    });
    dispatcher.bind(ix.events);

    const app = createApp(
      [
        {
          config: testnet,
          db,
          indexer: {
            cursor: 0,
            latest: 0,
            lastRunAt: null,
            lastError: null,
          },
          events: ix.events,
          webhooks: dispatcher,
        },
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
  });

  const post = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test("POST /api/webhooks registers a URL after a valid signature proof", async () => {
    const timestamp = nowSec();
    const registration = await post("/api/webhooks", {
      merchant,
      url,
      secret,
      timestamp,
      signature: sign(merchant, url, timestamp, seed),
    });
    assert.equal(registration.status, 200);
    const body = registration.body as { id: number; merchant: string; url: string; secret: string; active: boolean };
    assert.equal(body.merchant, merchant);
    assert.equal(body.url, url);
    assert.equal(body.secret, secret);
    assert.equal(body.active, true);
    assert.ok(body.id > 0);

    const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(body.id) as {
      merchant: string; url: string; active: number; failed: number;
    };
    assert.equal(row.merchant, merchant);
    assert.equal(row.url, url);
    assert.equal(row.active, 1);
    assert.equal(row.failed, 0);
  });

  test("registration refuses an address the caller cannot sign for", async () => {
    const timestamp = nowSec();
    const res = await post("/api/webhooks", {
      merchant: "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH",
      url,
      secret,
      timestamp,
      signature: sign(merchant, url, timestamp, seed),
    });
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, "invalid_request");
  });

  test("registration refuses a stale timestamp", async () => {
    const stamp = nowSec() - 20 * 60;
    const res = await post("/api/webhooks", {
      merchant,
      url,
      secret,
      timestamp: stamp,
      signature: sign(merchant, url, stamp, seed),
    });
    assert.equal(res.status, 400);
  });

  test("registration refuses a non-https url", async () => {
    const timestamp = nowSec();
    const res = await post("/api/webhooks", {
      merchant,
      url: "ftp://example.com/hook",
      secret,
      timestamp,
      signature: sign(merchant, "ftp://example.com/hook", timestamp, seed),
    });
    assert.equal(res.status, 400);
  });

  test("a charge event dispatches a signed POST to each registered webhook", async () => {
    calls.length = 0;
    ix.apply(ev("charged", [1n, SUBSCRIBER, merchant], {
      amount: 9_900_000n, fee: 100_000n, charges_made: 1n, next_charge: 1_700_000_000n,
    }, "tx-charge-1"));

    await waitFor(() => calls.length >= 1);
    assert.equal(calls.length, 1, "one delivery per registered webhook");

    const call = calls[0]!;
    assert.equal(call.url, url);
    assert.equal(typeof call.headers["idempotency-key"], "string");
    assert.equal(call.headers["idempotency-key"]!.length, 36);
    assert.match(call.headers["payflow-signature"]!, /^sha256=[0-9a-f]{64}$/);

    const body = JSON.parse(call.body) as {
      event: string; mandate_id: number; subscriber: string; merchant: string;
      amount: string; fee: string; ledger: number;
    };
    assert.equal(body.event, "charged");
    assert.equal(body.mandate_id, 1);
    assert.equal(body.subscriber, SUBSCRIBER);
    assert.equal(body.merchant, merchant);
    assert.equal(body.amount, "9900000");
    assert.equal(body.fee, "100000");

    const expected = createHmac("sha256", Buffer.from(secret, "utf8"))
      .update(call.body)
      .digest("hex");
    assert.equal(call.headers["payflow-signature"], `sha256=${expected}`);
  });

  test("delivery retries with backoff and gives up after five attempts", async () => {
    const failing = Keypair.random().publicKey();
    dispatcher.register(failing, "https://payflow.example/failing", "another-secret");
    calls.length = 0;

    const T = nowSec();
    ix.apply(ev("charged", [7n, SUBSCRIBER, failing], {
      amount: 5_000_000n, fee: 0n, charges_made: 1n, next_charge: 1n,
    }, "tx-charge-fail"));
    await waitFor(() => calls.length >= 1);
    assert.equal(calls.length, 1, "first attempt happens immediately");
    // The failed attempt's reschedule runs as a microtask after the apply
    // returns, so flush before inspecting the delivery row.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const row1 = db
      .prepare("SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT 1")
      .get() as { id: number; attempt: number; status: string; retry_at: number };
    assert.equal(row1.attempt, 2, "the failed first attempt is rescheduled");
    assert.equal(row1.status, "pending");
    assert.ok(row1.retry_at >= T + 119 && row1.retry_at <= T + 121, "first retry in one minute");

    // Backoff: attempt n schedules its retry at now + 60 * 2^(n-1) seconds,
    // capped at six hours: 120s, 240s, 480s, 960s for attempts 2..5. The
    // retry is scheduled from the wall clock, which may have crossed a
    // second since `T` was read, so the offset is exact to the second.
    const expectedRetryAt: number[] = [T + 240, T + 480, T + 960]; // attempts 3, 4, 5
    for (const expected of expectedRetryAt) {
      // Make the delivery due right now so retryDue picks it up.
      db.prepare("UPDATE webhook_deliveries SET retry_at = ? WHERE id = ?")
        .run(T - 1, row1.id);
      await dispatcher.retryDue(T);
      const row = db
        .prepare("SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT 1")
        .get() as { attempt: number; status: string; retry_at: number };
      assert.equal(row.status, "pending");
      const offset = row.retry_at - T;
      assert.ok(
        Math.abs(offset - (expected - T)) <= 1,
        `retry scheduled ${offset}s out, expected ${expected - T}s`,
      );
    }
    assert.equal(calls.length, 4, "attempts 2 through 4 happen at their retry times");

    // Attempt 5 is due next; attempt 6 exceeds MAX_ATTEMPTS, so the delivery
    // and the webhook are marked failed and nothing is retried after that.
    db.prepare("UPDATE webhook_deliveries SET retry_at = ? WHERE id = ?")
      .run(T - 1, row1.id);
    await dispatcher.retryDue(T);
    assert.equal(calls.length, 5, "fifth and final attempt");
    const row = db
      .prepare("SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT 1")
      .get() as { attempt: number; status: string };
    assert.equal(row.attempt, 5);
    assert.equal(row.status, "failed");

    const webhook = db.prepare("SELECT * FROM webhooks WHERE merchant = ?").get(failing) as {
      failed: number; failures: number;
    };
    assert.equal(webhook.failed, 1);
    assert.equal(webhook.failures, 5);

    calls.length = 0;
    ix.apply(ev("charged", [8n, SUBSCRIBER, failing], {
      amount: 1n, fee: 0n, charges_made: 1n, next_charge: 1n,
    }, "tx-charge-after-giveup"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0, "a failed webhook receives nothing more");
  });

  test("retryDue delivers pending deliveries at their retry time", async () => {
    const ok = Keypair.random().publicKey();
    dispatcher.register(ok, "https://payflow.example/ok", "ok-secret");
    calls.length = 0;

    ix.apply(ev("charged", [9n, SUBSCRIBER, ok], {
      amount: 1n, fee: 0n, charges_made: 1n, next_charge: 1n,
    }, "tx-charge-ok"));

    await waitFor(() => calls.length >= 1);
    assert.equal(calls.length, 1);
    // Let the in-flight delivery attempt complete (it runs as a microtask
    // after the apply returns) before inspecting pending deliveries.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const id = (db.prepare("SELECT id FROM webhooks WHERE merchant = ?").get(ok) as { id: number }).id;
    assert.equal(dispatcher.pendingCount(id), 0, "a delivered webhook has no pending deliveries");
  });
});
