/**
 * Conformance suite for the `Storage` interface (#265).
 *
 * Every implementation — SQLite today, PostgreSQL when DATABASE_URL is set —
 * must pass every test in this file. The suite exercises the full `Storage`
 * contract: all five methods, every error path, every edge case, and the
 * behaviours callers rely on that are not obvious from the type signature.
 *
 * Tests are deterministic and independent of network state. Every test
 * opens its own fresh store and closes it in a `finally` block, matching
 * the pattern used by the existing storage.test.ts that already passes
 * PostgreSQL CI.
 *
 * Layout
 * ──────
 * 1.  `dialect` — the backend's self-reported name.
 * 2.  `all` — happy path, empty result, parameter binding.
 * 3.  `get` — first row, undefined on miss, only the first row on multi-match.
 * 4.  `run` — write, upsert, `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`.
 * 5.  `transaction` — atomicity, rollback on throw, re-throws the original error.
 * 6.  Error paths — bad SQL, constraint violations.
 * 7.  Edge cases — bigint round-trips, null values, zero-row ops, app-table upserts.
 * 8.  `close` — first close resolves; second close behaviour is documented.
 * 9.  Cross-backend parity — SQLite and PostgreSQL return identical results.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import { PostgresStorage } from "../src/lib/store/postgres.ts";
import type { Storage } from "../src/lib/store/types.ts";

// ── backend registry ──────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;

type Backend = { name: string; open(): Promise<Storage> };

const backends: Backend[] = [
  { name: "SQLite", open: async () => SqliteStorage.open(":memory:") },
];
if (DATABASE_URL) {
  backends.push({
    name: "PostgreSQL",
    open: () =>
      PostgresStorage.open(
        DATABASE_URL,
        `conform_${process.pid}_${randomBytes(4).toString("hex")}`,
      ),
  });
}

// ── minimal schema ────────────────────────────────────────────────────────────

/**
 * A tiny two-column table sufficient to exercise every Storage method without
 * depending on the full application schema. Created fresh inside each test so
 * there is no shared state between tests.
 */
const CREATE_KV = `
  CREATE TABLE IF NOT EXISTS conform_kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )
`;

/** Open a store, create the kv table, run work, then always close. */
async function withStore(
  backend: Backend,
  work: (db: Storage) => Promise<void>,
): Promise<void> {
  const db = await backend.open();
  try {
    await db.run(CREATE_KV);
    await work(db);
  } finally {
    await db.close();
  }
}

// ── 1. dialect ────────────────────────────────────────────────────────────────

for (const backend of backends) {
  test(`${backend.name}: dialect identifies the backend`, async () => {
    await withStore(backend, async (db) => {
      const expected = backend.name === "SQLite" ? "sqlite" : "postgres";
      assert.equal(db.dialect, expected);
    });
  });
}

// ── 2. all ────────────────────────────────────────────────────────────────────

for (const backend of backends) {
  test(`${backend.name}: all returns every matching row`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["a", "1"]);
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["b", "2"]);
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["c", "3"]);
      const rows = await db.all<{ k: string; v: string }>(
        "SELECT k, v FROM conform_kv ORDER BY k",
      );
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((r) => r.k), ["a", "b", "c"]);
    });
  });

  test(`${backend.name}: all returns an empty array when no rows match`, async () => {
    await withStore(backend, async (db) => {
      const rows = await db.all("SELECT k FROM conform_kv WHERE k = ?", ["missing"]);
      assert.deepEqual(rows, []);
    });
  });

  test(`${backend.name}: all with no parameters runs without error`, async () => {
    await withStore(backend, async (db) => {
      const rows = await db.all("SELECT k FROM conform_kv");
      assert.ok(Array.isArray(rows));
      assert.equal(rows.length, 0);
    });
  });

  test(`${backend.name}: all binds parameters correctly`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["x", "10"]);
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["y", "20"]);
      const rows = await db.all<{ k: string }>(
        "SELECT k FROM conform_kv WHERE v = ?",
        ["10"],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.k, "x");
    });
  });
}

// ── 3. get ────────────────────────────────────────────────────────────────────

for (const backend of backends) {
  test(`${backend.name}: get returns the first matching row`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["key", "val"]);
      const row = await db.get<{ k: string; v: string }>(
        "SELECT k, v FROM conform_kv WHERE k = ?",
        ["key"],
      );
      assert.ok(row !== undefined);
      assert.equal(row.k, "key");
      assert.equal(row.v, "val");
    });
  });

  test(`${backend.name}: get returns undefined when no row matches`, async () => {
    await withStore(backend, async (db) => {
      const row = await db.get("SELECT k FROM conform_kv WHERE k = ?", ["absent"]);
      assert.equal(row, undefined);
    });
  });

  test(`${backend.name}: get returns only the first row when multiple match`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["p", "first"]);
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["q", "second"]);
      const row = await db.get<{ k: string }>(
        "SELECT k FROM conform_kv ORDER BY k ASC",
      );
      assert.equal(row?.k, "p");
    });
  });
}

