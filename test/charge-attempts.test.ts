import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { openDatabase } from "../src/lib/db.ts";
import { asStorage } from "../src/lib/store/index.ts";
import { mandatesRouter } from "../src/routes/mandates.ts";
import type { TokenMetadataService } from "../src/lib/tokens.ts";
import type { ChargeAttemptPage } from "../src/routes/types.ts";

/**
 * `GET /api/mandates/:id/attempts` (#144): the keeper's attempts to charge
 * one mandate, so support can answer "why wasn't I charged?".
 */

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const TX = "ab".repeat(32);

describe("mandate charge attempts", () => {
  const db = openDatabase(":memory:");
  let server: Server;
  let base = "";

  before(async () => {
    const mandate = db.prepare(
      `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
       VALUES (?, ?, ?, 1, '1000', 60, 1000, 'Active', 1)`,
    );
    mandate.run(1, SUBSCRIBER, MERCHANT);
    mandate.run(2, SUBSCRIBER, MERCHANT);
    const attempt = db.prepare(
      `INSERT INTO charge_attempts
         (mandate_id, attempted_at, result, error_code, tx_hash, shortfall, failures, retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    attempt.run(1, 10_000, "skipped", "INSUFFICIENT_BALANCE", null, "600", 1, 10_060);
    attempt.run(2, 10_010, "failed", "txBadSeq", null, null, 1, 10_070);
    attempt.run(1, 10_060, "failed", "Error(Contract, #3)", null, null, 2, 10_180);
    attempt.run(1, 10_180, "settled", null, TX, null, 0, null);

    const app = express();
    app.use("/api", mandatesRouter(asStorage(db), {} as TokenMetadataService));
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  test("lists one mandate's attempts newest first", async () => {
    const res = await fetch(`${base}/api/mandates/1/attempts`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as ChargeAttemptPage;
    assert.deepEqual(
      body.attempts.map(({ id: _id, ...rest }) => rest),
      [
        {
          mandateId: 1,
          attemptedAt: 10_180,
          result: "settled",
          errorCode: null,
          txHash: TX,
          failures: 0,
          retryAt: null,
        },
        {
          mandateId: 1,
          attemptedAt: 10_060,
          result: "failed",
          errorCode: "Error(Contract, #3)",
          txHash: null,
          failures: 2,
          retryAt: 10_180,
        },
        {
          mandateId: 1,
          attemptedAt: 10_000,
          result: "skipped",
          errorCode: "INSUFFICIENT_BALANCE",
          txHash: null,
          // Only a skipped attempt knows what the vault was missing.
          shortfall: "600",
          failures: 1,
          retryAt: 10_060,
        },
      ],
    );
  });

  test("limit caps the page", async () => {
    const body = (await (await fetch(`${base}/api/mandates/1/attempts?limit=1`)).json()) as ChargeAttemptPage;
    assert.deepEqual(body.attempts.map((a) => a.attemptedAt), [10_180]);
  });

  test("a mandate the keeper never tried has an empty history", async () => {
    db.prepare(
      `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
       VALUES (3, ?, ?, 1, '1000', 60, 1000, 'Active', 1)`,
    ).run(SUBSCRIBER, MERCHANT);
    const body = (await (await fetch(`${base}/api/mandates/3/attempts`)).json()) as ChargeAttemptPage;
    assert.deepEqual(body.attempts, []);
  });

  test("an unknown mandate is a 404 and a malformed id a 400", async () => {
    assert.equal((await fetch(`${base}/api/mandates/999/attempts`)).status, 404);
    assert.equal((await fetch(`${base}/api/mandates/abc/attempts`)).status, 400);
    assert.equal((await fetch(`${base}/api/mandates/1/attempts?limit=0`)).status, 400);
  });
});
