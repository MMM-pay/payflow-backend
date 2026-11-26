import type { DatabaseSync } from "node:sqlite";
import type { NetworkConfig } from "../../config.ts";
import { SqliteStorage } from "./sqlite.ts";
import type { Storage } from "./types.ts";
import { PostgresStorage } from "./postgres.ts";
import { metrics } from "../metrics.ts";

export type { Storage } from "./types.ts";
export { PostgresStorage } from "./postgres.ts";
export { SqliteStorage } from "./sqlite.ts";

/**
 * Wrap a Storage so every `all`, `get` and `run` call records its latency as a
 * `db_query_duration_seconds` histogram observation, labelled by operation and
 * dialect.  Transactions are not timed at the wrapper level but each operation
 * inside them is, since the inner storage passed to `work` is itself wrapped.
 */
export function timedStorage(inner: Storage): Storage {
  const observe = (op: string, start: number): void => {
    metrics.observe("db_query_duration_seconds", (performance.now() - start) / 1000, {
      op,
      dialect: inner.dialect,
    });
  };
  return {
    get dialect() {
      return inner.dialect;
    },
    async all(sql, params) {
      const t = performance.now();
      try {
        return await inner.all(sql, params);
      } finally {
        observe("all", t);
      }
    },
    async get(sql, params) {
      const t = performance.now();
      try {
        return await inner.get(sql, params);
      } finally {
        observe("get", t);
      }
    },
    async run(sql, params) {
      const t = performance.now();
      try {
        return await inner.run(sql, params);
      } finally {
        observe("run", t);
      }
    },
    transaction(work) {
      return inner.transaction((tx) => work(timedStorage(tx)));
    },
    close() {
      return inner.close();
    },
  };
}

export function asStorage(database: Storage | DatabaseSync): Storage {
  return database instanceof SqliteStorage
    ? database
    : "prepare" in database
      ? new SqliteStorage(database)
      : database;
}

export async function openStorage(network: NetworkConfig): Promise<Storage> {
  if (network.databaseUrl) {
    // The pool is sized per process (#263): every API, indexer and keeper
    // process holds its own, so the cap has to leave room inside the server's
    // max_connections for the others.
    return PostgresStorage.open(network.databaseUrl, network.name, network.pool);
  }
  return SqliteStorage.open(network.databasePath);
}