// ── 4. run ────────────────────────────────────────────────────────────────────

for (const backend of backends) {
  test(`${backend.name}: run inserts a row that all/get can read back`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["inserted", "yes"]);
      const row = await db.get<{ v: string }>(
        "SELECT v FROM conform_kv WHERE k = ?",
        ["inserted"],
      );
      assert.equal(row?.v, "yes");
    });
  });

  test(`${backend.name}: run upserts with ON CONFLICT DO UPDATE`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["u", "old"]);
      await db.run(
        "INSERT INTO conform_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
        ["u", "new"],
      );
      const row = await db.get<{ v: string }>(
        "SELECT v FROM conform_kv WHERE k = ?",
        ["u"],
      );
      assert.equal(row?.v, "new");
    });
  });

  test(`${backend.name}: INSERT OR IGNORE is a no-op on a duplicate key`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["dup", "original"]);
      await db.run(
        "INSERT OR IGNORE INTO conform_kv (k, v) VALUES (?, ?)",
        ["dup", "overwrite"],
      );
      const row = await db.get<{ v: string }>(
        "SELECT v FROM conform_kv WHERE k = ?",
        ["dup"],
      );
      assert.equal(row?.v, "original", "original row must survive INSERT OR IGNORE");
    });
  });

  test(`${backend.name}: run deletes rows`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["d1", "v"]);
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["d2", "v"]);
      await db.run("DELETE FROM conform_kv WHERE v = ?", ["v"]);
      const rows = await db.all("SELECT k FROM conform_kv");
      assert.equal(rows.length, 0);
    });
  });
}

// ── 5. transaction ────────────────────────────────────────────────────────────

for (const backend of backends) {
  test(`${backend.name}: transaction commits all writes atomically`, async () => {
    await withStore(backend, async (db) => {
      await db.transaction(async (tx) => {
        await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["t1", "a"]);
        await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["t2", "b"]);
      });
      const rows = await db.all<{ k: string }>("SELECT k FROM conform_kv ORDER BY k");
      assert.deepEqual(rows.map((r) => r.k), ["t1", "t2"]);
    });
  });

  test(`${backend.name}: transaction rolls back all writes when the callback throws`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["before", "v"]);
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["during", "v"]);
          throw new Error("intentional rollback");
        }),
        /intentional rollback/,
      );
      const rows = await db.all<{ k: string }>("SELECT k FROM conform_kv ORDER BY k");
      assert.deepEqual(rows.map((r) => r.k), ["before"]);
    });
  });

  test(`${backend.name}: transaction re-throws the original error type`, async () => {
    await withStore(backend, async (db) => {
      await assert.rejects(
        db.transaction(async () => {
          throw new TypeError("typed rollback");
        }),
        (err: unknown) => err instanceof TypeError && err.message === "typed rollback",
      );
    });
  });

  test(`${backend.name}: committed rows are visible inside a transaction`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["outer", "v"]);
      await db.transaction(async (tx) => {
        const row = await tx.get<{ k: string }>(
          "SELECT k FROM conform_kv WHERE k = ?",
          ["outer"],
        );
        assert.equal(row?.k, "outer");
      });
    });
  });

  test(`${backend.name}: the tx storage supports all, get and run`, async () => {
    await withStore(backend, async (db) => {
      await db.transaction(async (tx) => {
        await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["tx-k", "tx-v"]);
        const row = await tx.get<{ v: string }>(
          "SELECT v FROM conform_kv WHERE k = ?",
          ["tx-k"],
        );
        assert.equal(row?.v, "tx-v");
        const rows = await tx.all<{ k: string }>(
          "SELECT k FROM conform_kv WHERE k = ?",
          ["tx-k"],
        );
        assert.equal(rows.length, 1);
      });
    });
  });

  test(`${backend.name}: sequential transactions do not corrupt one another`, async () => {
    await withStore(backend, async (db) => {
      for (let i = 0; i < 3; i++) {
        await db.transaction(async (tx) => {
          await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", [`seq-${i}`, String(i)]);
        });
      }
      const rows = await db.all<{ k: string }>("SELECT k FROM conform_kv ORDER BY k");
      assert.deepEqual(rows.map((r) => r.k), ["seq-0", "seq-1", "seq-2"]);
    });
  });
}

// ── 6. error paths ────────────────────────────────────────────────────────────

