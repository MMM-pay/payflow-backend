import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { WebhookDispatcher, type WebhookAddress } from "../src/lib/webhooks.ts";

const T0 = 1_767_225_600;
const SECRET = "circuit-secret";
const PUBLIC: WebhookAddress[] = [{ address: "93.184.216.34", family: 4 }];


function setup(answers: Array<number | "throw"> = [503]) {
  const db = openDatabase(":memory:");
  const calls: string[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    const answer = answers[Math.min(index++, answers.length - 1)] ?? 503;
    if (answer === "throw") throw new Error("network failure");
    return { status: answer, ok: answer >= 200 && answer < 300, body: { cancel: async () => {} } } as unknown as Response;
  }) as typeof fetch;
  const dispatcher = new WebhookDispatcher({
    db,
    fetchImpl,
    lookupImpl: async () => PUBLIC,
    circuitFailureThreshold: 3,
    circuitCooldownSeconds: 900,
  });
  return { db, dispatcher, calls };
}

describe("per-endpoint webhook circuit breaker (#274)", () => {
  test("success resets an endpoint circuit", async () => {
    const { db, dispatcher, calls } = setup([503, 503, 503, 200]);
    const merchant = Keypair.random().publicKey();
    const hook = await dispatcher.register(merchant, "https://merchant.example/hooks", SECRET);

    for (let i = 0; i < 3; i += 1) {
      const result = await dispatcher.ping(merchant, hook.id);
      assert.ok(result);
      db.prepare("UPDATE webhook_deliveries SET retry_at = ? WHERE id = ?")
        .run(T0 - 1, result.deliveryId);
    }
    const open = db.prepare("SELECT failed, failures, circuit_open_until FROM webhooks WHERE id = ?")
      .get(hook.id) as { failed: number; failures: number; circuit_open_until: number | null };
    assert.equal(open.failed, 1);
    assert.ok(open.circuit_open_until);

    db.prepare("UPDATE webhooks SET circuit_open_until = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 1, hook.id);
    const probe = await dispatcher.ping(merchant, hook.id);
    assert.ok(probe);
    assert.equal(probe.status, "delivered");
    assert.equal(calls.length, 4);
    const closed = db.prepare("SELECT failed, failures, circuit_open_until, circuit_half_open FROM webhooks WHERE id = ?")
      .get(hook.id) as { failed: number; failures: number; circuit_open_until: number | null; circuit_half_open: number };
    assert.equal(closed.failed, 0);
    assert.equal(closed.failures, 0);
    assert.equal(closed.circuit_open_until, null);
    assert.equal(closed.circuit_half_open, 0);
  });

  test("an open circuit pauses delivery and permits only one half-open ping", async () => {
    const { db, dispatcher, calls } = setup([503]);
    const merchant = Keypair.random().publicKey();
    const hook = await dispatcher.register(merchant, "https://merchant.example/open", SECRET);

    const openUntil = Math.floor(Date.now() / 1000) + 900;
    db.prepare("UPDATE webhooks SET failed = 1, failures = 3, circuit_open_until = ?, circuit_half_open = 0 WHERE id = ?")
      .run(openUntil, hook.id);
    assert.equal(await dispatcher.ping(merchant, hook.id), null);
    assert.equal(calls.length, 0);

    db.prepare("UPDATE webhooks SET circuit_open_until = ? WHERE id = ?").run(T0 - 1, hook.id);
    const probe = await dispatcher.ping(merchant, hook.id);
    assert.equal(probe?.status, "pending");
    assert.equal(await dispatcher.ping(merchant, hook.id), null);
    assert.equal(calls.length, 1);
  });

  test("legacy failed webhooks remain paused until migrated with a circuit", async () => {
    const { db, dispatcher } = setup([200]);
    const merchant = Keypair.random().publicKey();
    const hook = await dispatcher.register(merchant, "https://merchant.example/legacy", SECRET);
    db.prepare("UPDATE webhooks SET failed = 1, failures = 5, circuit_open_until = NULL WHERE id = ?").run(hook.id);

    assert.equal(await dispatcher.ping(merchant, hook.id), null);
    assert.deepEqual(await dispatcher.listForMerchant(merchant), [
      {
        id: hook.id,
        merchant,
        url: "https://merchant.example/legacy",
        secretLast4: SECRET.slice(-4),
        failed: true,
        failures: 5,
        lastAttempt: null,
        lastStatus: null,
        paused: false,
        pausedUntil: null,
        circuitState: "half-open",
        createdAt: (await dispatcher.listForMerchant(merchant))[0]!.createdAt,
      },
    ]);
  });

  test("an open circuit is not listed as a healthy delivery target", async () => {
    const { db, dispatcher } = setup([503]);
    const merchant = Keypair.random().publicKey();
    const hook = await dispatcher.register(merchant, "https://merchant.example/paused", SECRET);
    db.prepare("UPDATE webhooks SET failed = 1, circuit_open_until = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000) + 900, hook.id);

    assert.deepEqual(await dispatcher.listWebhooks(merchant), []);
  });
});
