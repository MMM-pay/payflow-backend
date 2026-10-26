import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { openDatabase } from "../src/lib/db.ts";

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

describe("report query indexes", () => {
  test("ranking plans by active mandates counts each plan from a covering index", () => {
    const db = openDatabase(":memory:");
    // The statement `listPlansBySubscribers` runs, unfiltered and by merchant.
    const ranked = (where: string, args: unknown[]) =>
      queryPlan(
        db,
        `SELECT * FROM plans ${where}
          ORDER BY (SELECT COUNT(*) FROM mandates m
                     WHERE m.plan_id = plans.id AND m.status = 'Active') DESC,
                   id ASC
          LIMIT ?`,
        [...args, 10],
      );
    for (const plan of [ranked("", []), ranked("WHERE merchant = ?", ["M"])]) {
      assert.match(plan, /SEARCH m USING COVERING INDEX mandates_plan_status \(plan_id=\? AND status=\?\)/);
      assert.doesNotMatch(plan, /SCAN m\b/);
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