for (const backend of backends) {
  test(`${backend.name}: all rejects on a syntax error`, async () => {
    await withStore(backend, async (db) => {
      await assert.rejects(
        db.all("NOT VALID SQL !!!"),
        (err: unknown) => err instanceof Error && err.message.length > 0,
      );
    });
  });

  test(`${backend.name}: get rejects on a syntax error`, async () => {
    await withStore(backend, async (db) => {
      await assert.rejects(
        db.get("ALSO NOT VALID"),
        (err: unknown) => err instanceof Error,
      );
    });
  });

  test(`${backend.name}: run rejects on a syntax error`, async () => {
    await withStore(backend, async (db) => {
      await assert.rejects(
        db.run("NEITHER IS THIS"),
        (err: unknown) => err instanceof Error,
      );
    });
  });

  test(`${backend.name}: run rejects on a primary key violation`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["pk", "first"]);
      await assert.rejects(
        db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["pk", "second"]),
        (err: unknown) =>
          /unique|duplicate|constraint/i.test(String((err as Error)?.message ?? err)),
      );
    });
  });

  test(`${backend.name}: run rejects on a NOT NULL violation`, async () => {
    await withStore(backend, async (db) => {
      await assert.rejects(
        db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["notnull", null]),
        (err: unknown) => err instanceof Error,
      );
    });
  });

  test(`${backend.name}: constraint violation inside a transaction rolls back cleanly`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["existing", "v"]);
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["new-row", "v"]);
          await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["existing", "dup"]);
        }),
        (err: unknown) =>
          /unique|duplicate|constraint/i.test(String((err as Error)?.message ?? err)),
      );
      const row = await db.get("SELECT k FROM conform_kv WHERE k = ?", ["new-row"]);
      assert.equal(row, undefined, "partial writes in a rolled-back transaction must not persist");
    });
  });

  test(`${backend.name}: referencing a non-existent table rejects`, async () => {
    await withStore(backend, async (db) => {
      await assert.rejects(
        db.all("SELECT * FROM table_that_does_not_exist"),
        (err: unknown) => err instanceof Error,
      );
    });
  });
}

// ── 7. edge cases ─────────────────────────────────────────────────────────────

for (const backend of backends) {
  test(`${backend.name}: large decimal string survives a TEXT round-trip`, async () => {
    await withStore(backend, async (db) => {
      const bigAmount = "9007199254740993"; // > Number.MAX_SAFE_INTEGER
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["big", bigAmount]);
      const row = await db.get<{ v: string }>(
        "SELECT v FROM conform_kv WHERE k = ?",
        ["big"],
      );
      assert.equal(row?.v, bigAmount);
    });
  });

  test(`${backend.name}: empty string value round-trips correctly`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["empty", ""]);
      const row = await db.get<{ v: string }>(
        "SELECT v FROM conform_kv WHERE k = ?",
        ["empty"],
      );
      assert.equal(row?.v, "");
    });
  });

  test(`${backend.name}: all with an empty parameter array behaves like no parameters`, async () => {
    await withStore(backend, async (db) => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["ep", "v"]);
      const rows = await db.all<{ k: string }>(
        "SELECT k FROM conform_kv WHERE k = 'ep'",
        [],
      );
      assert.equal(rows.length, 1);
    });
  });

  test(`${backend.name}: DELETE of zero rows does not reject`, async () => {
    await withStore(backend, async (db) => {
      await db.run("DELETE FROM conform_kv WHERE k = ?", ["ghost"]);
      const rows = await db.all("SELECT k FROM conform_kv");
      assert.equal(rows.length, 0);
    });
  });

  test(`${backend.name}: UPDATE of zero rows does not reject`, async () => {
    await withStore(backend, async (db) => {
      await db.run("UPDATE conform_kv SET v = ? WHERE k = ?", ["new", "absent"]);
      const rows = await db.all("SELECT k FROM conform_kv");
      assert.equal(rows.length, 0);
    });
  });

  test(`${backend.name}: cursor upsert advances last_ledger correctly`, async () => {
    await withStore(backend, async (db) => {
      await db.run(
        `INSERT INTO cursor (id, last_ledger) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger`,
        [100],
      );
      const first = await db.get<{ last_ledger: number }>(
        "SELECT last_ledger FROM cursor WHERE id = 1",
      );
      assert.equal(first?.last_ledger, 100);

      await db.run(
        `INSERT INTO cursor (id, last_ledger) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger`,
        [200],
      );
      const second = await db.get<{ last_ledger: number }>(
        "SELECT last_ledger FROM cursor WHERE id = 1",
      );
      assert.equal(second?.last_ledger, 200);
    });
  });

  test(`${backend.name}: events INSERT OR IGNORE is idempotent`, async () => {
    await withStore(backend, async (db) => {
      const insert = `
        INSERT OR IGNORE INTO events
          (event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const params = ["evt-conform-1", "C".repeat(56), 10, "tx-conform-1", "", "[]", "", null];
      await db.run(insert, params);
      await db.run(insert, params);
      const rows = await db.all<{ event_id: string }>(
        "SELECT event_id FROM events WHERE event_id = ?",
        ["evt-conform-1"],
      );
      assert.equal(rows.length, 1, "replayed event must not create a duplicate row");
    });
  });

  test(`${backend.name}: plan amount survives a round-trip without precision loss`, async () => {
    await withStore(backend, async (db) => {
      const amount = "9007199254740993";
      await db.run(
        `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [1, "G" + "B".repeat(55), "Test", "C".repeat(56), amount, 2592000, 1, 10],
      );
      const row = await db.get<{ amount: string }>(
        "SELECT amount FROM plans WHERE id = ?",
        [1],
      );
      assert.equal(row?.amount, amount);
    });
  });
}

