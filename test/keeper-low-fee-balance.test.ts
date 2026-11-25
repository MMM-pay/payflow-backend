import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { metrics } from "../src/lib/metrics.ts";

describe("keeper_low_fee_balance metric", () => {
  test("is registered in the Prometheus metrics registry and increments with channel label", () => {
    const channel = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    metrics.increment("keeper_low_fee_balance", 1, { channel });
    const rendered = metrics.render();
    assert.match(rendered, /# TYPE payflow_keeper_low_fee_balance_total counter/);
    assert.match(
      rendered,
      new RegExp(`payflow_keeper_low_fee_balance_total\\{channel="${channel}"\\} 1`),
    );
  });
});
