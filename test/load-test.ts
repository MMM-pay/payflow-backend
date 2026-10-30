/** API load test and regression report.
 *
 * Hits the running API with concurrent requests across several endpoints,
 * measures latency, throughput and error rate, and writes a regression report
 * that can be compared against a previous run. The report is appended to
 * `regression-report.md` so each run builds a time series.
 *
 * Usage:
 *   npm run dev &   # start the API on :8080
 *   node --experimental-strip-types test/load-test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.API_BASE ?? "http://localhost:8080";
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? "10");
const DURATION_MS = Number(process.env.LOAD_DURATION_MS ?? "15000");

const ENDPOINTS: string[] = [
  "/health",
  "/ready",
  "/api/plans",
  "/api/mandates?limit=5",
  "/api/due",
  "/api/stats",
  "/api/protocol",
];

interface Sample {
  endpoint: string;
  status: number;
  elapsedMs: number;
}

interface Aggregate {
  requests: number;
  ok: number;
  errors: number;
  minMs: number;
  maxMs: number;
  sumMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  throughputPerSec: number;
}

async function hit(
  endpoint: string,
  signal: AbortSignal,
): Promise<Sample> {
  const start = Date.now();
  let status: number;
  try {
    const res = await fetch(`${BASE}${endpoint}`, { signal });
    status = res.status;
    await res.arrayBuffer();
  } catch {
    status = 0;
  }
  return { endpoint, status, elapsedMs: Date.now() - start };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const frac = rank - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * frac;
}

function aggregate(samples: Sample[]): Aggregate {
  const elapsed = samples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300).length;
  const errors = samples.length - ok;
  const minMs = elapsed[0] ?? 0;
  const maxMs = elapsed[elapsed.length - 1] ?? 0;
  const sumMs = elapsed.reduce((a, b) => a + b, 0);
  const durationSec = DURATION_MS / 1000;
  return {
    requests: samples.length,
    ok,
    errors,
    minMs,
    maxMs,
    sumMs,
    p50Ms: percentile(elapsed, 50),
    p95Ms: percentile(elapsed, 95),
    p99Ms: percentile(elapsed, 99),
    throughputPerSec: samples.length / durationSec,
  };
}

function formatMs(ms: number): string {
  return ms.toFixed(1);
}

function renderReport(result: {
  startedAt: string;
  durationMs: number;
  concurrency: number;
  perEndpoint: Record<string, Aggregate>;
  total: Aggregate;
}): string {
  const lines: string[] = [];
  lines.push(`# API Load Test Report`);
  lines.push(`Started: ${result.startedAt}`);
  lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Concurrency: ${result.concurrency}`);
  lines.push(``);
  lines.push(`| Endpoint | Requests | OK | Errors | Min (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Max (ms) | Req/s |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const [endpoint, agg] of Object.entries(result.perEndpoint)) {
    lines.push(
      `| ${endpoint} | ${agg.requests} | ${agg.ok} | ${agg.errors} | ${formatMs(
        agg.minMs,
      )} | ${formatMs(agg.p50Ms)} | ${formatMs(agg.p95Ms)} | ${formatMs(
        agg.p99Ms,
      )} | ${formatMs(agg.maxMs)} | ${agg.throughputPerSec.toFixed(1)} |`,
    );
  }
  lines.push(``);
  lines.push(`| **Total** | ${result.total.requests} | ${result.total.ok} | ${result.total.errors} | ${formatMs(
    result.total.minMs,
  )} | ${formatMs(result.total.p50Ms)} | ${formatMs(result.total.p95Ms)} | ${formatMs(
    result.total.p99Ms,
  )} | ${formatMs(result.total.maxMs)} | ${result.total.throughputPerSec.toFixed(
    1,
  )} |`);
  lines.push(``);
  lines.push(`## Regression`);
  lines.push(`Compare this run against the previous entry in this file:`);
  lines.push(`- If P95 latency grows by more than ~20%, investigate the slower endpoint.`);
  lines.push(`- If error rate is non-zero, the API is failing under load.`);
  lines.push(`- If throughput drops, a bottleneck may have appeared.`);
  lines.push(``);
  return lines.join(`\n`);
}

describe("api load test", () => {
  test("exercises all endpoints under concurrent load and writes a regression report", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DURATION_MS);

    const samples: Sample[] = [];

    async function worker() {
      try {
        while (!controller.signal.aborted) {
          const endpoint =
            ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)]!;
          const sample = await hit(endpoint, controller.signal);
          samples.push(sample);
        }
      } catch {
        // Aborted or transient failure: the loop ends.
      }
    }

    const workers: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
    clearTimeout(timeout);

    const perEndpoint: Record<string, Aggregate> = {};
    for (const endpoint of ENDPOINTS) {
      const endpointSamples = samples.filter((s) => s.endpoint === endpoint);
      perEndpoint[endpoint] = aggregate(endpointSamples);
    }
    const total = aggregate(samples);

    const report = renderReport({
      startedAt: new Date().toISOString(),
      durationMs: DURATION_MS,
      concurrency: CONCURRENCY,
      perEndpoint,
      total,
    });

    const fs = await import("node:fs");
    fs.appendFileSync("regression-report.md", report + `\n\n---\n\n`);

    assert.ok(total.requests > 0, "no requests were sent");
    assert.ok(total.errors < total.requests, "every request errored");
  });
});