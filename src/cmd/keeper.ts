/**
 * Run a single settlement pass on the default network and exit.
 *
 * SIGTERM/SIGINT mid-pass stop it gracefully (#255): no new mandate is picked
 * up, in-flight charges finish and are recorded, and the database is closed
 * only after that — or after `SHUTDOWN_TIMEOUT_MS`, whichever comes first.
 */
import { loadConfig, networkConfigs } from "../config.ts";
import { openStorage } from "../lib/store/index.ts";
import { makeRpc } from "../lib/stellar.ts";
import { Keeper, settleOnce } from "../keeper.ts";
import { logger } from "../lib/logger.ts";

const config = loadConfig();
const network = networkConfigs(config)[0]!;
const db = await openStorage(network);
const keeper = new Keeper(db, makeRpc(network), config);

const outcome = await settleOnce(keeper, { timeoutMs: config.SHUTDOWN_TIMEOUT_MS });
if (outcome.error !== undefined) {
  logger.error({ err: outcome.error }, "settlement pass failed");
  process.exitCode = 1;
} else if (outcome.timedOut) {
  // In-flight charges are abandoned, not lost: their claims lapse after
  // KEEPER_CLAIM_TTL_S and the indexer records whatever landed on chain.
  process.exitCode = 1;
} else {
  logger.info(
    { results: outcome.results, ...(outcome.signal ? { stoppedBy: outcome.signal } : {}) },
    outcome.signal ? "settlement pass stopped early; in-flight charges finished" : "settlement pass complete",
  );
}
if (outcome.timedOut) {
  // A stuck RPC call may still hold the event loop open; leave without it.
  process.exit();
}
await db.close();
