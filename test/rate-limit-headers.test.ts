import assert from "node:assert/strict";
import { test, describe } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { testAddress } from "./addresses.ts";

/**
 * The rate limiter is configured with `standardHeaders: "draft-8"`, so a
 * response carries two fields:
 *
 *   RateLimit: "120-in-1min"; r=119; t=60
 *   RateLimit-Policy: "120-in-1min"; q=120; w=60; pk=:<id>:
 *
 * `r` is the quota remaining and `t` the seconds until the window resets; the
 * policy field carries the window's quota `q` and window length `w` in
 * seconds. A rate-limited response is additionally `429` and carries
 * `Retry-After`. These tests pin that contract down, including on the paths
 * where a request is refused before any route runs or fails to find a route.
 */

type HttpResponse = Awaited<ReturnType<typeof fetch>>;

/** A merged error envelope, as every non-2xx response returns. */
interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string | null;
    details?: { path: string; message: string }[];
  };
}

/**
 * Read the draft-8 `RateLimit` field.
 *
 * Every assertion here is deliberately strict: a dropped header, a renamed
 * parameter or a quota that is reported as a number this API never promised
 * should fail the test, not be papered over by a fallback.
 */
function rateLimitOf(res: HttpResponse): { remaining: number; resetSeconds: number } {
  const value = res.headers.get("ratelimit");
  assert.ok(value, "the RateLimit header is missing");
  assert.match(value, /^"[^"]+";/, `RateLimit has no quoted policy name: ${value}`);

  const remaining = /;\s*r=(\d+)/.exec(value)?.[1];
  const reset = /;\s*t=(\d+)/.exec(value)?.[1];
  assert.ok(remaining !== undefined, `RateLimit has no r (remaining) parameter: ${value}`);
  assert.ok(reset !== undefined, `RateLimit has no t (reset) parameter: ${value}`);
  return { remaining: Number(remaining), resetSeconds: Number(reset) };
}

/** Read the draft-8 `RateLimit-Policy` field, which states the configured window. */
function policyOf(res: HttpResponse): { quota: number; windowSeconds: number } {
  const value = res.headers.get("ratelimit-policy");
  assert.ok(value, "the RateLimit-Policy header is missing");

  const quota = /;\s*q=(\d+)/.exec(value)?.[1];
  const windowSeconds = /;\s*w=(\d+)/.exec(value)?.[1];
  assert.ok(quota !== undefined, `RateLimit-Policy has no q (quota) parameter: ${value}`);
  assert.ok(windowSeconds !== undefined, `RateLimit-Policy has no w (window) parameter: ${value}`);
  return { quota: Number(quota), windowSeconds: Number(windowSeconds) };
}

/** Parse `Retry-After` as whole seconds and check it lies inside the window. */
function retryAfterOf(res: HttpResponse, windowSeconds: number): number {
  const value = res.headers.get("retry-after");
  assert.ok(value, "a rate-limited response must carry Retry-After");
  assert.match(value, /^\d+$/, `Retry-After must be whole seconds, got ${value}`);
  const seconds = Number(value);
  assert.ok(
    seconds >= 1 && seconds <= windowSeconds,
    `Retry-After ${seconds}s is outside the ${windowSeconds}s window`,
  );
  return seconds;
}

/**
 * Start a throwaway app on an ephemeral loopback port for one test.
 *
 * Each call gets its own in-memory database and its own `express-rate-limit`
 * store, so tests cannot inherit a used-up quota from each other (or from the
 * seeded app the other API tests share). The port is chosen by the OS and the
 * server is closed in `finally`, so nothing here depends on a fixed port, on
 * the network, or on test ordering.
 */
