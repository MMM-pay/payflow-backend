import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Server } from "node:http";
import { nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { createApp } from "../src/app.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import { openDatabase, writeCursor } from "../src/lib/db.ts";
import { Indexer, type IndexerRpc } from "../src/indexer.ts";
import { WebhookDispatcher } from "../src/lib/webhooks.ts";
import { metrics } from "../src/lib/metrics.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";

/**
 * Duplicate event delivery never double-counts.
 *
 * An RPC can hand the same event to two overlapping windows, and a crash
 * before the cursor commits replays the window it was applying. The second
 * delivery must leave every counter and projection exactly as the first one
 * left it: the stored event, the subscriber count, the charge log, the churn
 * log, the applied metric and the webhook deliveries.
 *
 * Everything here is in-memory and driven by a fake RPC, so the tests never
 * touch the network.
 */

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function net(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    name: "testnet",
    rpcUrl: "https://rpc.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    planRegistryId: CONTRACT,
    vaultId: CONTRACT,
    subscriptionId: CONTRACT,
    startLedger: 100,
    databasePath: ":memory:",
    ...overrides,
  };
}

const CLOSED_AT = new Date(1_700_000_100_000).toISOString();

function rawPlanCreated(ledger: number): rpc.Api.EventResponse {
  return {
    ledger,
    txHash: "tx-plan-1",
    contractId: CONTRACT,
    ledgerClosedAt: CLOSED_AT,
    topic: [
      nativeToScVal("plan_created", { type: "symbol" }),
      nativeToScVal(MERCHANT, { type: "address" }),
      nativeToScVal(1, { type: "u64" }),
    ],
    value: nativeToScVal(
      { token: CONTRACT, amount: 10_000_000n, period: 2_592_000n, name: "Pro Monthly" },
      {
        type: {
          token: ["symbol", "address"],
          amount: ["symbol", "i128"],
          period: ["symbol", "u64"],
          name: ["symbol", "string"],
        },
      },
    ),
  } as unknown as rpc.Api.EventResponse;
}

function rawSubscribed(ledger: number): rpc.Api.EventResponse {
  return {
    ledger,
    txHash: "tx-sub-1",
    contractId: CONTRACT,
    ledgerClosedAt: CLOSED_AT,
    topic: [
      nativeToScVal("subscribed", { type: "symbol" }),
      nativeToScVal(1, { type: "u64" }),
      nativeToScVal(SUBSCRIBER, { type: "address" }),
      nativeToScVal(MERCHANT, { type: "address" }),
    ],
    value: nativeToScVal(
      {
        plan_id: 1n,
        amount: 10_000_000n,
        period: 2_592_000n,
        next_charge: 1_700_000_000n,
        max_charges: 0,
        fee_bps: 100,
      },
      {
        type: {
          plan_id: ["symbol", "u64"],
          amount: ["symbol", "i128"],
          period: ["symbol", "u64"],
          next_charge: ["symbol", "timepoint"],
          max_charges: ["symbol", "u32"],
          fee_bps: ["symbol", "u32"],
        },
      },
    ),
  } as unknown as rpc.Api.EventResponse;
}

function rawCharged(ledger: number): rpc.Api.EventResponse {
  return {
    ledger,
    txHash: "tx-charge-1",
    contractId: CONTRACT,
    ledgerClosedAt: CLOSED_AT,
    topic: [
      nativeToScVal("charged", { type: "symbol" }),
      nativeToScVal(1, { type: "u64" }),
      nativeToScVal(SUBSCRIBER, { type: "address" }),
      nativeToScVal(MERCHANT, { type: "address" }),
    ],
    value: nativeToScVal(
      { amount: 9_900_000n, fee: 100_000n, charges_made: 1, next_charge: 1_700_060_000n },
      {
        type: {
          amount: ["symbol", "i128"],
          fee: ["symbol", "i128"],
          charges_made: ["symbol", "u32"],
          next_charge: ["symbol", "timepoint"],
        },
      },
    ),
  } as unknown as rpc.Api.EventResponse;
}

interface FakeChain {
  latest: number;
  oldest: number;
  events: rpc.Api.EventResponse[];
}

/** A node that serves the same events however often they are asked for. */
function fakeRpc(chain: FakeChain): IndexerRpc {
  return {
    getLatestLedger: async () => ({ sequence: chain.latest }) as never,
    getHealth: async () => ({ oldestLedger: chain.oldest, latestLedger: chain.latest }) as never,
    getEvents: async (req: Record<string, unknown>) => {
      const start = req.startLedger as number;
      const end = (req.endLedger as number | undefined) ?? Infinity;
      const page = chain.events.filter((event) => event.ledger >= start && event.ledger < end);
      return { events: page, cursor: "", latestLedger: chain.latest } as never;
    },
  } as unknown as IndexerRpc;
}