// ── 8. close ──────────────────────────────────────────────────────────────────

for (const backend of backends) {
  test(`${backend.name}: close resolves without throwing on first call`, async () => {
    const db = await backend.open();
    await assert.doesNotReject(db.close());
  });

  test(`${backend.name}: a second close either resolves or rejects with an Error`, async () => {
    // First close must always succeed. Second close may throw (SQLite: "database
    // is not open"; PostgreSQL: "Called end on pool more than once") — both acceptable.
    const db = await backend.open();
    await db.close();
    try {
      await db.close();
    } catch (err) {
      assert.ok(err instanceof Error, "if second close throws it must be an Error");
    }
  });
}

// ── 9. cross-backend parity ───────────────────────────────────────────────────

test(
  "SQLite and PostgreSQL return identical rows for the same inserts and queries",
  { skip: !DATABASE_URL },
  async () => {
    const sqlite = SqliteStorage.open(":memory:");
    const postgres = await PostgresStorage.open(
      DATABASE_URL!,
      `parity_conform_${process.pid}_${randomBytes(4).toString("hex")}`,
    );
    try {
      for (const store of [sqlite, postgres]) {
        await store.run(CREATE_KV);
        await store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["one", "1"]);
        await store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["two", "2"]);
        await store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["three", "3"]);
      }
      const sqliteRows = await sqlite.all<{ k: string; v: string }>(
        "SELECT k, v FROM conform_kv ORDER BY k",
      );
      const pgRows = await postgres.all<{ k: string; v: string }>(
        "SELECT k, v FROM conform_kv ORDER BY k",
      );
      assert.deepEqual(sqliteRows, pgRows);

      const sqliteRow = await sqlite.get<{ k: string }>(
        "SELECT k FROM conform_kv WHERE k = ?", ["two"],
      );
      const pgRow = await postgres.get<{ k: string }>(
        "SELECT k FROM conform_kv WHERE k = ?", ["two"],
      );
      assert.deepEqual(sqliteRow, pgRow);
    } finally {
      await Promise.all([sqlite.close(), postgres.close()]);
    }
  },
);

test(
  "SQLite and PostgreSQL roll back identically on a thrown error",
  { skip: !DATABASE_URL },
  async () => {
    const sqlite = SqliteStorage.open(":memory:");
    const postgres = await PostgresStorage.open(
      DATABASE_URL!,
      `rollback_conform_${process.pid}_${randomBytes(4).toString("hex")}`,
    );
    try {
      for (const store of [sqlite, postgres]) {
        await store.run(CREATE_KV);
        await store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["seed", "v"]);
        await assert.rejects(
          store.transaction(async (tx) => {
            await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["ephemeral", "v"]);
            throw new Error("rollback");
          }),
          /rollback/,
        );
      }
      const sqliteRows = await sqlite.all<{ k: string }>("SELECT k FROM conform_kv ORDER BY k");
      const pgRows = await postgres.all<{ k: string }>("SELECT k FROM conform_kv ORDER BY k");
      assert.deepEqual(sqliteRows, pgRows);
      assert.deepEqual(sqliteRows.map((r) => r.k), ["seed"]);
    } finally {
      await Promise.all([sqlite.close(), postgres.close()]);
    }
  },
);

test(
  "SQLite and PostgreSQL enforce the same primary key constraint",
  { skip: !DATABASE_URL },
  async () => {
    const sqlite = SqliteStorage.open(":memory:");
    const postgres = await PostgresStorage.open(
      DATABASE_URL!,
      `pk_conform_${process.pid}_${randomBytes(4).toString("hex")}`,
    );
    try {
      for (const store of [sqlite, postgres]) {
        await store.run(CREATE_KV);
        await store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["shared", "v"]);
        await assert.rejects(
          store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["shared", "dup"]),
          (err: unknown) =>
            /unique|duplicate|constraint/i.test(String((err as Error)?.message ?? err)),
        );
      }
    } finally {
      await Promise.all([sqlite.close(), postgres.close()]);
    }
  },
);
