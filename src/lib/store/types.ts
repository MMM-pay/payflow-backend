export type SqlParameters = readonly unknown[];

/** Async persistence boundary shared by SQLite and PostgreSQL. */
export interface Storage {
  readonly dialect: "sqlite" | "postgres";
  all<Row>(sql: string, parameters?: SqlParameters): Promise<Row[]>;
  get<Row>(sql: string, parameters?: SqlParameters): Promise<Row | undefined>;
  run(sql: string, parameters?: SqlParameters): Promise<void>;
  transaction<Result>(work: (storage: Storage) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}
