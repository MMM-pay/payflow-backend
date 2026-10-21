/**
 * Rebuild SQLite event projections from the locally retained contract events.
 * Stop the API/indexer before running to avoid concurrent writes.
 * Usage: npm run rebuild:projections
 */
import { loadConfig, networkConfigs } from "../config.ts";
import { openDatabase } from "../lib/db.ts";
import { Indexer } from "../indexer.ts";
import { makeRpc } from "../lib/stellar.ts";
import { logger } from "../lib/logger.ts";

const config = loadConfig();
let failed = false;
for (const network of networkConfigs(config)) {
  const db = openDatabase(network.databasePath);
  try {
    // Rebuild does not make RPC calls; the server is only a constructor dependency.
    const indexer = new Indexer(db, makeRpc(network), network);
    const applied = indexer.rebuildProjections();
    logger.info({ network: network.name, applied }, "projections rebuilt from local events");
  } catch {
    failed = true;
    // Do not serialize thrown errors: RPC and environment secrets may be embedded.
    logger.error({ network: network.name }, "projection rebuild failed");
  } finally {
    db.close();
  }
}
if (failed) process.exitCode = 1;
