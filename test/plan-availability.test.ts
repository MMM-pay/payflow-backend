import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import type { Config } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import { testAddress } from "./addresses.ts";

const config = { CORS_ORIGIN: "*" } as unknown as Config;
interface Body {
  plans: { id: number; open: boolean }[];
  open: boolean;
  error: { code: string; message: string; details: { path: string; message: string }[] };
}
const MERCHANT = testAddress(70);

const ev = (name: string, topics: unknown[], data: Record<string, unknown>): DecodedEvent => ({
  name, contractId: "C", ledger: 1, txHash: "t", topics, data,
});

describe("plan availability, gone plans and malformed cursors", () => {
  const db = openDatabase(":memory:");
  let server: Server;
  let base = "";

  before(async () => {
    const ix = new Indexer(db, {} as never, {} as never);
    for (const id of [1n, 2n]) {
      await ix.apply(ev("plan_created", [MERCHANT, id], {
        token: "C", amount: 10_000_000n, period: 2_592_000n, name: `Plan ${id}`,
      }));
    }
    await ix.apply(ev("plan_status_changed", [MERCHANT, 2n], { active: false }));
    const app = createApp(db, config);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    server.close();
    db.close();
  });

  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: (await res.json()) as Body };
  };

  test("an open plan reports open: true and a closed plan open: false in lists", async () => {
    const { status, body } = await get(`/api/plans?merchant=${MERCHANT}`);
    assert.equal(status, 200);
    const byId = new Map(body.plans.map((p) => [p.id, p]));
    assert.equal(byId.get(1)?.open, true);
    assert.equal(byId.get(2)?.open, false);
  });

  test("GET /plans/:id reports open for an open plan", async () => {
    const { status, body } = await get("/api/plans/1");
    assert.equal(status, 200);
    assert.equal(body.open, true);
  });

  test("a deactivated plan is 410 plan_gone, a never-existing one 404", async () => {
    for (const path of ["/api/plans/2", "/api/plans/2/stats"]) {
      const gone = await get(path);
      assert.equal(gone.status, 410, path);
      assert.equal(gone.body.error.code, "plan_gone");
    }
    for (const path of ["/api/plans/999", "/api/plans/999/stats"]) {
      const missing = await get(path);
      assert.equal(missing.status, 404, path);
      assert.equal(missing.body.error.code, "plan_not_found");
    }
  });

  test("a malformed cursor is a 400 invalid_request naming the cursor, never a 500", async () => {
    const notBase64Json = Buffer.from("not json").toString("base64url");
    const wrongShape = Buffer.from(JSON.stringify({ id: "1" })).toString("base64url");
    const negative = Buffer.from(JSON.stringify({ id: -5 })).toString("base64url");
    for (const cursor of ["not-a-cursor", "AAAA", notBase64Json, wrongShape, negative]) {
      for (const path of ["/api/plans", "/api/mandates"]) {
        const { status, body } = await get(`${path}?cursor=${encodeURIComponent(cursor)}`);
        assert.equal(status, 400, `${path} ${cursor}`);
        assert.equal(body.error.code, "invalid_request");
        assert.equal(typeof body.error.message, "string");
        assert.equal(body.error.details[0]!.path, "cursor");
        assert.ok(body.error.details[0]!.message.length > 0);
      }
    }
  });
});
