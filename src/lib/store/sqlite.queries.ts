/**
 * Centralised SQLite store-level SQL queries (#268).
 */

export const SQLITE_QUERIES = {
  beginTransaction: "BEGIN",
  commitTransaction: "COMMIT",
  rollbackTransaction: "ROLLBACK",
} as const;