function eventsApplied(): number {
  const match = /^payflow_events_applied_total\{network="testnet"\} (\d+)$/m.exec(metrics.render());
  return match ? Number(match[1]) : 0;
}

function chain(): FakeChain {
  return {
    latest: 103,
    oldest: 100,
    events: [rawPlanCreated(100), rawSubscribed(101), rawCharged(102)],
  };
}

/** Every projection row a duplicate delivery must not touch. */
function snapshot(db: ReturnType<typeof openDatabase>) {
  const rows = (sql: string) => db.prepare(sql).all().map((row) => ({ ...row }));
  return {
    events: rows("SELECT * FROM events ORDER BY event_id"),
    plans: rows("SELECT * FROM plans ORDER BY id"),
    mandates: rows("SELECT * FROM mandates ORDER BY id"),
    charges: rows("SELECT * FROM charges ORDER BY tx_hash"),
    churn: rows("SELECT * FROM mandate_events ORDER BY mandate_id, slot"),
    timeline: rows("SELECT * FROM mandate_timeline ORDER BY mandate_id, tx_hash, kind"),
    activeSubscribers: rows("SELECT * FROM plan_active_subscribers ORDER BY plan_id, subscriber"),
    subscriberCounts: rows("SELECT * FROM plan_subscriber_counts ORDER BY plan_id"),
  };
}

const decoded = (name: string, ledger: number, txHash: string, topics: unknown[], data: Record<string, unknown>): DecodedEvent => ({
  name,
  contractId: CONTRACT,
  ledger,
  txHash,
  topics,
  data,
  // The chain's clock, so the churn log can bucket the event deterministically.
  closeTime: 1_700_000_100,
});

const subscribedEvent = decoded("subscribed", 101, "tx-sub-1", [1n, SUBSCRIBER, MERCHANT], {
  plan_id: 1n,
  amount: 10_000_000n,
  period: 2_592_000n,
  next_charge: 1_700_000_000n,
  max_charges: 0,
  fee_bps: 100,
});

const chargedEvent = decoded("charged", 102, "tx-charge-1", [1n, SUBSCRIBER, MERCHANT], {
  amount: 9_900_000n,
  fee: 100_000n,
  charges_made: 1n,
  next_charge: 1_700_060_000n,
});

describe("duplicate event delivery", () => {
  test("a replayed ledger window changes no counter or projection", async () => {
    const db = openDatabase(":memory:");
    try {
      const ix = new Indexer(db, fakeRpc(chain()), net());
      await ix.ready;
      metrics.reset();
      const delivered: string[] = [];
      ix.events.on("applied", (event: DecodedEvent) => delivered.push(event.name));

      const first = await ix.tick();
      assert.equal(first.applied, 3, "the first delivery applies every event");
      // `plan_created` updates the plan row but is not a notification event;
      // only the mandate lifecycle events are emitted to listeners.
      assert.deepEqual(delivered, ["subscribed", "charged"]);
      const before = snapshot(db);
      const metricAfterFirst = eventsApplied();
      assert.equal(metricAfterFirst, 3);

      assert.equal(before.events.length, 3, "each raw event is retained once");
      assert.equal(before.charges.length, 1);
      assert.equal(before.churn.length, 1, "the subscription started once");
      assert.equal(before.timeline.length, 2);
      assert.deepEqual(before.subscriberCounts, [{ plan_id: 1, active_subscribers: 1 }]);
      assert.deepEqual(before.activeSubscribers, [
        { plan_id: 1, subscriber: SUBSCRIBER, mandate_count: 1 },
      ]);
      assert.equal(before.mandates[0]!.charges_made, 1);

      // A crash before the cursor committed: the same window is delivered again.
      writeCursor(db, 100);
      const second = await ix.tick();

      assert.equal(second.applied, 0, "a redelivered event is not counted as applied");
      assert.deepEqual(delivered, ["subscribed", "charged"], "no duplicate notification");
      assert.deepEqual(snapshot(db), before, "the projection is byte-for-byte unchanged");
      assert.equal(eventsApplied(), metricAfterFirst, "the applied metric did not move");
    } finally {
      db.close();
    }
  });

  test("applying the same decoded event twice is a no-op for the projection", async () => {
    const db = openDatabase(":memory:");
    try {
      const ix = new Indexer(db, {} as never, net());
      await ix.ready;
      const notifications: DecodedEvent[] = [];

      for (const event of [subscribedEvent, chargedEvent]) {
        await ix.apply(event, undefined, notifications);
      }
      const before = snapshot(db);

      for (const event of [subscribedEvent, chargedEvent]) {
        await ix.apply(event, undefined, notifications);
      }

      assert.deepEqual(snapshot(db), before);
      assert.equal(before.charges.length, 1, "the charge was not counted twice");
      assert.deepEqual(before.subscriberCounts, [{ plan_id: 1, active_subscribers: 1 }]);
      assert.deepEqual(before.activeSubscribers, [
        { plan_id: 1, subscriber: SUBSCRIBER, mandate_count: 1 },
      ]);
      assert.equal(before.churn.length, 1);
    } finally {
      db.close();
    }
  });

  test("an event that fails the contract spec is reported but never projected, however often it is delivered", async () => {
    const db = openDatabase(":memory:");
    try {
      const ix = new Indexer(db, {} as never, net());
      await ix.ready;
      const malformed: DecodedEvent = {
        ...subscribedEvent,
        txHash: "tx-sub-bad",
        data: { ...subscribedEvent.data, plan_id: undefined },
      };

      assert.equal(await ix.apply(malformed), "mismatched");
      assert.equal(await ix.apply(malformed), "mismatched");
      assert.deepEqual(snapshot(db).mandates, []);
      assert.deepEqual(snapshot(db).subscriberCounts, []);
      assert.equal(snapshot(db).events.length, 0, "a rejected event left no projection behind");
    } finally {
      db.close();
    }
  });
});

