import { existsSync, renameSync } from "node:fs";
import type { NetworkConfig } from "../config.ts";
import { Indexer, type IndexerRpc } from "../indexer.ts";
import { openDatabase } from "./db.ts";
import { acquireLock } from "./lock.ts";

export interface ReindexResult {
  /** Where the previous database was moved, or null when there was none. */
  backup: string | null;
  /** Events applied while catching up. */
  events: number;
}

/** `payflow.db` → `payflow.db.bak-20261021T101500Z`. */
export function backupPathFor(databasePath: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${databasePath}.bak-${stamp}`;
}

/**
 * Rebuild a network's projection from scratch: move the current database
 * aside as a backup, create a fresh one and catch up from the network's
 * start ledger (`INDEXER_START_LEDGER`).
 *
 * Refuses to run while another process (the API server) holds the
 * database's lock, and holds the lock itself for the whole run. The WAL and
 * shared-memory files move with the database, so the backup keeps any
 * writes that had not been checkpointed yet and opens as-is.
 */
export async function reindex(
  network: NetworkConfig,
  server: IndexerRpc,
  now: Date = new Date(),
): Promise<ReindexResult> {
  const path = network.databasePath;
  if (path === ":memory:") throw new Error("cannot reindex an in-memory database");
  const release = acquireLock(path);
  try {
    let backup: string | null = null;
    if (existsSync(path)) {
      backup = backupPathFor(path, now);
      renameSync(path, backup);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(path + suffix)) renameSync(path + suffix, backup + suffix);
      }
    }
    const db = openDatabase(path);
    try {
      const events = await new Indexer(db, server, network).catchUp();
      return { backup, events };
    } finally {
      db.close();
    }
  } finally {
    release();
  }
}
