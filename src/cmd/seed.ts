import { StrKey } from "@stellar/stellar-sdk";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Indexer } from "../indexer.ts";
import { loadConfig, networkConfigs, type NetworkConfig } from "../config.ts";
import { openDatabase } from "../lib/db.ts";
import type { DecodedEvent } from "../lib/stellar.ts";

type SeedNetwork = Pick<
  NetworkConfig,
  "name" | "networkPassphrase" | "planRegistryId" | "subscriptionId" | "vaultId"
>;

interface SeedMandate {
  id: bigint;
  subscriber: string;
  merchant: string;
  planId: bigint;
  amount: bigint;
  period: bigint;
  chargeAgesDays: number[];
  finalStatus?: "Paused" | "Cancelled";
}

const address = (byte: number): string =>
  StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(byte));

const MERCHANTS = [address(21), address(22)];
const SUBSCRIBERS = [address(31), address(32), address(33), address(34), address(35)];
const FALLBACK_TOKEN = address(41);
const MONTH = 2_592_000n;
const QUARTER = 7_776_000n;
const YEAR = 31_536_000n;

const PLANS = [
  { id: 90_001n, merchant: MERCHANTS[0]!, name: "Studio Monthly", amount: 29_000_000n, period: MONTH },
  { id: 90_002n, merchant: MERCHANTS[0]!, name: "Studio Annual", amount: 290_000_000n, period: YEAR },
  { id: 90_003n, merchant: MERCHANTS[1]!, name: "Northstar Monthly", amount: 12_000_000n, period: MONTH },
  { id: 90_004n, merchant: MERCHANTS[1]!, name: "Northstar Quarterly", amount: 32_000_000n, period: QUARTER },
];

const MANDATES: SeedMandate[] = [
  { id: 91_001n, subscriber: SUBSCRIBERS[0]!, merchant: MERCHANTS[0]!, planId: 90_001n, amount: 29_000_000n, period: MONTH, chargeAgesDays: [60, 30, 1] },
  { id: 91_002n, subscriber: SUBSCRIBERS[1]!, merchant: MERCHANTS[0]!, planId: 90_002n, amount: 290_000_000n, period: YEAR, chargeAgesDays: [300] },
  { id: 91_003n, subscriber: SUBSCRIBERS[2]!, merchant: MERCHANTS[0]!, planId: 90_001n, amount: 29_000_000n, period: MONTH, chargeAgesDays: [60, 30], finalStatus: "Paused" },
  { id: 91_004n, subscriber: SUBSCRIBERS[3]!, merchant: MERCHANTS[1]!, planId: 90_003n, amount: 12_000_000n, period: MONTH, chargeAgesDays: [60, 30], finalStatus: "Cancelled" },
  { id: 91_005n, subscriber: SUBSCRIBERS[4]!, merchant: MERCHANTS[1]!, planId: 90_004n, amount: 32_000_000n, period: QUARTER, chargeAgesDays: [] },
];

