import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { logger } from "../src/lib/logger.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { NotificationEvent } from "../src/lib/notification-preferences.ts";

/**
 * Simultaneous writes to the same table.
 *
 * The SQLite store advances one statement at a time, but the HTTP handlers
 * are async: several writes can be in flight together. Each notification
 * preference write is an upsert keyed on the merchant, so parallel requests
 * must not lose a merchant's row, duplicate it, or fail a constraint — and an
 * unauthenticated write must not land at all, however many arrive at once.
 */

logger.level = "silent";

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

const ALL_EVENTS: NotificationEvent[] = ["charged", "charge.failing", "charge.recovered"];
const EVENT_SETS: NotificationEvent[][] = [
  ["charged"],
  ["charge.failing", "charge.recovered"],
  ALL_EVENTS,
];
const MESSAGE_PREFIX = "payflow-notification-preferences:set:v1";

/** The exact message the route expects for a signed PUT. */
function putMessage(merchant: string, events: NotificationEvent[], timestamp: number): string {
  return `${MESSAGE_PREFIX}:${merchant}:${[...events].sort().join(",")}:${timestamp}`;
}

function signedPut(
  base: string,
  address: string,
  key: Keypair,
  events: NotificationEvent[],
): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = Buffer.from(
    key.sign(Buffer.from(putMessage(address, events, timestamp), "utf8")),
  ).toString("base64");
  return fetch(`${base}/api/merchants/${address}/notification-preferences`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events, timestamp, signature }),
  });
}

describe("concurrent writes", () => {
  const db = openDatabase(":memory:");
  let server: Server;
  let base = "";

  before(async () => {
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
    server.close();
  });

  function storedRows(): Array<{ merchant: string; events: string; updated_at: number }> {
    return db
      .prepare("SELECT merchant, events, updated_at FROM merchant_notification_preferences ORDER BY merchant")
      .all() as Array<{ merchant: string; events: string; updated_at: number }>;
  }

  test("simultaneous writes for different merchants all land", async () => {
    const merchants = Array.from({ length: 8 }, () => {
      const key = Keypair.random();
      return { key, address: key.publicKey() };
    });

    const writes = merchants.flatMap(({ key, address }) =>
      EVENT_SETS.map((events) => signedPut(base, address, key, events)),
    );
    const responses = await Promise.all(writes);

    for (const response of responses) {
      assert.equal(response.status, 200, `a concurrent write was refused: ${response.status}`);
    }

    const rows = storedRows();
    assert.equal(rows.length, merchants.length, "one row per merchant, none lost or duplicated");
    const byMerchant = new Map(rows.map((row) => [row.merchant, row]));
    for (const { address } of merchants) {
      const row = byMerchant.get(address);
      assert.ok(row, `merchant ${address} has a stored preference row`);
      const events = JSON.parse(row.events) as NotificationEvent[];
      assert.ok(
        EVENT_SETS.some((set) => set.join(",") === events.join(",")),
        "the stored set is one the caller sent, not a torn mixture",
      );
      assert.ok(row.updated_at > 0);
    }
  });

  test("simultaneous writes for one merchant leave one intact row", async () => {
    const key = Keypair.random();
    const address = key.publicKey();

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        signedPut(base, address, key, EVENT_SETS[index % EVENT_SETS.length]!),
      ),
    );
    for (const response of responses) {
      assert.equal(response.status, 200);
    }

    const row = db
      .prepare("SELECT events FROM merchant_notification_preferences WHERE merchant = ?")
      .get(address) as { events: string } | undefined;
    assert.ok(row, "the merchant's row exists");
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM merchant_notification_preferences WHERE merchant = ?")
      .get(address) as { n: number };
    assert.equal(count.n, 1, "the upsert did not duplicate the primary key");
    const events = JSON.parse(row.events) as NotificationEvent[];
    assert.ok(
      EVENT_SETS.some((set) => set.join(",") === events.join(",")),
      "the final row is one complete submission",
    );
  });

  test("simultaneous unauthenticated writes are all refused and write nothing", async () => {
    const key = Keypair.random();
    const address = key.publicKey();
    const otherKey = Keypair.random();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => {
        const timestamp = Math.floor(Date.now() / 1000);
        // Every request carries a signature by the wrong key.
        const signature = Buffer.from(
          otherKey.sign(Buffer.from(putMessage(address, ["charged"], timestamp), "utf8")),
        ).toString("base64");
        return fetch(`${base}/api/merchants/${address}/notification-preferences`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events: ["charged"], timestamp, signature }),
        });
      }),
    );

    for (const response of responses) {
      assert.equal(response.status, 401, "a bad signature is refused, not queued");
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "unauthorized");
    }

    const row = db
      .prepare("SELECT 1 FROM merchant_notification_preferences WHERE merchant = ?")
      .get(address);
    assert.equal(row, undefined, "a refused write leaves no row behind");
  });
});
