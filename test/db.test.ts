import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, describe } from "node:test";
import { openDatabase, backupDatabase, migrate, writeCursor } from "../src/lib/db.ts";

type Db = ReturnType<typeof openDatabase>;

/** The query plan SQLite would use for `sql`, as one readable line. */
function queryPlan(db: Db, sql: string, args: unknown[] = []): string {
  return db
    // A fixed prefix over fixed test SQL; no request data is involved.
    // eslint-disable-next-line no-restricted-syntax
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(args as never[]))
    .map((r) => String((r as { detail: string }).detail))
    .join(" | ");
}

describe("forward-only schema migrations", () => {
  test("adds current columns without changing legacy rows or columns, and is repeatable", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE plans (
        id INTEGER PRIMARY KEY, merchant TEXT NOT NULL, token TEXT NOT NULL,
        amount TEXT NOT NULL, period INTEGER NOT NULL, active INTEGER NOT NULL,
        ledger INTEGER NOT NULL
      );
      INSERT INTO plans VALUES (7, 'merchant', 'token', '9007199254740993', 30, 1, 42);
      CREATE TABLE mandates (
        id INTEGER PRIMARY KEY, subscriber TEXT NOT NULL, merchant TEXT NOT NULL,
        plan_id INTEGER NOT NULL, amount TEXT NOT NULL, period INTEGER NOT NULL,
        next_charge INTEGER NOT NULL, last_charge INTEGER NOT NULL,
        charges_made INTEGER NOT NULL, max_charges INTEGER NOT NULL,
        status TEXT NOT NULL, ledger INTEGER NOT NULL
      );
      INSERT INTO mandates VALUES (8, 'subscriber', 'merchant', 7, '9007199254740993', 30,
        100, 70, 1, 5, 'Active', 42);
      INSERT INTO mandates VALUES (10, 'subscriber', 'merchant', 7, '10', 30,
        100, 70, 1, 5, 'Active', 42);
      INSERT INTO mandates VALUES (11, 'other', 'merchant', 7, '10', 30,
        100, 70, 1, 5, 'Cancelled', 42);
      CREATE TABLE webhooks (
        id INTEGER PRIMARY KEY, merchant TEXT NOT NULL, url TEXT NOT NULL,
        secret TEXT NOT NULL, active INTEGER NOT NULL, failed INTEGER NOT NULL,
        failures INTEGER NOT NULL, last_attempt INTEGER, last_status INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO webhooks VALUES (9, 'merchant', 'https://example.test', 'secret',
        1, 0, 0, NULL, NULL, 42);
    `);

    migrate(db);

    const plan = db.prepare("SELECT * FROM plans WHERE id = 7").get() as {
      id: number; merchant: string; token: string; amount: string; period: number;
      active: number; ledger: number; name: string;
    };
    assert.equal(plan.id, 7);
    assert.equal(plan.merchant, "merchant");
    assert.equal(plan.token, "token");
    assert.equal(plan.amount, "9007199254740993");
    assert.equal(plan.period, 30);
    assert.equal(plan.active, 1);
    assert.equal(plan.ledger, 42);
    assert.equal(plan.name, "");

    const mandate = db.prepare("SELECT * FROM mandates WHERE id = 8").get() as {
      subscriber: string; amount: string; fee_bps: number; ended_by: string | null;
    };
    assert.equal(mandate.subscriber, "subscriber");
    assert.equal(mandate.amount, "9007199254740993");
    assert.equal(mandate.fee_bps, 0);
    assert.equal(mandate.ended_by, null);

    assert.deepEqual(
      (db.prepare("SELECT * FROM plan_active_subscribers").all() as Record<string, unknown>[])
        .map((row) => ({ ...row })),
      [{ plan_id: 7, subscriber: "subscriber", mandate_count: 2 }],
      "the upgrade groups active mandates by distinct subscriber",
    );
    assert.deepEqual(
      (db.prepare("SELECT * FROM plan_subscriber_counts").all() as Record<string, unknown>[])
        .map((row) => ({ ...row })),
      [{ plan_id: 7, active_subscribers: 1 }],
    );

    const webhook = db.prepare("SELECT * FROM webhooks WHERE id = 9").get() as {
      url: string; secret: string; previous_secret: string | null;
      previous_secret_expires_at: number | null;
    };
    assert.equal(webhook.url, "https://example.test");
    assert.equal(webhook.secret, "secret");
    assert.equal(webhook.previous_secret, null);
    assert.equal(webhook.previous_secret_expires_at, null);

    const plansColumnsBefore = db.prepare("SELECT name FROM pragma_table_info('plans') ORDER BY cid").all();
    const indexCountBefore = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index'").get() as { n: number }).n;
    migrate(db);
    assert.deepEqual(
      db.prepare("SELECT name FROM pragma_table_info('plans') ORDER BY cid").all(),
      plansColumnsBefore,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index'").get() as { n: number }).n,
      indexCountBefore,
    );
    db.close();
  });

  test("skips absent tables in a partially built database", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE plans (id INTEGER PRIMARY KEY, merchant TEXT NOT NULL)");
    db.prepare("INSERT INTO plans VALUES (1, 'merchant')").run();

    assert.doesNotThrow(() => migrate(db));
    assert.equal(
      (db.prepare("SELECT name FROM pragma_table_info('plans') WHERE name = 'name'").get() as { name: string }).name,
      "name",
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n, 1);
    assert.doesNotThrow(() => migrate(db));
    db.close();
  });

  test("an existing database gains keeper_claims on open, keeps its keeper rows, and reopens cleanly (#249)", () => {
    const dir = mkdtempSync(join(tmpdir(), "payflow-claims-migration-"));
    const path = join(dir, "legacy.db");
    try {
      // A database from before #249: a charge attempt, no claims table.
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE charge_attempts (
          id INTEGER PRIMARY KEY, mandate_id INTEGER NOT NULL, attempted_at INTEGER NOT NULL,
          result TEXT NOT NULL, error_code TEXT, tx_hash TEXT, shortfall TEXT,
          failures INTEGER NOT NULL, retry_at INTEGER
        );
        INSERT INTO charge_attempts VALUES (1, 8, 100, 'failed', 'txBadSeq', NULL, NULL, 1, 160);
      `);
      legacy.close();

      for (let open = 0; open < 2; open += 1) {
        const db = openDatabase(path);
        const columns = db
          .prepare("SELECT name FROM pragma_table_info('keeper_claims') ORDER BY cid")
          .all()
          .map((row) => (row as { name: string }).name);
        assert.deepEqual(columns, ["mandate_id", "due_at", "owner", "expires_at"]);
        assert.deepEqual(
          { ...(db.prepare("SELECT mandate_id, error_code, retry_at FROM charge_attempts").get() as object) },
          { mandate_id: 8, error_code: "txBadSeq", retry_at: 160 },
          "the attempt log, and so the restored backoff, survives the upgrade",
        );
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("surfaces database errors instead of treating a failed migration as success", () => {
    const db = openDatabase(":memory:");
    db.close();
    assert.throws(() => migrate(db));
  });
});

describe("summary query indexes", () => {
  test("migrate creates the covering indexes", () => {
    const db = openDatabase(":memory:");
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    assert.ok(names.includes("mandates_merchant_status_period_amount"));
    assert.ok(names.includes("charges_merchant_amount"));
    assert.ok(names.includes("charges_subscriber_amount_fee"));
    assert.ok(names.includes("charges_mandate_created_at"));
    assert.ok(names.includes("charges_subscriber_created_at"));
    db.close();
  });

  test("merchant summary queries use covering indexes, not table scans", () => {
    const db = openDatabase(":memory:");

    const active = queryPlan(
      db,
      "SELECT COUNT(*) AS n FROM mandates WHERE merchant = ? AND status = 'Active'",
      ["M"],
    );
    assert.match(active, /COVERING INDEX/);
    assert.doesNotMatch(active, /SCAN mandates\b/);

    const collected = queryPlan(
      db,
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total, COUNT(*) AS n FROM charges WHERE merchant = ?",
      ["M"],
    );
    assert.match(collected, /COVERING INDEX/);
    assert.doesNotMatch(collected, /SCAN charges\b/);

    const recurring = queryPlan(
      db,
      `SELECT COALESCE(SUM(CAST(amount AS INTEGER) * 2592000 / period), 0) AS mrr
         FROM mandates WHERE merchant = ? AND status = 'Active' AND period > 0`,
      ["M"],
    );
    assert.match(recurring, /COVERING INDEX/);
    assert.doesNotMatch(recurring, /SCAN mandates\b/);

    db.close();
  });

  test("subscriber summary total uses a covering index", () => {
    const db = openDatabase(":memory:");
    const paid = queryPlan(
      db,
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges WHERE subscriber = ?",
      ["S"],
    );
    assert.match(paid, /COVERING INDEX/);
    assert.doesNotMatch(paid, /SCAN charges\b/);
    db.close();
  });
});

describe("raw event feed indexes", () => {
  const COLUMNS = "event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time";

  test("migrate creates the contract feed index", () => {
    const db = openDatabase(":memory:");
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(names.includes("events_contract_ledger"));
    db.close();
  });

  test("a contract-filtered page seeks the contract's own events from the cursor", () => {
    const db = openDatabase(":memory:");
    const plan = queryPlan(
      db,
      `SELECT ${COLUMNS} FROM events WHERE (ledger, event_id) > (?, ?) AND contract_id = ? ORDER BY ledger, event_id LIMIT ?`,
      [0, "", "C", 51],
    );
    assert.match(plan, /USING INDEX events_contract_ledger \(contract_id=\? AND \(ledger,event_id\)>\(\?,\?\)\)/);
    assert.doesNotMatch(plan, /SCAN events\b/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
    db.close();
  });

  test("an unfiltered page seeks from the cursor in feed order", () => {
    const db = openDatabase(":memory:");
    const plan = queryPlan(
      db,
      `SELECT ${COLUMNS} FROM events WHERE (ledger, event_id) > (?, ?) ORDER BY ledger, event_id LIMIT ?`,
      [0, "", 51],
    );
    assert.match(plan, /USING INDEX events_ledger \(\(ledger,event_id\)>\(\?,\?\)\)/);
    assert.doesNotMatch(plan, /SCAN events\b/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
    db.close();
  });
});

describe("database backup", () => {
  test("produces a consistent copy that opens and reads the same data", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payflow-backup-"));
    try {
      const primary = path.join(dir, "primary.db");
      const backup = path.join(dir, "backup.db");

      const db = openDatabase(primary);
      // Seed some data through the projection tables.
      db.prepare("INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger) VALUES (1, 'M', 'Pro', 'T', '1000', 2592000, 1, 100)").run();
      db.prepare("INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, last_charge, charges_made, max_charges, fee_bps, status, ledger) VALUES (1, 'S', 'M', 1, '1000', 2592000, 1700000000, 0, 0, 0, 100, 'Active', 100)").run();
      db.prepare("INSERT INTO charges (tx_hash, mandate_id, subscriber, merchant, amount, fee, charges_made, next_charge, ledger, created_at) VALUES ('tx-1', 1, 'S', 'M', '990', '10', 1, 1700000000, 100, 1700000000)").run();
      writeCursor(db, 100);
      db.close();

      backupDatabase(openDatabase(primary), backup);

      const copy = openDatabase(backup);
      const plan = copy.prepare("SELECT * FROM plans WHERE id = 1").get() as { name: string; amount: string };
      assert.equal(plan.name, "Pro");
      assert.equal(plan.amount, "1000");

      const mandate = copy.prepare("SELECT * FROM mandates WHERE id = 1").get() as { status: string; charges_made: number };
      assert.equal(mandate.status, "Active");
      assert.equal(mandate.charges_made, 0);

      const charge = copy.prepare("SELECT COUNT(*) AS n FROM charges").get() as { n: number };
      assert.equal(charge.n, 1);

      const cursor = copy.prepare("SELECT last_ledger FROM cursor WHERE id = 1").get() as { last_ledger: number };
      assert.equal(cursor.last_ledger, 100);

      copy.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("backup of an in-memory database writes a readable file", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payflow-backup-"));
    try {
      const backup = path.join(dir, "mem-backup.db");

      const db = openDatabase(":memory:");
      db.prepare("INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger) VALUES (1, 'M', 'Pro', 'T', '1000', 2592000, 1, 100)").run();
      db.close();

      backupDatabase(openDatabase(":memory:"), backup);
      assert.ok(fs.existsSync(backup), "backup file was created");
      assert.ok(fs.statSync(backup).size > 0, "backup file is not empty");

      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      // no-op: cleaned in try
    }
  });
});

describe("report query indexes", () => {
  test("plan ranking reads the maintained subscriber count without scanning mandates", () => {
    const db = openDatabase(":memory:");
    // The statement `listPlansBySubscribers` runs, unfiltered and by merchant.
    const ranked = (where: string, args: unknown[]) =>
      queryPlan(
        db,
        `SELECT plans.*, COALESCE(plan_subscriber_counts.active_subscribers, 0) AS activeSubscribers
           FROM plans
           LEFT JOIN plan_subscriber_counts ON plan_subscriber_counts.plan_id = plans.id
           ${where}
          ORDER BY COALESCE(plan_subscriber_counts.active_subscribers, 0) DESC,
                   id ASC
          LIMIT ?`,
        [...args, 10],
      );
    for (const plan of [ranked("", []), ranked("WHERE merchant = ?", ["M"])]) {
      assert.match(plan, /SEARCH plan_subscriber_counts USING INTEGER PRIMARY KEY \(rowid=\?\)/);
      assert.doesNotMatch(plan, /SCAN mandates\b/);
    }
    assert.match(ranked("WHERE merchant = ?", ["M"]), /SEARCH plans USING INDEX plans_merchant/);
    db.close();
  });

  test("the protocol fee report reads only its window, from a covering index", () => {
    const db = openDatabase(":memory:");
    for (const edge of ["MAX", "MIN"]) {
      const plan = queryPlan(db, `SELECT ${edge}(created_at) AS at FROM charges`);
      assert.match(plan, /SEARCH charges USING COVERING INDEX charges_created_at_fee/, edge);
    }

    const window = queryPlan(
      db,
      `SELECT CAST(FLOOR(at / 86400.0) AS INTEGER) * 86400 AS bucket,
              COALESCE(SUM(CAST(fee AS INTEGER)), 0) AS fee,
              COUNT(*) AS charges
         FROM (
           SELECT CAST(created_at / 1000 AS INTEGER) AS at, fee
             FROM charges
            WHERE created_at >= ?
         )
        GROUP BY bucket
        ORDER BY bucket`,
      [0],
    );
    assert.match(window, /SEARCH charges USING COVERING INDEX charges_created_at_fee \(created_at>\?\)/);
    assert.doesNotMatch(window, /SCAN charges\b/);
    db.close();
  });

  test("the unpaid report seeks the merchant's due mandates in report order", () => {
    const db = openDatabase(":memory:");
    // The keyset page `listMerchantUnpaidMandates` runs.
    const page = queryPlan(
      db,
      `SELECT id, subscriber, merchant, next_charge, amount, plan_id
         FROM mandates
        WHERE merchant = ? AND status = 'Active'
          AND next_charge BETWEEN ? AND ?
          AND (next_charge > ? OR id > ?)
          AND (max_charges = 0 OR charges_made < max_charges)
        ORDER BY next_charge, id
        LIMIT ?`,
      ["M", -1, 1, -1, -1, 200],
    );
    assert.match(
      page,
      /SEARCH mandates USING INDEX mandates_merchant_status_next_charge \(merchant=\? AND status=\? AND next_charge>\? AND next_charge<\?\)/,
    );
    // The index already yields (next_charge, id) order: no sort step.
    assert.doesNotMatch(page, /TEMP B-TREE/);
    db.close();
  });
});
