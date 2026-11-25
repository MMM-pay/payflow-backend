import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test, before, after, type TestContext } from "node:test";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { WebhookDispatcher, type WebhookAddress, type WebhookLookup } from "../src/lib/webhooks.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import type { WebhookDeliveriesResponse } from "../src/routes/types.ts";

/**
 * Issue #275: a webhook delivery to an endpoint that keeps failing is retried
 * on a fixed exponential schedule, then dead-lettered: the delivery is marked
 * `failed`, the webhook stops receiving events, and the history shows every
 * attempt.
 *
 * Every test is deterministic. `Date` is frozen with `t.mock.timers` and moved
 * explicitly, so each retry time is checked to the exact second. The endpoint
 * is an in-memory fake that never touches the network, and DNS answers come
 * from a stub lookup.
 */

/** A fixed start time: 2026-01-01T00:00:00Z. */
const T0 = 1_767_225_600;
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const SECRET = "dead-letter-secret";

/** Delay after attempt n fails, for n = 1..4: 60 * 2^n seconds. Attempt 5 is the last. */
const BACKOFF_S = [120, 240, 480, 960] as const;
const MAX_ATTEMPTS = 5;

type Answer = number | "throw";

interface Call {
  /** Unix seconds on the frozen clock when the POST was made. */
  at: number;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const PUBLIC: WebhookAddress[] = [{ address: "93.184.216.34", family: 4 }];

/**
 * An in-memory webhook receiver. Each URL answers from its own script, in
 * order: a status code, or "throw" for a network error. When a script runs
 * out it repeats its last answer. A URL with no script returns 200.
 */
function fakeEndpoint(scripts: Record<string, Answer[]>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    calls.push({ at: Math.floor(Date.now() / 1000), url, headers, body: String(init?.body ?? "") });
    const script = scripts[url];
    const answer: Answer = script === undefined ? 200 : script.length > 1 ? script.shift()! : script[0]!;
    if (answer === "throw") throw new Error("connect ECONNREFUSED");
    return { status: answer, ok: answer >= 200 && answer < 300, text: async () => `status ${answer}` } as unknown as Response;
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

function charged(merchant: string, mandateId: bigint, tx: string): DecodedEvent {
  return {
    name: "charged",
    contractId: "C",
    ledger: 1,
    txHash: tx,
    topics: [mandateId, SUBSCRIBER, merchant],
    data: { amount: 1_000n, fee: 10n, charges_made: 1n, next_charge: 1n },
  } as DecodedEvent;
}

const hmac = (body: string): string =>
  `sha256=${createHmac("sha256", Buffer.from(SECRET, "utf8")).update(body).digest("hex")}`;

/** Freeze `Date` at T0 for the duration of the test. */
function freezeClock(t: TestContext): (unixSeconds: number) => void {
  t.mock.timers.enable({ apis: ["Date"], now: T0 * 1000 });
  return (unixSeconds) => t.mock.timers.setTime(unixSeconds * 1000);
}

interface DeliveryRow {
  id: number;
  attempt: number;
  status: string;
  http_status: number | null;
  error: string | null;
  retry_at: number;
}
interface WebhookRow { failed: number; failures: number; last_attempt: number | null; last_status: number | null }

function setup(scripts: Record<string, Answer[]>, lookupImpl: WebhookLookup = async () => PUBLIC) {
  const db = openDatabase(":memory:");
  const endpoint = fakeEndpoint(scripts);
  const dispatcher = new WebhookDispatcher({ db, fetchImpl: endpoint.fetchImpl, lookupImpl });
  const delivery = (webhookId: number): DeliveryRow =>
    db.prepare("SELECT id, attempt, status, http_status, error, retry_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 1")
      .get(webhookId) as unknown as DeliveryRow;
  const webhook = (webhookId: number): WebhookRow =>
    db.prepare("SELECT failed, failures, last_attempt, last_status FROM webhooks WHERE id = ?")
      .get(webhookId) as unknown as WebhookRow;
  return { db, dispatcher, calls: endpoint.calls, delivery, webhook };
}

/**
 * Run a delivery through all of its retries, moving the frozen clock to each
 * scheduled retry time. Returns the time of every attempt.
 */
async function exhaust(
  dispatcher: WebhookDispatcher,
  delivery: () => DeliveryRow,
  setTime: (s: number) => void,
): Promise<number[]> {
  const times = [T0];
  while (delivery().status === "pending") {
    const due = delivery().retry_at;
    setTime(due);
    await dispatcher.retryDue();
    times.push(due);
  }
  return times;
}

describe("webhook retry schedule and dead-lettering (#275)", () => {
  test("a persistently failing endpoint is retried on an exact backoff schedule, then dead-lettered", async (t) => {
    const setTime = freezeClock(t);
    const merchant = Keypair.random().publicKey();
    const url = "https://merchant.example/hooks/down";
    const { dispatcher, calls, delivery, webhook, db } = setup({ [url]: [503] });
    const hook = await dispatcher.register(merchant, url, SECRET);

    // Attempt 1 happens immediately when the event is applied.
    await dispatcher.onApplied(charged(merchant, 1n, "tx-down"));
    assert.equal(calls.length, 1);
    assert.deepEqual(
      { attempt: delivery(hook.id).attempt, status: delivery(hook.id).status, retry_at: delivery(hook.id).retry_at },
      { attempt: 2, status: "pending", retry_at: T0 + BACKOFF_S[0] },
    );

    let now = T0;
    for (const [i, delay] of BACKOFF_S.entries()) {
      const attempt = i + 2;
      const due = now + delay;
      assert.equal(delivery(hook.id).retry_at, due, `attempt ${attempt} is scheduled ${delay}s after attempt ${attempt - 1}`);

      // One second early, nothing is due and the endpoint is not called.
      setTime(due - 1);
      assert.deepEqual(await dispatcher.retryDue(), { attempted: 0, delivered: 0, failed: 0 });
      assert.equal(calls.length, attempt - 1, `attempt ${attempt} does not run before its retry time`);

      // At exactly the retry time it is due and runs once.
      setTime(due);
      const pass = await dispatcher.retryDue();
      assert.equal(calls.length, attempt);
      assert.equal(calls.at(-1)!.at, due);
      now = due;

      if (attempt < MAX_ATTEMPTS) {
        assert.deepEqual(pass, { attempted: 1, delivered: 0, failed: 0 });
        assert.equal(delivery(hook.id).attempt, attempt + 1);
        assert.equal(delivery(hook.id).status, "pending");
      } else {
        assert.deepEqual(pass, { attempted: 1, delivered: 0, failed: 1 }, "the fifth failure dead-letters the delivery");
      }
    }

    // The attempts ran at T0 plus the cumulative backoff: 0, 120, 360, 840 and 1800 seconds.
    assert.deepEqual(calls.map((c) => c.at - T0), [0, 120, 360, 840, 1800]);

    // Final dead-letter state.
    // retry_at keeps the time the final attempt was due; nothing reads it once failed.
    assert.deepEqual({ ...delivery(hook.id) }, {
      id: delivery(hook.id).id,
      attempt: MAX_ATTEMPTS,
      status: "failed",
      http_status: 503,
      error: "delivery failed",
      retry_at: T0 + 1800,
    });
    assert.deepEqual({ ...webhook(hook.id) }, { failed: 1, failures: MAX_ATTEMPTS, last_attempt: T0 + 1800, last_status: 503 });
    assert.equal(await dispatcher.pendingCount(hook.id), 0);

    // Every attempt carries the same idempotency key and a valid signature.
    assert.equal(new Set(calls.map((c) => c.headers["idempotency-key"])).size, 1);
    for (const call of calls) assert.equal(call.headers["payflow-signature"], hmac(call.body));

    // The history records each attempt, newest first, and its scheduled next retry.
    const history = await dispatcher.history(merchant, hook.id);
    assert.deepEqual(
      history!.map(({ attempt, status, statusCode, nextRetryAt, attemptedAt }) =>
        ({ attempt, status, statusCode, nextRetryAt, attemptedAt })),
      [
        { attempt: 5, status: "failed", statusCode: 503, nextRetryAt: null, attemptedAt: T0 + 1800 },
        { attempt: 4, status: "pending", statusCode: 503, nextRetryAt: T0 + 1800, attemptedAt: T0 + 840 },
        { attempt: 3, status: "pending", statusCode: 503, nextRetryAt: T0 + 840, attemptedAt: T0 + 360 },
        { attempt: 2, status: "pending", statusCode: 503, nextRetryAt: T0 + 360, attemptedAt: T0 + 120 },
        { attempt: 1, status: "pending", statusCode: 503, nextRetryAt: T0 + 120, attemptedAt: T0 },
      ],
    );
    db.close();
  });

  test("a dead-lettered webhook is never retried and receives no new events", async (t) => {
    const setTime = freezeClock(t);
    const merchant = Keypair.random().publicKey();
    const url = "https://merchant.example/hooks/gone";
    const { dispatcher, calls, delivery, db } = setup({ [url]: [500] });
    const hook = await dispatcher.register(merchant, url, SECRET);
    await dispatcher.onApplied(charged(merchant, 2n, "tx-gone"));
    await exhaust(dispatcher, () => delivery(hook.id), setTime);
    assert.equal(calls.length, MAX_ATTEMPTS);
    calls.length = 0;

    // A week later the retry loop finds nothing to do.
    setTime(T0 + 7 * 24 * 60 * 60);
    assert.deepEqual(await dispatcher.dueDeliveries(), []);
    assert.deepEqual(await dispatcher.retryDue(), { attempted: 0, delivered: 0, failed: 0 });

    // A new charge creates no delivery and makes no request.
    await dispatcher.onApplied(charged(merchant, 3n, "tx-after"));
    assert.equal(calls.length, 0);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ?").get(hook.id) as { n: number };
    assert.equal(rows.n, 1, "only the dead-lettered delivery exists");

    // A ping is refused, but the merchant can still see the webhook flagged as failed.
    assert.equal(await dispatcher.ping(merchant, hook.id), null);
    const [summary] = await dispatcher.listForMerchant(merchant);
    assert.equal(summary!.id, hook.id);
    assert.equal(summary!.failed, true);
    db.close();
  });

  // Each failure mode reaches the same dead-letter state, and the history
  // records the cause.
  const failureModes: Array<{
    name: string;
    answer: Answer;
    lookup?: (host: string) => Promise<WebhookAddress[]>;
    statusCode: number | null;
    error: string | RegExp;
  }> = [
    { name: "5xx response", answer: 500, statusCode: 500, error: "delivery failed" },
    { name: "4xx response", answer: 410, statusCode: 410, error: "delivery failed" },
    { name: "redirect (not followed)", answer: 302, statusCode: 302, error: "delivery failed" },
    { name: "network error", answer: "throw", statusCode: null, error: "connect ECONNREFUSED" },
    {
      name: "host re-resolving to a private address",
      answer: 200,
      lookup: async () => [{ address: "10.0.0.7", family: 4 }],
      statusCode: null,
      error: "webhook URL must resolve only to public addresses",
    },
  ];
  for (const mode of failureModes) {
    test(`a ${mode.name} on every attempt is dead-lettered after ${MAX_ATTEMPTS} attempts`, async (t) => {
      const setTime = freezeClock(t);
      const merchant = Keypair.random().publicKey();
      const url = "https://merchant.example/hooks/mode";
      // The webhook registers while the host resolves publicly; the lookup is
      // swapped only for the delivery attempts (a DNS-rebinding style change).
      let lookup: (host: string) => Promise<WebhookAddress[]> = async () => PUBLIC;
      const { dispatcher, calls, delivery, webhook, db } = setup({ [url]: [mode.answer] }, (host) => lookup(host));
      const hook = await dispatcher.register(merchant, url, SECRET);
      if (mode.lookup) lookup = mode.lookup;

      await dispatcher.onApplied(charged(merchant, 4n, "tx-mode"));
      const times = await exhaust(dispatcher, () => delivery(hook.id), setTime);
      assert.deepEqual(times.map((s) => s - T0), [0, 120, 360, 840, 1800]);
      assert.equal(calls.length, mode.lookup ? 0 : MAX_ATTEMPTS, "a private target is never contacted");

      const final = delivery(hook.id);
      assert.equal(final.status, "failed");
      assert.equal(final.attempt, MAX_ATTEMPTS);
      assert.equal(final.http_status, mode.statusCode);
      if (typeof mode.error === "string") assert.equal(final.error, mode.error);
      else assert.match(final.error ?? "", mode.error);
      assert.equal(webhook(hook.id).failed, 1);

      const history = (await dispatcher.history(merchant, hook.id))!;
      assert.equal(history.length, MAX_ATTEMPTS);
      for (const row of history) assert.equal(row.statusCode, mode.statusCode);
      db.close();
    });
  }

  test("a success on the last allowed attempt delivers and does not dead-letter", async (t) => {
    const setTime = freezeClock(t);
    const merchant = Keypair.random().publicKey();
    const url = "https://merchant.example/hooks/flaky";
    const { dispatcher, calls, delivery, webhook, db } = setup({ [url]: [503, "throw", 500, 502, 200] });
    const hook = await dispatcher.register(merchant, url, SECRET);

    await dispatcher.onApplied(charged(merchant, 5n, "tx-flaky"));
    await exhaust(dispatcher, () => delivery(hook.id), setTime);

    assert.equal(calls.length, MAX_ATTEMPTS);
    assert.deepEqual(
      { attempt: delivery(hook.id).attempt, status: delivery(hook.id).status, http_status: delivery(hook.id).http_status },
      { attempt: MAX_ATTEMPTS, status: "delivered", http_status: 200 },
    );
    assert.equal(delivery(hook.id).error, null, "a delivered row clears the previous error");
    assert.equal(webhook(hook.id).failed, 0, "the webhook keeps receiving events");
    assert.equal(webhook(hook.id).failures, 4, "the four failures are still counted");

    // It still gets new events.
    calls.length = 0;
    await dispatcher.onApplied(charged(merchant, 6n, "tx-flaky-next"));
    assert.equal(calls.length, 1);
    db.close();
  });

  test("a dead-lettered webhook does not affect a healthy webhook for the same merchant", async (t) => {
    const setTime = freezeClock(t);
    const merchant = Keypair.random().publicKey();
    const down = "https://merchant.example/hooks/down";
    const up = "https://merchant.example/hooks/up";
    const { dispatcher, calls, delivery, webhook, db } = setup({ [down]: [503], [up]: [200] });
    const bad = await dispatcher.register(merchant, down, SECRET);
    const good = await dispatcher.register(merchant, up, SECRET);

    await dispatcher.onApplied(charged(merchant, 7n, "tx-pair"));
    assert.equal(delivery(good.id).status, "delivered");
    await exhaust(dispatcher, () => delivery(bad.id), setTime);

    assert.equal(calls.filter((c) => c.url === up).length, 1, "the healthy webhook is not retried");
    assert.equal(calls.filter((c) => c.url === down).length, MAX_ATTEMPTS);
    assert.equal(webhook(bad.id).failed, 1);
    assert.equal(webhook(good.id).failed, 0);

    calls.length = 0;
    await dispatcher.onApplied(charged(merchant, 8n, "tx-pair-next"));
    assert.deepEqual(calls.map((c) => c.url), [up], "only the healthy webhook receives the next event");
    db.close();
  });

  test("deleting a webhook mid-retry closes its pending delivery instead of dead-lettering the webhook", async (t) => {
    const setTime = freezeClock(t);
    const merchant = Keypair.random().publicKey();
    const url = "https://merchant.example/hooks/deleted";
    const { dispatcher, calls, delivery, webhook, db } = setup({ [url]: [503] });
    const hook = await dispatcher.register(merchant, url, SECRET);

    await dispatcher.onApplied(charged(merchant, 9n, "tx-deleted"));
    setTime(T0 + 120);
    await dispatcher.retryDue();
    assert.equal(calls.length, 2);

    assert.equal(await dispatcher.deactivate(merchant, hook.id), true);
    assert.deepEqual(
      { status: delivery(hook.id).status, error: delivery(hook.id).error },
      { status: "failed", error: "webhook deleted" },
    );
    setTime(T0 + 24 * 60 * 60);
    assert.deepEqual(await dispatcher.retryDue(), { attempted: 0, delivered: 0, failed: 0 });
    assert.equal(calls.length, 2, "no attempt after deletion");
    assert.equal(webhook(hook.id).failed, 0, "deletion is not a delivery failure");
    db.close();
  });

  test("the same event applied twice during retries does not start a second schedule", async (t) => {
    const setTime = freezeClock(t);
    const merchant = Keypair.random().publicKey();
    const url = "https://merchant.example/hooks/dupe";
    const { dispatcher, calls, delivery, db } = setup({ [url]: [503] });
    const hook = await dispatcher.register(merchant, url, SECRET);

    await dispatcher.onApplied(charged(merchant, 10n, "tx-dupe"));
    setTime(T0 + 60);
    await dispatcher.onApplied(charged(merchant, 10n, "tx-dupe"));
    assert.equal(calls.length, 1, "the replayed event is not delivered again");
    assert.equal(delivery(hook.id).retry_at, T0 + 120, "the original schedule is unchanged");

    await exhaust(dispatcher, () => delivery(hook.id), setTime);
    assert.equal(calls.length, MAX_ATTEMPTS);
    const n = db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ?").get(hook.id) as { n: number };
    assert.equal(n.n, 1);
    db.close();
  });
});

/** The dead-letter state through the REST API, including its auth paths. */
describe("dead-lettered delivery history over the API (#275)", () => {
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
  const merchantKey = Keypair.random();
  const merchant = merchantKey.publicKey();
  const otherKey = Keypair.random();
  const url = "https://merchant.example/hooks/api";
  const ctx = setup({ [url]: [503] });
  let http: Server;
  let base = "";
  let hookId = 0;

  const nowSec = (): number => Math.floor(Date.now() / 1000);
  const PREFIX = "payflow-webhook-deliveries:v1";
  const query = (id: number, claimed: string, signer: Keypair, timestamp = nowSec()): string =>
    new URLSearchParams({
      merchant: claimed,
      timestamp: String(timestamp),
      signature: Buffer.from(signer.sign(Buffer.from(`${PREFIX}:${claimed}:${id}:${timestamp}`))).toString("base64"),
    }).toString();
  const history = (q: string, id = hookId): Promise<Response> => fetch(`${base}/api/webhooks/${id}/deliveries?${q}`);

  before(async () => {
    const hook = await ctx.dispatcher.register(merchant, url, SECRET);
    hookId = hook.id;
    // Drive the delivery to dead-letter without waiting on the wall clock:
    // move each retry_at into the past rather than sleeping.
    await ctx.dispatcher.onApplied(charged(merchant, 11n, "tx-api"));
    while (ctx.delivery(hookId).status === "pending") {
      ctx.db.prepare("UPDATE webhook_deliveries SET retry_at = 0 WHERE id = ?").run(ctx.delivery(hookId).id);
      await ctx.dispatcher.retryDue();
    }
    const app = createApp([{ config: testnet, db: ctx.db, webhooks: ctx.dispatcher }], config);
    await new Promise<void>((resolve) => {
      http = app.listen(0, "127.0.0.1", () => {
        const addr = http.address();
        base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    http.close();
    ctx.db.close();
  });

  test("the owner sees all five attempts ending in failed", async () => {
    const res = await history(query(hookId, merchant, merchantKey));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json() as WebhookDeliveriesResponse;
    assert.equal(body.webhookId, hookId);
    assert.deepEqual(body.deliveries.map((d) => [d.attempt, d.status, d.statusCode]), [
      [5, "failed", 503],
      [4, "pending", 503],
      [3, "pending", 503],
      [2, "pending", 503],
      [1, "pending", 503],
    ]);
    assert.equal(body.deliveries[0]!.nextRetryAt, null, "nothing is scheduled after the dead-letter");
    assert.equal(body.deliveries[0]!.error, "delivery failed");
  });

  test("a signature by another key is a 401", async () => {
    const res = await history(query(hookId, merchant, otherKey));
    assert.equal(res.status, 401);
  });

  test("a stale proof is a 401", async () => {
    const res = await history(query(hookId, merchant, merchantKey, nowSec() - 24 * 60 * 60));
    assert.equal(res.status, 401);
  });

  test("a missing proof is a 400", async () => {
    const res = await history("");
    assert.equal(res.status, 400);
  });

  test("another merchant cannot read the history (404, not a leak)", async () => {
    const res = await history(query(hookId, otherKey.publicKey(), otherKey));
    assert.equal(res.status, 404);
  });

  test("an unknown webhook id is a 404", async () => {
    const res = await history(query(hookId + 999, merchant, merchantKey), hookId + 999);
    assert.equal(res.status, 404);
  });

  test("a test ping to the dead-lettered webhook is a 404", async () => {
    const timestamp = nowSec();
    const res = await fetch(`${base}/api/webhooks/${hookId}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchant,
        timestamp,
        signature: Buffer.from(merchantKey.sign(Buffer.from(`payflow-webhook-test:v1:${merchant}:${hookId}:${timestamp}`))).toString("base64"),
      }),
    });
    assert.equal(res.status, 404);
  });
});
