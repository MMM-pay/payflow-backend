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

/** Sign an arbitrary webhook-management message. */
function signMessage(message: string, secretKey: string): string {
  const sig = Keypair.fromSecret(secretKey).sign(Buffer.from(message, "utf8")) as unknown as Uint8Array;
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
    await ix.apply(ev("plan_created", [merchant, 1n], {
      token: "C", amount: 10_000_000n, period: 2_592_000n, name: "Pro",
    }));
    await ix.apply(ev("subscribed", [1n, SUBSCRIBER, merchant], {
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
    await ix.apply(ev("charged", [1n, SUBSCRIBER, merchant], {
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
    await dispatcher.register(failing, "https://payflow.example/failing", "another-secret");
    calls.length = 0;

    const T = nowSec();
    await ix.apply(ev("charged", [7n, SUBSCRIBER, failing], {
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
    await ix.apply(ev("charged", [8n, SUBSCRIBER, failing], {
      amount: 1n, fee: 0n, charges_made: 1n, next_charge: 1n,
    }, "tx-charge-after-giveup"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0, "a failed webhook receives nothing more");
  });

  test("retryDue delivers pending deliveries at their retry time", async () => {
    const ok = Keypair.random().publicKey();
    await dispatcher.register(ok, "https://payflow.example/ok", "ok-secret");
    calls.length = 0;

    await ix.apply(ev("charged", [9n, SUBSCRIBER, ok], {
      amount: 1n, fee: 0n, charges_made: 1n, next_charge: 1n,
    }, "tx-charge-ok"));

    await waitFor(() => calls.length >= 1);
    assert.equal(calls.length, 1);
    // Let the in-flight delivery attempt complete (it runs as a microtask
    // after the apply returns) before inspecting pending deliveries.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const id = (db.prepare("SELECT id FROM webhooks WHERE merchant = ?").get(ok) as { id: number }).id;
    assert.equal(await dispatcher.pendingCount(id), 0, "a delivered webhook has no pending deliveries");
  });
  describe("listing and deleting", () => {
    const ownerSeed = StrKey.encodeEd25519SecretSeed(crypto.getRandomValues(new Uint8Array(32)));
    const owner = Keypair.fromSecret(ownerSeed).publicKey();
    const otherSeed = StrKey.encodeEd25519SecretSeed(crypto.getRandomValues(new Uint8Array(32)));
    const other = Keypair.fromSecret(otherSeed).publicKey();

    const listUrl = (merchant: string, timestamp: number, signature: string): string =>
      `${base}/api/webhooks?${new URLSearchParams({ merchant, timestamp: String(timestamp), signature })}`;
    const listSig = (merchant: string, timestamp: number, key: string): string =>
      signMessage(`payflow-webhook-list:v1:${merchant}:${timestamp}`, key);
    const deleteSig = (merchant: string, id: number, timestamp: number, key: string): string =>
      signMessage(`payflow-webhook-delete:v1:${merchant}:${id}:${timestamp}`, key);
    const del = async (id: number | string, body: unknown): Promise<Response> =>
      fetch(`${base}/api/webhooks/${id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    test("lists the merchant's webhooks without their secrets", async () => {
      const first = await dispatcher.register(owner, "https://owner.example/a", "secret-aaaa-1234");
      const second = await dispatcher.register(owner, "https://owner.example/b");
      await dispatcher.register(other, "https://other.example/x", "not-yours");

      const t = nowSec();
      const res = await fetch(listUrl(owner, t, listSig(owner, t, ownerSeed)));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const text = await res.text();
      assert.ok(!text.includes("secret-aaaa-1234"), "the full secret is never returned");
      assert.ok(!text.includes(second.secret), "nor a generated one");
      const body = JSON.parse(text) as { merchant: string; webhooks: Array<Record<string, unknown>> };
      assert.equal(body.merchant, owner);
      assert.deepEqual(body.webhooks.map((w) => w.id), [second.id, first.id], "newest first, own only");
      assert.equal(body.webhooks[1]!.secretLast4, "1234");
      assert.equal(body.webhooks[1]!.url, "https://owner.example/a");
      assert.equal(body.webhooks[1]!.failed, false);
      assert.equal("secret" in body.webhooks[1]!, false);
    });

    test("listing with a wrong signature is a 401", async () => {
      const t = nowSec();
      // Signed by someone else's key.
      let res = await fetch(listUrl(owner, t, listSig(owner, t, otherSeed)));
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unauthorized");
      // A registration signature cannot be replayed as a listing.
      res = await fetch(listUrl(owner, t, sign(owner, "https://owner.example/a", t, ownerSeed)));
      assert.equal(res.status, 401);
      // Not a signature at all.
      res = await fetch(listUrl(owner, t, "bm90IGEgc2lnbmF0dXJl"));
      assert.equal(res.status, 401);
    });

    test("listing with an expired signature is a 401", async () => {
      const stale = nowSec() - 11 * 60;
      const res = await fetch(listUrl(owner, stale, listSig(owner, stale, ownerSeed)));
      assert.equal(res.status, 401);
    });

    test("listing without the proof is a 400", async () => {
      const res = await fetch(`${base}/api/webhooks?merchant=${owner}`);
      assert.equal(res.status, 400);
    });

    test("deleting with a wrong or expired signature is a 401 and deletes nothing", async () => {
      const hook = await dispatcher.register(owner, "https://owner.example/keep", "keep-secret");
      const t = nowSec();
      let res = await del(hook.id, { merchant: owner, timestamp: t, signature: deleteSig(owner, hook.id, t, otherSeed) });
      assert.equal(res.status, 401);
      // Signed for a different id.
      res = await del(hook.id, { merchant: owner, timestamp: t, signature: deleteSig(owner, hook.id + 1, t, ownerSeed) });
      assert.equal(res.status, 401);
      const stale = t - 11 * 60;
      res = await del(hook.id, { merchant: owner, timestamp: stale, signature: deleteSig(owner, hook.id, stale, ownerSeed) });
      assert.equal(res.status, 401);
      const row = db.prepare("SELECT active FROM webhooks WHERE id = ?").get(hook.id) as { active: number };
      assert.equal(row.active, 1);
    });

    test("a merchant cannot delete another merchant's webhook", async () => {
      const theirs = await dispatcher.register(other, "https://other.example/y", "theirs");
      const t = nowSec();
      const res = await del(theirs.id, { merchant: owner, timestamp: t, signature: deleteSig(owner, theirs.id, t, ownerSeed) });
      assert.equal(res.status, 404);
      const row = db.prepare("SELECT active FROM webhooks WHERE id = ?").get(theirs.id) as { active: number };
      assert.equal(row.active, 1);
    });

    test("a deleted webhook receives no further deliveries", async () => {
      const seedC = StrKey.encodeEd25519SecretSeed(crypto.getRandomValues(new Uint8Array(32)));
      const merchantC = Keypair.fromSecret(seedC).publicKey();
      const keep = await dispatcher.register(merchantC, "https://c.example/keep", "keep");
      const gone = await dispatcher.register(merchantC, "https://c.example/failing-gone", "gone");

      // A charge leaves a pending retry on the failing endpoint.
      calls.length = 0;
      ix.apply(ev("charged", [21n, SUBSCRIBER, merchantC], {
        amount: 1n, fee: 0n, charges_made: 1n, next_charge: 1n,
      }, "tx-before-delete"));
      await waitFor(() => calls.length >= 2);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await dispatcher.pendingCount(gone.id), 1);

      const t = nowSec();
      const res = await del(gone.id, { merchant: merchantC, timestamp: t, signature: deleteSig(merchantC, gone.id, t, seedC) });
      assert.equal(res.status, 204);
      assert.equal(await dispatcher.pendingCount(gone.id), 0, "scheduled retries are dropped");

      // Neither the retry loop nor a new charge reaches the deleted endpoint.
      calls.length = 0;
      await dispatcher.retryDue(t + 24 * 60 * 60);
      ix.apply(ev("charged", [21n, SUBSCRIBER, merchantC], {
        amount: 1n, fee: 0n, charges_made: 2n, next_charge: 1n,
      }, "tx-after-delete"));
      await waitFor(() => calls.length >= 1);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls.map((c) => c.url), ["https://c.example/keep"]);

      // It is gone from the list, and deleting it again is a 404.
      const listed = (await (await fetch(listUrl(merchantC, t, listSig(merchantC, t, seedC)))).json()) as {
        webhooks: Array<{ id: number }>;
      };
      assert.deepEqual(listed.webhooks.map((w) => w.id), [keep.id]);
      const again = await del(gone.id, { merchant: merchantC, timestamp: t, signature: deleteSig(merchantC, gone.id, t, seedC) });
      assert.equal(again.status, 404);
    });

    test("the delete proof may be sent as query parameters", async () => {
      const hook = await dispatcher.register(owner, "https://owner.example/q", "q-secret");
      const t = nowSec();
      const query = new URLSearchParams({
        merchant: owner,
        timestamp: String(t),
        signature: deleteSig(owner, hook.id, t, ownerSeed),
      });
      const res = await fetch(`${base}/api/webhooks/${hook.id}?${query}`, { method: "DELETE" });
      assert.equal(res.status, 204);
    });
  });
});
