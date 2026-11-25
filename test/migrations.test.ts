import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { getMigrationStatus, MIGRATIONS } from "../src/lib/migrations.ts";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import type { Storage } from "../src/lib/store/types.ts";

describe("versioned migrations status", () => {
  test("reports applied migrations on an initialized SQLite store", async () => {
    const store = SqliteStorage.open(":memory:");
    try {
      const status = await getMigrationStatus(store);
      assert.equal(status.dialect, "sqlite");
      assert.equal(status.applied.length, MIGRATIONS.length);
      assert.equal(status.pending.length, 0);
      assert.equal(status.applied[0]?.version, 1);
      assert.equal(status.applied[0]?.applied, true);
    } finally {
      await store.close();
    }
  });

  test("reports pending migrations when schema_migrations is absent", async () => {
    const raw = new DatabaseSync(":memory:");
    const store = new SqliteStorage(raw);
    try {
      const status = await getMigrationStatus(store);
      assert.equal(status.dialect, "sqlite");
      assert.equal(status.applied.length, 0);
      assert.equal(status.pending.length, MIGRATIONS.length);
      assert.equal(status.pending[0]?.version, 1);
      assert.equal(status.pending[0]?.applied, false);
    } finally {
      await store.close();
    }
  });

  test("reports applied vs pending on a PostgreSQL store", async () => {
    const mockPostgres: Storage = {
      dialect: "postgres",
      async all<Row>() {
        return [{ version: 1 }] as Row[];
      },
      async get() {
        return undefined;
      },
      async run() {},
      async transaction(work) {
        return work(mockPostgres);
      },
      async close() {},
    };

    const status = await getMigrationStatus(mockPostgres);
    assert.equal(status.dialect, "postgres");
    assert.equal(status.applied.length, 1);
    assert.equal(status.pending.length, 0);
  });

  test("rethrows unexpected database errors", async () => {
    const failingStore: Storage = {
      dialect: "postgres",
      async all() {
        throw new Error("connection refused");
      },
      async get() {
        return undefined;
      },
      async run() {},
      async transaction(work) {
        return work(failingStore);
      },
      async close() {},
    };

    await assert.rejects(() => getMigrationStatus(failingStore), /connection refused/);
  });
});
