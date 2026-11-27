import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDatabase } from "../src/lib/db.ts";

/**
 * Security headers on every response.
 *
 * The API is JSON, but error bodies, the health payload and the documentation
 * page are all reachable from a browser. Each of them must carry the strict
 * policy, `nosniff` (so a JSON body can never be interpreted as HTML), frame
 * denial and no referrer — including when the route does not exist.
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

function assertSecurityHeaders(res: Response, label: string): void {
  assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${label}: nosniff`);
  assert.equal(res.headers.get("x-frame-options"), "DENY", `${label}: frame denial`);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer", `${label}: no referrer`);
  assert.match(
    res.headers.get("strict-transport-security") ?? "",
    /max-age=\d+/,
    `${label}: HSTS`,
  );
  assert.equal(res.headers.get("x-powered-by"), null, `${label}: framework is not advertised`);

  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/, `${label}: default-src`);
  assert.match(csp, /frame-ancestors 'none'/, `${label}: framing refused by the CSP`);
  assert.match(csp, /object-src 'none'/, `${label}: plugins refused`);
  assert.match(csp, /script-src 'self'/, `${label}: scripts are same-origin`);
  assert.doesNotMatch(csp, /unsafe-eval/, `${label}: no eval`);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, `${label}: no inline script`);
}

describe("security headers", () => {
  test("are set on a successful API response", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assertSecurityHeaders(res, "health");
  });

  test("are set on an error response", async () => {
    const res = await fetch(`${base}/api/v1/no-such-route`);
    assert.equal(res.status, 404);
    assertSecurityHeaders(res, "404");
  });

  test("are set on every versioned and unversioned API answer", async () => {
    for (const path of ["/api/v1/plans", "/version", "/sync"]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assertSecurityHeaders(res, path);
    }
  });

  test("the documentation page widens only the worker directive", async () => {
    const res = await fetch(`${base}/api/docs`);
    assert.equal(res.status, 200);
    assertSecurityHeaders(res, "docs");

    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /worker-src 'self' blob:/, "ReDoc's Blob worker is allowed");
  });
});