async function withApp(
  overrides: Partial<Config>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const app = createApp(openDatabase(":memory:"), {
    CORS_ORIGIN: "*",
    ...overrides,
  } as unknown as Config);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("rate-limited responses", () => {
  test("answer 429 with the structured envelope, RateLimit headers and Retry-After", async () => {
    await withApp(
      { API_RATE_LIMIT_MAX: 2, API_RATE_LIMIT_WINDOW_MS: 60_000 },
      async (base) => {
        // Spend the whole quota; the limiter counts every request, not just
        // the ones that reach a route.
        for (let i = 0; i < 2; i += 1) {
          const allowed = await fetch(`${base}/api/plans`);
          assert.equal(allowed.status, 200);
          await allowed.arrayBuffer();
        }

        const res = await fetch(`${base}/api/plans`);
        assert.equal(res.status, 429, "the request past the quota must be refused");

        const { remaining, resetSeconds } = rateLimitOf(res);
        assert.equal(remaining, 0, "a refused request has no quota remaining");
        assert.ok(
          resetSeconds >= 1 && resetSeconds <= 60,
          `reset in ${resetSeconds}s is outside the 60s window`,
        );

        const policy = policyOf(res);
        assert.equal(policy.quota, 2);
        assert.equal(policy.windowSeconds, 60);
        retryAfterOf(res, 60);

        // `legacyHeaders: false` is part of the contract: clients read
        // `RateLimit`, not the older `X-RateLimit-*` family.
        assert.equal(res.headers.get("x-ratelimit-limit"), null);
        assert.equal(res.headers.get("x-ratelimit-remaining"), null);
        assert.equal(res.headers.get("x-ratelimit-reset"), null);

        const body = (await res.json()) as ErrorBody;
        assert.equal(body.error.code, "rate_limited");
        assert.equal(body.error.message, "Too many requests. Try again later.");
        assert.equal(
          body.error.requestId,
          res.headers.get("x-request-id"),
          "the error body must echo the request id header",
        );
      },
    );
  });

  test("advertise the remaining quota on allowed responses, with the configured window", async () => {
    await withApp(
      { API_RATE_LIMIT_MAX: 3, API_RATE_LIMIT_WINDOW_MS: 90_000 },
      async (base) => {
        for (let i = 0; i < 3; i += 1) {
          const res = await fetch(`${base}/api/plans`);
          assert.equal(res.status, 200, "requests up to the quota are served");

          const { remaining, resetSeconds } = rateLimitOf(res);
          assert.equal(remaining, 2 - i, "the header reports what is left after this request");
          assert.ok(
            resetSeconds >= 1 && resetSeconds <= 90,
            `reset in ${resetSeconds}s is outside the 90s window`,
          );

          const policy = policyOf(res);
          assert.equal(policy.quota, 3, "the policy states the configured limit");
          assert.equal(policy.windowSeconds, 90, "the policy states the configured window");
          await res.arrayBuffer();
        }

        assert.equal((await fetch(`${base}/api/plans`)).status, 429);
      },
    );
  });

  test("also cover a 404 under /api: the refusal is not the first error the client sees", async () => {
    await withApp(
      { API_RATE_LIMIT_MAX: 1, API_RATE_LIMIT_WINDOW_MS: 60_000 },
      async (base) => {
        // A miss still runs through the limiter, so it spends the quota and
        // carries the headers — clients must not have to reach a valid route
        // to learn how much quota is left.
        const missing = await fetch(`${base}/api/definitely-not-a-route`);
        assert.equal(missing.status, 404);
        const headers = rateLimitOf(missing);
        assert.equal(headers.remaining, 0);
        assert.equal(policyOf(missing).quota, 1);
        const body = (await missing.json()) as ErrorBody;
        assert.equal(body.error.code, "not_found");

        const refused = await fetch(`${base}/api/definitely-not-a-route`);
        assert.equal(refused.status, 429, "the quota is spent even by requests that 404");
        assert.equal(rateLimitOf(refused).remaining, 0);
        retryAfterOf(refused, 60);
        assert.equal(
          ((await refused.json()) as ErrorBody).error.code,
          "rate_limited",
          "the limiter answers before the router when the quota is gone",
        );
      },
    );
  });

  test("cover the auth path: /api/auth is limited like any other API route", async () => {
    await withApp(
      { API_RATE_LIMIT_MAX: 1, API_RATE_LIMIT_WINDOW_MS: 60_000 },
      async (base) => {
        // SEP-10 is not configured on this app, so the first call is a 404 —
        // but an auth-shaped request must still spend quota, otherwise the
        // one endpoint that mints credentials would be the cheapest to flood.
        const first = await fetch(`${base}/api/auth?account=${testAddress(9)}`);
        assert.equal(first.status, 404);
        assert.equal(rateLimitOf(first).remaining, 0);
        assert.equal((await first.json() as ErrorBody).error.code, "not_found");

        const second = await fetch(`${base}/api/auth`);
        assert.equal(second.status, 429);
        assert.equal(rateLimitOf(second).remaining, 0);
        retryAfterOf(second, 60);
        assert.equal((await second.json() as ErrorBody).error.code, "rate_limited");
      },
    );
  });

  test("do not limit the health and readiness probes", async () => {
    await withApp(
      { API_RATE_LIMIT_MAX: 1, API_RATE_LIMIT_WINDOW_MS: 60_000 },
      async (base) => {
        // Spend the API quota first, so the probe checks below would 429 if
        // the limiter were mounted too broadly.
        assert.equal((await fetch(`${base}/api/plans`)).status, 200);
        assert.equal((await fetch(`${base}/api/plans`)).status, 429);

        for (let i = 0; i < 3; i += 1) {
          const health = await fetch(`${base}/health`);
          assert.equal(health.status, 200, "a liveness probe is always answerable");
          assert.equal(health.headers.get("ratelimit"), null, "/health is outside /api");
          await health.arrayBuffer();
        }

        // 503 until the projection is known to be current; the status is the
        // point here, not readiness, and it must not be a rate-limit refusal.
        const ready = await fetch(`${base}/ready`);
        assert.equal(ready.status, 503);
        assert.equal(ready.headers.get("ratelimit"), null, "/ready is outside /api");
        const body = (await ready.json()) as { status: string };
        assert.equal(body.status, "starting");
      },
    );
  });

  test("share one quota between the versioned and unversioned API aliases", async () => {
    await withApp(
      { API_RATE_LIMIT_MAX: 2, API_RATE_LIMIT_WINDOW_MS: 60_000 },
      async (base) => {
        assert.equal((await fetch(`${base}/api/v1/plans`)).status, 200);
        assert.equal((await fetch(`${base}/api/plans`)).status, 200);

        const refused = await fetch(`${base}/api/v1/plans`);
        assert.equal(refused.status, 429, "switching alias must not hand out a second quota");
        assert.equal(rateLimitOf(refused).remaining, 0);
        retryAfterOf(refused, 60);
        assert.equal((await refused.json() as ErrorBody).error.code, "rate_limited");
      },
    );
  });

  test("count each client IP separately", async () => {
    await withApp(
      { API_RATE_LIMIT_MAX: 1, API_RATE_LIMIT_WINDOW_MS: 60_000 },
      async (base) => {
        assert.equal((await fetch(`${base}/api/plans`)).status, 200);

        const sameClient = await fetch(`${base}/api/plans`);
        assert.equal(sameClient.status, 429);

        // The app trusts exactly one proxy hop, so a forwarded client address
        // is its own bucket. This also proves the test's earlier requests did
        // not leak into another caller's quota.
        const otherClient = await fetch(`${base}/api/plans`, {
          headers: { "x-forwarded-for": "203.0.113.9" },
        });
        assert.equal(otherClient.status, 200, "a different client has its own quota");
        assert.equal(rateLimitOf(otherClient).remaining, 0);
        assert.equal(policyOf(otherClient).quota, 1);
      },
    );
  });

  test("start each app instance with a fresh quota", async () => {
    const config: Partial<Config> = { API_RATE_LIMIT_MAX: 1, API_RATE_LIMIT_WINDOW_MS: 60_000 };

    await withApp(config, async (base) => {
      assert.equal((await fetch(`${base}/api/plans`)).status, 200);
      assert.equal((await fetch(`${base}/api/plans`)).status, 429);
    });

    // The second instance never saw the first one's requests, so a test (or a
    // restarted process) does not start life already rate limited.
    await withApp(config, async (base) => {
      const res = await fetch(`${base}/api/plans`);
      assert.equal(res.status, 200);
      assert.equal(rateLimitOf(res).remaining, 0);
    });
  });
});
