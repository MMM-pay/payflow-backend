import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { openDatabase, migrate } from "../src/lib/db.ts";
import { listPlans } from "../src/lib/queries.ts";
import { asStorage } from "../src/lib/store/index.ts";

describe("plan search by name and LIKE escaping", () => {
  test("% in the query is treated literally", async () => {
    const d = openDatabase(":memory:");
    migrate(d);
    d.prepare("INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(1, "M1", "10% Off Plan", "TOKEN", "100", 60, 1, 1);
    d.prepare("INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(2, "M1", "Normal Plan", "TOKEN", "100", 60, 1, 1);

    const res = await listPlans(asStorage(d), { q: "10%", limit: 10 });
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0]?.name, "10% Off Plan");

    const resAll = await listPlans(asStorage(d), { q: "%", limit: 10 });
    assert.equal(resAll.rows.length, 1);
    assert.equal(resAll.rows[0]?.name, "10% Off Plan");
  });
});
