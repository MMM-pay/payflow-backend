import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";

/**
 * The human-readable API reference.
 *
 * It has to work without reaching the network: the page, its bootstrap and
 * ReDoc's bundle are all served by the app, and the CSP is only widened for
 * the Blob worker ReDoc creates.
 */

const config = { CORS_ORIGIN: "*" } as unknown as Config;
const db = openDatabase(":memory:");
let server: Server;
let base = "";

before(async () => {
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

describe("GET /api/docs", () => {
  test("serves a readable HTML page that references only local scripts", async () => {
    const res = await fetch(`${base}/api/docs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);

    const page = await res.text();
    assert.match(page, /redoc-container/);
    assert.match(page, /type="module" src="\/api\/docs\/docs\.js"/);
    // No third-party CDN at runtime: every script is same-origin.
    assert.doesNotMatch(page, /<script[^>]+src="https?:\/\//);
  });

  test("serves the bootstrap that points ReDoc at this instance's spec", async () => {
    const res = await fetch(`${base}/api/docs/docs.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    const script = await res.text();
    assert.match(script, /import \{ init \} from "\/api\/docs\/redoc\.standalone\.js"/);
    assert.match(script, /init\("\/api\/openapi\.json"/);
  });

  test("serves the ReDoc bundle itself", async () => {
    const res = await fetch(`${base}/api/docs/redoc.standalone.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    assert.match(await res.text(), /Redoc/);
  });

  test("widens the CSP only for ReDoc's Blob worker", async () => {
    const res = await fetch(`${base}/api/docs`);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /worker-src 'self' blob:/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.doesNotMatch(csp, /unsafe-inline[^;]*script/);
  });
});
