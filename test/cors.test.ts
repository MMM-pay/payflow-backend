import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Server } from "node:http";
import { StrKey } from "@stellar/stellar-sdk";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { openDatabase } from "../src/lib/db.ts";

/**
 * CORS is pinned to the origins an operator listed, not to whoever asks.
 *
 * A browser sends `Origin: scheme://host[:port]`; the middleware reflects it
 * only on an exact match with `CORS_ORIGIN`. Anything else gets no
 * `Access-Control-Allow-Origin`, so the browser refuses to hand the response
 * to the calling script. SEP-10 is the one exception the spec requires.
 */

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32));
const BASE_ENV = {
  PLAN_REGISTRY_ID: CONTRACT,
  VAULT_ID: CONTRACT,
  SUBSCRIPTION_ID: CONTRACT,
};

const ALLOWED = "https://app.example";
const STRAY = "https://evil.example";

interface Running {
  base: string;
  close: () => void;
}

async function serve(config: Config): Promise<Running> {
  const db = openDatabase(":memory:");
  const app = createApp(db, config);
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  return {
    base: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
    close: () => {
      server.close();
      db.close();
    },
  };
}

describe("CORS allowlist", () => {
  let running: Running;

  before(async () => {
    running = await serve({ CORS_ORIGIN: [ALLOWED] } as unknown as Config);
  });

  after(() => running.close());

  test("reflects an origin the operator listed", async () => {
    const res = await fetch(`${running.base}/health`, { headers: { origin: ALLOWED } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
    assert.match(res.headers.get("vary") ?? "", /origin/i, "the response varies by Origin");
  });

  test("a site not on the list gets no allow-origin header", async () => {
    const res = await fetch(`${running.base}/health`, { headers: { origin: STRAY } });
    assert.equal(res.status, 200, "the request itself is served; the browser enforces CORS");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  test("a preflight from an unlisted origin is not approved", async () => {
    const res = await fetch(`${running.base}/api/v1/plans`, {
      method: "OPTIONS",
      headers: {
        origin: STRAY,
        "access-control-request-method": "GET",
      },
    });
    assert.equal(res.status, 204);
    // The decisive header is the origin: without it the browser refuses the
    // actual request, whatever methods the preflight response lists.
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  test("a preflight from a listed origin is approved", async () => {
    const res = await fetch(`${running.base}/api/v1/plans`, {
      method: "OPTIONS",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "GET",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /GET/);
  });

  test("error responses carry the same decision, so a script can read them", async () => {
    const allowed = await fetch(`${running.base}/no-such-route`, { headers: { origin: ALLOWED } });
    assert.equal(allowed.status, 404);
    assert.equal(allowed.headers.get("access-control-allow-origin"), ALLOWED);

    const stray = await fetch(`${running.base}/no-such-route`, { headers: { origin: STRAY } });
    assert.equal(stray.status, 404);
    assert.equal(stray.headers.get("access-control-allow-origin"), null);
  });

  test("SEP-10 endpoints stay open to every wallet, as the spec requires", async () => {
    const res = await fetch(`${running.base}/api/v1/auth?account=GABC`, {
      headers: { origin: STRAY },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});

describe("CORS defaults", () => {
  test("without CORS_ORIGIN no cross-origin site is allowed", async () => {
    const running = await serve({} as unknown as Config);
    try {
      const res = await fetch(`${running.base}/health`, { headers: { origin: ALLOWED } });
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    } finally {
      running.close();
    }
  });

  test("an explicit wildcard allows every origin", async () => {
    const running = await serve({ CORS_ORIGIN: "*" } as unknown as Config);
    try {
      const res = await fetch(`${running.base}/health`, { headers: { origin: STRAY } });
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
    } finally {
      running.close();
    }
  });
});

describe("CORS_ORIGIN configuration", () => {
  test("defaults to an empty allowlist", () => {
    assert.deepEqual(loadConfig({ ...BASE_ENV }).CORS_ORIGIN, []);
  });

  test("splits, trims, normalises and deduplicates origins", () => {
    const parsed = loadConfig({
      ...BASE_ENV,
      CORS_ORIGIN: ` ${ALLOWED}/ , https://api.example:8443,${ALLOWED} `,
    });
    assert.deepEqual(parsed.CORS_ORIGIN, [ALLOWED, "https://api.example:8443"]);
  });

  test("a wildcard stays the whole value", () => {
    assert.equal(loadConfig({ ...BASE_ENV, CORS_ORIGIN: "*" }).CORS_ORIGIN, "*");
  });

  test("rejects entries that can never match a browser Origin", () => {
    for (const value of [
      `${ALLOWED}/path`,
      `${ALLOWED}?query=1`,
      "ftp://app.example",
      "https://user:pass@app.example",
      "https://*.app.example",
      `${ALLOWED},*`,
      "not-a-url",
    ]) {
      assert.throws(
        () => loadConfig({ ...BASE_ENV, CORS_ORIGIN: value }),
        /CORS_ORIGIN/,
        value,
      );
    }
  });
});