describe("duplicate charge delivery to webhooks", () => {
  test("a webhook receives one delivery for an event delivered twice", async () => {
    const db = openDatabase(":memory:");
    try {
      const calls: Array<{ headers: Record<string, string>; body: string }> = [];
      const dispatcher = new WebhookDispatcher({
        db,
        fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
          const headers = Object.fromEntries(
            new Headers(init?.headers as HeadersInit | undefined).entries(),
          );
          calls.push({ headers, body: String(init?.body ?? "") });
          return new Response("ok", { status: 200 });
        }) as typeof globalThis.fetch,
        lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      });
      await dispatcher.register(MERCHANT, "https://payflow.example/hook", "test-secret");

      await dispatcher.onApplied(chargedEvent);
      await dispatcher.onApplied(chargedEvent);

      assert.equal(calls.length, 1, "the second delivery is collapsed, not sent again");
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number }).n,
        1,
      );
      assert.equal(calls[0]!.headers["idempotency-key"]!.length, 36);
      assert.match(calls[0]!.headers["payflow-signature"]!, /^sha256=[0-9a-f]{64}$/);
    } finally {
      db.close();
    }
  });

  test("delivery respects the merchant's notification preference", async () => {
    const db = openDatabase(":memory:");
    try {
      let calls = 0;
      const dispatcher = new WebhookDispatcher({
        db,
        fetchImpl: (async () => {
          calls += 1;
          return new Response("ok", { status: 200 });
        }) as typeof globalThis.fetch,
        lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      });
      await dispatcher.register(MERCHANT, "https://payflow.example/hook", "test-secret");
      db.prepare(
        "INSERT INTO merchant_notification_preferences (merchant, events, updated_at) VALUES (?, ?, ?)",
      ).run(MERCHANT, JSON.stringify(["charge.failing"]), 1);

      await dispatcher.onApplied(chargedEvent);
      await dispatcher.onApplied(chargedEvent);

      assert.equal(calls, 0, "the merchant disabled charged-event notifications");
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number }).n,
        0,
      );
    } finally {
      db.close();
    }
  });
});

describe("webhook registration authentication", () => {
  test("an unsigned registration is refused, so a duplicate cannot reach an unverified URL", async () => {
    const db = openDatabase(":memory:");
    let calls = 0;
    const dispatcher = new WebhookDispatcher({
      db,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("ok", { status: 200 });
      }) as typeof globalThis.fetch,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const app = createApp(
      [{ config: net(), db, webhooks: dispatcher }],
      { CORS_ORIGIN: "*" } as unknown as Config,
    );
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    try {
      const res = await fetch(`${base}/api/v1/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          merchant: MERCHANT,
          url: "https://payflow.example/hook",
          secret: "test-secret",
          timestamp: Math.floor(Date.now() / 1000),
          signature: "",
        }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json() as { error: { code: string } }).error.code, "invalid_request");
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS n FROM webhooks").get() as { n: number }).n,
        0,
        "an unverified URL was not registered",
      );

      await dispatcher.onApplied(chargedEvent);
      await dispatcher.onApplied(chargedEvent);
      assert.equal(calls, 0, "with no registered webhook there is nothing to deliver");
    } finally {
      server.close();
      db.close();
    }
  });
});
