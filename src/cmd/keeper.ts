/** Run a single settlement pass on the default network and exit. */
import { loadConfig, networkConfigs } from "../config.ts";
import { openStorage } from "../lib/store/index.ts";
import { makeRpc } from "../lib/stellar.ts";
import { Keeper } from "../keeper.ts";
import { logger } from "../lib/logger.ts";

const config = loadConfig();
const network = networkConfigs(config)[0]!;
const db = await openStorage(network);
const keeper = new Keeper(db, makeRpc(network), config);

try {
  const results = await keeper.tick();
  logger.info({ results }, "settlement pass complete");
} catch (err) {
  logger.error({ err }, "settlement pass failed");
  process.exitCode = 1;
} finally {
  await db.close();
}
