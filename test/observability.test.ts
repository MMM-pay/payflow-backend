/**
 * Tests for issues #286, #287, #288, #289:
 *   #286 - HTTP request duration histograms per route
 *   #287 - Database query timing instrumentation
 *   #288 - OpenTelemetry traces for indexer, keeper and storage
 *   #289 - Structured logs with consistent component field
 */
import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { Writable } from "node:stream";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { MetricsRegistry } from "../src/lib/metrics.ts";
import { timedStorage } from "../src/lib/store/index.ts";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import { traceStore, initTelemetry } from "../src/lib/telemetry.ts";
import { childLogger, redact } from "../src/lib/logger.ts";
import { createApp } from "../src/app.ts";
import { metrics } from "../src/lib/metrics.ts";
import type { Config, NetworkConfig } from "../src/config.ts";

const testnet: NetworkConfig = {
  name: "testnet",
  rpcUrl: "https://rpc.invalid",
  networkPassphrase: "Test SDF Network ; September 2015",
  planRegistryId: "C".repeat(56),
  vaultId: "C".repeat(56),
  subscriptionId: "C".repeat(56),
  startLedger: 0,
  databasePath: ":memory:",
};

// ---------------------------------------------------------------------------
// #286 — Histogram rendering
// ---------------------------------------------------------------------------