function buildEvents(network: SeedNetwork, token: string, now: number): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  let ledger = 90_000_000;
  const makeEvent = (
    name: string,
    contractId: string,
    txHash: string,
    topics: unknown[],
    data: Record<string, unknown>,
    closeTime: number,
  ): DecodedEvent => ({ name, contractId, ledger: ledger++, txHash, topics, data, closeTime });

  for (const plan of PLANS) {
    events.push(
      makeEvent(
        "plan_created",
        network.planRegistryId,
        `seed-plan-${plan.id}`,
        [plan.merchant, plan.id],
        { token, amount: plan.amount, period: plan.period, name: plan.name },
        now - 400 * 86_400,
      ),
    );
  }

  for (const [index, merchant] of MERCHANTS.entries()) {
    events.push(
      makeEvent(
        "profile_updated",
        network.planRegistryId,
        `seed-profile-${index}`,
        [merchant],
        { name: index === 0 ? "Studio Supply" : "Northstar Goods", url: `https://merchant-${index + 1}.example` },
        now - 400 * 86_400,
      ),
    );
  }

  for (const mandate of MANDATES) {
    const subscriptionTime = now - 365 * 86_400;
    events.push(
      makeEvent(
        "subscribed",
        network.subscriptionId,
        `seed-subscribed-${mandate.id}`,
        [mandate.id, mandate.subscriber, mandate.merchant],
        {
          plan_id: mandate.planId,
          amount: mandate.amount,
          period: mandate.period,
          next_charge: BigInt(subscriptionTime) + mandate.period,
          max_charges: 0n,
          fee_bps: 100n,
        },
        subscriptionTime,
      ),
    );

    mandate.chargeAgesDays.forEach((ageDays, index) => {
      const closeTime = now - ageDays * 86_400;
      const fee = mandate.amount / 100n;
      events.push(
        makeEvent(
          "charged",
          network.subscriptionId,
          `seed-charge-${mandate.id}-${index + 1}`,
          [mandate.id, mandate.subscriber, mandate.merchant],
          {
            amount: mandate.amount - fee,
            fee,
            charges_made: BigInt(index + 1),
            next_charge: BigInt(closeTime) + mandate.period,
          },
          closeTime,
        ),
      );
    });

    if (mandate.finalStatus === "Paused") {
      events.push(
        makeEvent(
          "pause_changed",
          network.subscriptionId,
          `seed-paused-${mandate.id}`,
          [mandate.id, mandate.subscriber],
          { paused: true },
          now - 86_400,
        ),
      );
    } else if (mandate.finalStatus === "Cancelled") {
      events.push(
        makeEvent(
          "cancelled",
          network.subscriptionId,
          `seed-cancelled-${mandate.id}`,
          [mandate.id, mandate.subscriber],
          { charges_made: BigInt(mandate.chargeAgesDays.length) },
          now - 86_400,
        ),
      );
    }
  }

  const vaultEvents = [
    { kind: "deposit", user: SUBSCRIBERS[0]!, amount: 120_000_000n, balance: 120_000_000n },
    { kind: "debit", user: SUBSCRIBERS[0]!, amount: 28_710_000n, balance: 91_290_000n },
    { kind: "deposit", user: SUBSCRIBERS[1]!, amount: 500_000_000n, balance: 500_000_000n },
    { kind: "withdraw", user: SUBSCRIBERS[1]!, amount: 50_000_000n, balance: 450_000_000n },
    { kind: "deposit", user: SUBSCRIBERS[3]!, amount: 60_000_000n, balance: 60_000_000n },
  ] as const;

  vaultEvents.forEach((vaultEvent, index) => {
    events.push(
      makeEvent(
        vaultEvent.kind,
        network.vaultId,
        `seed-vault-${index}`,
        [vaultEvent.user, token, MERCHANTS[index % MERCHANTS.length]],
        { amount: vaultEvent.amount, balance: vaultEvent.balance },
        now - (vaultEvents.length - index) * 86_400,
      ),
    );
  });

  return events;
}

function isProductionNetwork(network: SeedNetwork): boolean {
  return /^(mainnet|public|production)$/i.test(network.name) ||
    network.networkPassphrase === "Public Global Stellar Network ; September 2015";
}

export function seedDatabase(
  db: DatabaseSync,
  network: SeedNetwork,
  token = FALLBACK_TOKEN,
  now = Math.floor(Date.now() / 1000),
): number {
  if (isProductionNetwork(network)) {
    throw new Error("Refusing to seed a production network database.");
  }

  const indexer = new Indexer(db, {} as never, network as NetworkConfig);
  const events = buildEvents(network, token, now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const markerExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_seed_state'")
      .get();
    const isSeeded = markerExists
      ? db.prepare("SELECT 1 FROM local_seed_state WHERE id = 1").get() !== undefined
      : false;
    if (!isSeeded) {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      for (const { name } of tables) {
        const quotedName = `"${name.replaceAll('"', '""')}"`;
        // Table names come from sqlite_master and are identifier-quoted above.
        const populated = db.prepare("SELECT EXISTS (SELECT 1 FROM " + quotedName + ") AS populated").get() as
          | { populated: number }
          | undefined;
        if (populated?.populated) {
          throw new Error("Refusing to seed a non-empty database not previously seeded by this command.");
        }
      }
    }

    db.exec(
      "CREATE TABLE IF NOT EXISTS local_seed_state (id INTEGER PRIMARY KEY CHECK (id = 1), seeded_at INTEGER NOT NULL)",
    );
    for (const event of events) indexer.apply(event);
    db.prepare("INSERT OR IGNORE INTO local_seed_state (id, seeded_at) VALUES (1, ?)").run(now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return events.length;
}

async function main(): Promise<void> {
  try {
    try {
      process.loadEnvFile();
    } catch {
      // No .env file: use the process environment.
    }
    const config = loadConfig();
    const network = networkConfigs(config)[0]!;
    if (isProductionNetwork(network)) {
      throw new Error("Refusing to seed a production network database.");
    }
    const db = openDatabase(network.databasePath);
    try {
      const count = seedDatabase(db, network, config.TOKEN_ID ?? FALLBACK_TOKEN);
      console.log(`Applied ${count} local sample events to ${network.databasePath}.`);
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(`Seed failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  await main();
}