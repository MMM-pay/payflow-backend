import assert from "node:assert/strict";
import { test, describe } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import type { AdminHooks } from "../src/routes/admin.ts";

const TOKEN = "operator-token-for-tests";

function testConfig(adminToken?: string): Config {
  return {
    STELLAR_NETWORK: "testnet",
    PLAN_REGISTRY_ID: "C".repeat(56),
    VAULT_ID: "C".repeat(56),
    SUBSCRIPTION_ID: "C".repeat(56),
    CORS_ORIGIN: "*",
    PORT: 0,
    ADMIN_TOKEN: adminToken,
  } as unknown as Config;
}

async function startApp(
  config: Config,
  hooks?: AdminHooks,
): Promise<{ base: string; stop: () => void }> {
  const db = openDatabase(":memory:");
  const app = createApp(db, config, undefined, hooks);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => {
      server.close();
      db.close();
    },
  };
}

const call = async (
  base: string,
  method: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(base + path, {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("admin routes", () => {
  test("are absent unless ADMIN_TOKEN is set", async () => {
    const app = await startApp(testConfig(), {
      reindex: async () => ({}),
      keeperPass: async () => [],
      keeperBackoff: () => [],
    });
    try {
      // Even a caller presenting some token gets nothing: the routes are not
      // mounted at all when no token is configured.
      const reindex = await call(app.base, "POST", "/admin/reindex", TOKEN);
      assert.equal(reindex.status, 404);
      assert.equal((reindex.body.error as { code: string }).code, "not_found");

      const backoff = await call(app.base, "GET", "/admin/keeper/backoff", TOKEN);
      assert.equal(backoff.status, 404);
    } finally {
      app.stop();
    }
  });

  test("reject requests without the bearer token", async () => {
    const app = await startApp(testConfig(TOKEN), { reindex: async () => ({ applied: 0 }) });
    try {
      const missing = await call(app.base, "POST", "/admin/reindex");
      assert.equal(missing.status, 401);
      assert.equal((missing.body.error as { code: string }).code, "unauthorized");

      const wrong = await call(app.base, "POST", "/admin/reindex", "not-the-token");
      assert.equal(wrong.status, 401);

      const bare = await fetch(`${app.base}/admin/reindex`, {
        method: "POST",
        headers: { authorization: TOKEN },
      });
      assert.equal(bare.status, 401);
    } finally {
      app.stop();
    }
  });

  test("run a reindex pass for a caller with the token", async () => {
    let calls = 0;
    const app = await startApp(testConfig(TOKEN), {
      reindex: async () => {
        calls += 1;
        return { applied: 2, cursor: 1_234 };
      },
    });
    try {
      const { status, body } = await call(app.base, "POST", "/admin/reindex", TOKEN);
      assert.equal(status, 200);
      assert.equal(body.status, "ok");
      assert.deepEqual(body.result, { applied: 2, cursor: 1_234 });
      assert.equal(calls, 1);
    } finally {
      app.stop();
    }
  });

  test("run a keeper pass and read the backoff list", async () => {
    const app = await startApp(testConfig(TOKEN), {
      reindex: async () => ({}),
      keeperPass: async () => [{ mandateId: 7, status: "settled", txHash: "abc" }],
      keeperBackoff: () => [{ mandateId: 7, failures: 2, retryAt: 100, retryIn: 40 }],
    });
    try {
      const run = await call(app.base, "POST", "/admin/keeper/run", TOKEN);
      assert.equal(run.status, 200);
      assert.deepEqual(run.body.result, [{ mandateId: 7, status: "settled", txHash: "abc" }]);

      const backoff = await call(app.base, "GET", "/admin/keeper/backoff", TOKEN);
      assert.equal(backoff.status, 200);
      assert.deepEqual(backoff.body.backoff, [{ mandateId: 7, failures: 2, retryAt: 100, retryIn: 40 }]);
    } finally {
      app.stop();
    }
  });

  test("say the keeper is unavailable when it is not running", async () => {
    const app = await startApp(testConfig(TOKEN), { reindex: async () => ({}) });
    try {
      const run = await call(app.base, "POST", "/admin/keeper/run", TOKEN);
      assert.equal(run.status, 503);
      assert.equal((run.body.error as { code: string }).code, "keeper_unavailable");

      const backoff = await call(app.base, "GET", "/admin/keeper/backoff", TOKEN);
      assert.equal(backoff.status, 503);
      assert.equal((backoff.body.error as { code: string }).code, "keeper_unavailable");
    } finally {
      app.stop();
    }
  });

  test("say reindex is unavailable when the process lacks it", async () => {
    const app = await startApp(testConfig(TOKEN), {});
    try {
      const { status, body } = await call(app.base, "POST", "/admin/reindex", TOKEN);
      assert.equal(status, 503);
      assert.equal((body.error as { code: string }).code, "reindex_unavailable");
    } finally {
      app.stop();
    }
  });

  test("report a failed pass as 500 with its message", async () => {
    const app = await startApp(testConfig(TOKEN), {
      reindex: async () => {
        throw new Error("rpc unreachable");
      },
    });
    try {
      const { status, body } = await call(app.base, "POST", "/admin/reindex", TOKEN);
      assert.equal(status, 500);
      const err = body.error as { code: string; message: string; requestId: string | null };
      assert.equal(err.code, "reindex_failed");
      assert.equal(err.message, "rpc unreachable");
      assert.ok(typeof err.requestId === "string" && err.requestId.length > 0);
    } finally {
      app.stop();
    }
  });

  test("pause and resume the indexer at runtime", async () => {
    let paused = false;
    const app = await startApp(testConfig(TOKEN), {
      pauseIndexer: () => {
        paused = true;
        return null;
      },
      resumeIndexer: () => {
        paused = false;
        return null;
      },
    });
    try {
      const pause = await call(app.base, "POST", "/admin/indexer/pause", TOKEN);
      assert.equal(pause.status, 200);
      assert.equal(pause.body.paused, true);
      assert.equal(paused, true);

      const resume = await call(app.base, "POST", "/admin/indexer/resume", TOKEN);
      assert.equal(resume.status, 200);
      assert.equal(resume.body.paused, false);
      assert.equal(paused, false);
    } finally {
      app.stop();
    }
  });

  test("say the indexer is unavailable when the process cannot control it", async () => {
    const app = await startApp(testConfig(TOKEN), { reindex: async () => ({}) });
    try {
      const { status, body } = await call(app.base, "POST", "/admin/indexer/pause", TOKEN);
      assert.equal(status, 503);
      assert.equal((body.error as { code: string }).code, "indexer_unavailable");
    } finally {
      app.stop();
    }
  });

  test("reject an unauthenticated pause before running the hook", async () => {
    let paused = false;
    const app = await startApp(testConfig(TOKEN), {
      pauseIndexer: () => {
        paused = true;
        return null;
      },
    });
    try {
      const { status, body } = await call(app.base, "POST", "/admin/indexer/pause");
      assert.equal(status, 401);
      assert.equal((body.error as { code: string }).code, "unauthorized");
      assert.equal(paused, false);
    } finally {
      app.stop();
    }
  });
});
