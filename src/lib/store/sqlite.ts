import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { openDatabase } from "../db.ts";
import type { SqlParameters, Storage } from "./types.ts";

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(row)) {
    if (
      typeof value === "bigint" &&
      value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      row[key] = Number(value);
    }
  }
  return row;
}

class SqliteTransaction implements Storage {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async all<Row>(sql: string, parameters: SqlParameters = []): Promise<Row[]> {
    const statement = this.database.prepare(sql);
    statement.setReadBigInts(true);
    return (statement.all(...(parameters as SQLInputValue[])) as Record<string, unknown>[])
      .map((row) => normalizeRow(row)) as Row[];
  }

  async get<Row>(sql: string, parameters: SqlParameters = []): Promise<Row | undefined> {
    const statement = this.database.prepare(sql);
    statement.setReadBigInts(true);
    const row = statement.get(...(parameters as SQLInputValue[])) as Record<string, unknown> | undefined;
    return row ? normalizeRow(row) as Row : undefined;
  }

  async run(sql: string, parameters: SqlParameters = []): Promise<void> {
    this.database.prepare(sql).run(...(parameters as SQLInputValue[]));
  }

  async transaction<Result>(work: (storage: Storage) => Promise<Result>): Promise<Result> {
    return work(this);
  }

  async close(): Promise<void> {}
}

/** SQLite implementation of the shared async storage boundary. */
export class SqliteStorage implements Storage {
  readonly database: DatabaseSync;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  static open(path: string): SqliteStorage {
    return new SqliteStorage(openDatabase(path));
  }

  async all<Row>(sql: string, parameters: SqlParameters = []): Promise<Row[]> {
    await this.transactionTail;
    const statement = this.database.prepare(sql);
    statement.setReadBigInts(true);
    return (statement.all(...(parameters as SQLInputValue[])) as Record<string, unknown>[])
      .map((row) => normalizeRow(row)) as Row[];
  }

  async get<Row>(sql: string, parameters: SqlParameters = []): Promise<Row | undefined> {
    await this.transactionTail;
    const statement = this.database.prepare(sql);
    statement.setReadBigInts(true);
    const row = statement.get(...(parameters as SQLInputValue[])) as Record<string, unknown> | undefined;
    return row ? normalizeRow(row) as Row : undefined;
  }

  async run(sql: string, parameters: SqlParameters = []): Promise<void> {
    await this.transactionTail;
    this.database.prepare(sql).run(...(parameters as SQLInputValue[]));
  }

  async transaction<Result>(work: (storage: Storage) => Promise<Result>): Promise<Result> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.database.exec("BEGIN");
      const result = await work(new SqliteTransaction(this.database));
      this.database.exec("COMMIT");
      return result;
    } catch (err) {
      this.database.exec("ROLLBACK");
      throw err;
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    await this.transactionTail;
    this.database.close();
  }
}
