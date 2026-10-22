/**
 * Rebuild every configured network's projection from scratch: the current
 * database is kept as a timestamped backup beside it, a fresh one is created
 * and indexed from INDEXER_START_LEDGER. Refuses to run while the server
 * holds the database.
 * Usage: npm run reindex
 */
import { loadConfig, networkConfigs } from "../config.ts";
import { makeRpc } from "../lib/stellar.ts";
import { DatabaseLockedError } from "../lib/lock.ts";
import { reindex } from "../lib/reindex.ts";
import { logger } from "../lib/logger.ts";

const config = loadConfig();
let failed = false;
for (const network of networkConfigs(config)) {
  try {
    const { backup, events } = await reindex(network, makeRpc(network));
    logger.info(
      { network: network.name, backup, events, startLedger: network.startLedger },
      "projection rebuilt from scratch",
    );
  } catch (err) {
    failed = true;
    if (err instanceof DatabaseLockedError) {
      logger.error({ network: network.name, pid: err.pid }, err.message);
    } else {
      // Do not serialize thrown errors: RPC URLs and environment secrets may be embedded.
      logger.error(
        { network: network.name, error: err instanceof Error ? err.message : String(err) },
        "reindex failed; the previous database is kept as a backup",
      );
    }
  }
}
if (failed) process.exitCode = 1;