describe("MetricsRegistry histograms (issue #286)", () => {
  test("observe accumulates count and sum in a histogram", () => {
    const reg = new MetricsRegistry();
    reg.observe("http_request_duration_seconds", 0.05, { method: "GET", route: "/health", status_class: "2xx" });
    reg.observe("http_request_duration_seconds", 0.1, { method: "GET", route: "/health", status_class: "2xx" });
    const v = reg.histogramValue("http_request_duration_seconds", { method: "GET", route: "/health", status_class: "2xx" });
    assert.ok(v, "histogram sample exists");
    assert.equal(v!.count, 2);
    assert.ok(Math.abs(v!.sum - 0.15) < 1e-9, `sum should be ~0.15, got ${v!.sum}`);
  });

  test("render emits HELP, TYPE and bucket lines for histograms", () => {
    const reg = new MetricsRegistry();
    reg.observe("http_request_duration_seconds", 0.05, { method: "GET", route: "/health", status_class: "2xx" });
    const text = reg.render();

    assert.match(text, /^# HELP payflow_http_request_duration_seconds /m);
    assert.match(text, /^# TYPE payflow_http_request_duration_seconds histogram$/m);
    // A bucket for le="0.05" should have count 1
    assert.match(
      text,
      /payflow_http_request_duration_seconds_bucket\{[^}]*le="0\.05"[^}]*\} 1/m,
    );
    // The +Inf bucket always equals count
    assert.match(
      text,
      /payflow_http_request_duration_seconds_bucket\{[^}]*le="\+Inf"[^}]*\} 1/m,
    );
    assert.match(text, /payflow_http_request_duration_seconds_count\{/m);
    assert.match(text, /payflow_http_request_duration_seconds_sum\{/m);
  });

  test("render emits HELP/TYPE for histograms with no observations", () => {
    const reg = new MetricsRegistry();
    const text = reg.render();
    assert.match(text, /^# HELP payflow_http_request_duration_seconds /m);
    assert.match(text, /^# TYPE payflow_http_request_duration_seconds histogram$/m);
    assert.match(text, /^# HELP payflow_db_query_duration_seconds /m);
    assert.match(text, /^# TYPE payflow_db_query_duration_seconds histogram$/m);
  });

  test("bucket counts are cumulative: a value ≤ X increments all buckets for Y ≥ X", () => {
    const reg = new MetricsRegistry();
    // 0.03 s falls into every bucket ≥ 0.025
    reg.observe("http_request_duration_seconds", 0.03, {});
    const text = reg.render();
    // le="0.025" should be 0 (0.03 > 0.025)
    assert.match(text, /payflow_http_request_duration_seconds_bucket\{le="0\.025"\} 0/m);
    // le="0.05" should be 1 (0.03 ≤ 0.05)
    assert.match(text, /payflow_http_request_duration_seconds_bucket\{le="0\.05"\} 1/m);
  });
});

// ---------------------------------------------------------------------------
// #287 — DB query timing via timedStorage
// ---------------------------------------------------------------------------

describe("timedStorage (issue #287)", () => {
  test("records a histogram observation for each db operation", async () => {
    metrics.reset();
    const storage = SqliteStorage.open(":memory:");
    const timed = timedStorage(storage);
    try {
      await timed.get("SELECT 1 AS n");
      const v = metrics.histogramValue("db_query_duration_seconds", { op: "get", dialect: "sqlite" });
      assert.ok(v, "histogram sample exists after get()");
      assert.equal(v!.count, 1);
      assert.ok(v!.sum > 0, "sum should be positive");
    } finally {
      await timed.close();
      metrics.reset();
    }
  });

  test("labels operation and dialect correctly for all, get and run", async () => {
    metrics.reset();
    const storage = SqliteStorage.open(":memory:");
    const timed = timedStorage(storage);
    try {
      await timed.all("SELECT 1 AS n");
      await timed.get("SELECT 1 AS n");
      await timed.run("SELECT 1");

      assert.equal(
        metrics.histogramValue("db_query_duration_seconds", { op: "all", dialect: "sqlite" })?.count,
        1,
        "all() recorded",
      );
      assert.equal(
        metrics.histogramValue("db_query_duration_seconds", { op: "get", dialect: "sqlite" })?.count,
        1,
        "get() recorded",
      );
      assert.equal(
        metrics.histogramValue("db_query_duration_seconds", { op: "run", dialect: "sqlite" })?.count,
        1,
        "run() recorded",
      );
    } finally {
      await timed.close();
      metrics.reset();
    }
  });

  test("operations inside a transaction are also timed", async () => {
    metrics.reset();
    const storage = SqliteStorage.open(":memory:");
    const timed = timedStorage(storage);
    try {
      await timed.transaction(async (tx) => {
        await tx.get("SELECT 1 AS n");
      });
      const v = metrics.histogramValue("db_query_duration_seconds", { op: "get", dialect: "sqlite" });
      assert.ok(v, "inner transaction get() was timed");
      assert.equal(v!.count, 1);
    } finally {
      await timed.close();
      metrics.reset();
    }
  });
});

// ---------------------------------------------------------------------------
// #288 — traceStore: OTel spans for DB operations
// ---------------------------------------------------------------------------

describe("traceStore (issue #288)", () => {
  test("wraps DB operations in spans when tracing is enabled", async () => {
    interface Span { name: string }
    interface Payload { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }
    const bodies: Payload[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw) as Payload);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const stop = initTelemetry(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

    const storage = SqliteStorage.open(":memory:");
    const traced = traceStore(storage);
    try {
      await traced.get("SELECT 1 AS n");
    } finally {
      await traced.close();
    }
    await stop();
    server.close();

    const spans = bodies.flatMap((b) =>
      b.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)),
    );
    assert.ok(
      spans.some((s) => s.name === "db.get"),
      `expected a db.get span; got: ${spans.map((s) => s.name).join(", ")}`,
    );
  });

  test("does not interfere with DB operations when tracing is off", async () => {
    const storage = SqliteStorage.open(":memory:");
    const traced = traceStore(storage);
    try {
      const row = await traced.get<{ n: number }>("SELECT 42 AS n");
      assert.equal(row?.n, 42);
    } finally {
      await traced.close();
    }
  });
});

// ---------------------------------------------------------------------------
// #286 — HTTP route duration histogram wired in app.ts
// ---------------------------------------------------------------------------

describe("HTTP request duration histogram (issue #286)", () => {
  let server: Server;
  let base = "";
  const appDb = SqliteStorage.open(":memory:");

  before(async () => {
    metrics.reset();
    const app = createApp(
      [{ config: testnet, db: appDb }],
      { CORS_ORIGIN: "*", METRICS_ENABLED: true } as unknown as Config,
    );
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
    metrics.reset();
  });

  test("/metrics output includes histogram HELP and TYPE lines", async () => {
    await fetch(`${base}/health`);
    const body = await (await fetch(`${base}/metrics`)).text();
    assert.match(body, /^# HELP payflow_http_request_duration_seconds /m);
    assert.match(body, /^# TYPE payflow_http_request_duration_seconds histogram$/m);
  });

  test("a completed request records a duration histogram observation", async () => {
    metrics.reset();
    await fetch(`${base}/health`);
    const v = metrics.histogramValue("http_request_duration_seconds", {
      method: "GET",
      route: "/health",
      status_class: "2xx",
    });
    assert.ok(v, "histogram sample recorded after GET /health");
    assert.equal(v!.count, 1);
    assert.ok(v!.sum > 0, "latency should be positive");
  });
});

// ---------------------------------------------------------------------------
// #289 — childLogger attaches a component field
// ---------------------------------------------------------------------------

describe("childLogger (issue #289)", () => {
  test("every log line emitted by a child logger carries the component field", () => {
    let out = "";
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const log = pino({ redact }, sink);
    const child = log.child({ component: "indexer" }) as typeof log;
    child.info({ ledger: 42 }, "tick started");
    const record = JSON.parse(out) as Record<string, unknown>;
    assert.equal(record.component, "indexer");
    assert.equal(record.ledger, 42);
  });

  test("childLogger returns a child logger whose bindings include the component", () => {
    const child = childLogger("keeper");
    // pino child loggers expose their fixed bindings through bindings()
    const bindings = (child as unknown as { bindings: () => Record<string, unknown> }).bindings();
    assert.equal(bindings.component, "keeper");
    assert.equal(typeof child.info, "function");
    assert.equal(typeof child.warn, "function");
  });
});
