import type { DatabaseSync } from "node:sqlite";
import type { NetworkConfig } from "../../config.ts";
import { SqliteStorage } from "./sqlite.ts";
import type { Storage } from "./types.ts";
import { PostgresStorage } from "./postgres.ts";

export type { Storage } from "./types.ts";
export { PostgresStorage } from "./postgres.ts";
export { SqliteStorage } from "./sqlite.ts";

export function asStorage(database: Storage | DatabaseSync): Storage {
  return database instanceof SqliteStorage
    ? database
    : "prepare" in database
      ? new SqliteStorage(database)
      : database;
}

export async function openStorage(network: NetworkConfig): Promise<Storage> {
  if (network.databaseUrl) {
    return PostgresStorage.open(network.databaseUrl, network.name);
  }
  return SqliteStorage.open(network.databasePath);
}