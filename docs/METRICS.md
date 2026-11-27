# Payflow metrics reference

Payflow exports Prometheus metrics at `GET /metrics` when `METRICS_ENABLED=true`.
All metric names are prefixed with `payflow_` so they are unambiguous in a shared
Prometheus instance.

## Enabling the endpoint

```
METRICS_ENABLED=true
```

Without this variable the path returns 404 and no scrape configuration is needed.

## Metrics

### `payflow_build_info` · gauge

Always `1`. Labels carry the deployment's identity so scrapes can be correlated
with releases.

| Label | Meaning |
|---|---|
| `version` | Semver from `package.json`, e.g. `0.2.0`. |
| `commit` | Git commit SHA the process was built from, or `unknown`. |
| `node_version` | Node.js runtime version, e.g. `v22.5.0`. |

**Suggested alert:** None. Use as a join key in dashboard queries.

---

### `payflow_indexer_cursor` · gauge

The last ledger sequence number the indexer has fully projected. Labelled by
`network`.

**Suggested alert:** Stagnation — `payflow_indexer_cursor` has not changed in
the last 5 minutes while the chain is advancing.

---

### `payflow_indexer_latest_ledger` · gauge

The most recent ledger sequence the RPC node reported. Labelled by `network`.

**Suggested alert:** Use the difference from `payflow_indexer_lag` rather than
this gauge directly.

---

### `payflow_indexer_lag` · gauge

`payflow_indexer_latest_ledger − payflow_indexer_cursor`: how many ledgers the
projection trails the network tip. Labelled by `network`. Zero when the
indexer is caught up; negative values are clamped to zero.

**Suggested alert:**
```
payflow_indexer_lag{network="mainnet"} > 240
```
More than 240 ledgers behind (≈ 20 minutes at 5 s per ledger) may indicate a
stalled indexer or an RPC node that stopped advancing.

---

### `payflow_active_mandates` · gauge

The number of mandates whose `status` is `Active` in the projection. Labelled
by `network`.

**Suggested alert:** A sudden drop (> 10 %) signals an unexpected bulk
cancellation or a projection reset.

---

### `payflow_active_merchants` · gauge

The number of distinct merchant addresses that hold at least one active mandate.
Labelled by `network`.

---

### `payflow_mrr` · gauge

Monthly recurring revenue of all active mandates, normalised to a 30-day month,
in the token's smallest unit. Stored and published as a decimal string — never a
JSON number — so precision above 2^53 is preserved. Labelled by `network`.

**Label cardinality:** `network` only. Merchant, plan, and token labels are
deliberately absent; they would multiply the series count with business growth.

---

### `payflow_events_applied_total` · counter

Contract events applied to the projection since the process started. Labelled by
`network`.

**Suggested alert:** Rate drops to zero while `payflow_indexer_lag` is not
growing — the indexer is running but the contract is emitting no events.

---

### `payflow_charges_attempted_total` · counter

Charges the keeper attempted to settle on-chain since the process started
(settled plus failed, excluding dry runs and pre-submission balance skips).

---

### `payflow_charges_settled_total` · counter

Charges the keeper settled on-chain since the process started. This counter only
increments in a process that runs the keeper (`KEEPER_ENABLED=true`).

**Suggested alert:** Rate is zero while `payflow_active_mandates` is high and
the lag is small — the keeper may be misconfigured or blocked.

---

### `payflow_charges_failed_total` · counter

Charges the keeper attempted but could not settle since the process started.

**Suggested alert:**
```
rate(payflow_charges_failed_total[5m]) /
rate(payflow_charges_settled_total[5m]) > 0.05
```
More than 5 % failure rate may indicate a vault underfunding problem or an RPC
outage.

---

### `payflow_keeper_passes_total` · counter

Keeper settlement passes run since the process started.

**Suggested alert:** No passes in 10 minutes while the keeper is enabled.

---

### `payflow_http_requests_total` · counter

HTTP requests handled since the process started. Labelled by `method` (HTTP
verb, e.g. `GET`) and `status_class` (`2xx`, `4xx`, `5xx`).

**Label cardinality:** `method × status_class` — at most ~15 combinations.

**Suggested alert:**
```
rate(payflow_http_requests_total{status_class="5xx"}[5m]) > 1
```
More than one 5xx per second warrants investigation.

---

### `payflow_http_errors_total` · counter

HTTP requests that completed with a 5xx status since the process started (no
labels).

---

### `payflow_keeper_backoffs_total` · counter

Charges the keeper scheduled a retry for since the process started. Labelled by
`reason`:

| `reason` | Meaning |
|---|---|
| `mandate` | The mandate's own backoff schedule is to blame (e.g. insufficient balance). |
| `permanent` | The charge cannot be retried (e.g. the mandate was cancelled). |
| `keeper` | A transient keeper-side error (e.g. RPC outage); the mandate's backoff is not extended. |
| `infrastructure` | An unrecoverable infrastructure error; the mandate's backoff is not extended. |

**Suggested alert:**
```
rate(payflow_keeper_backoffs_total{reason="permanent"}[1h]) > 0
```
Any permanent failure warrants investigation.

---

### `payflow_keeper_in_flight` · gauge

Settlement transactions the keeper currently has in flight. Never exceeds
`KEEPER_CONCURRENCY`. No labels.

**Suggested alert:** Stuck near `KEEPER_CONCURRENCY` for more than a few minutes
may indicate the RPC node is hanging on submission.

---

### `payflow_keeper_low_fee_balance_total` · counter

Times a keeper signing account XLM balance was observed below the configured
minimum threshold (`KEEPER_MIN_FEE_BALANCE`). Labelled by `channel` (the
signing account's public key).

**Suggested alert:**
```
increase(payflow_keeper_low_fee_balance_total[5m]) > 0
```
Any observation means the keeper may start failing to submit transactions.

---

### `payflow_http_request_duration_seconds` · histogram

HTTP request latency in seconds. Labelled by `method` (HTTP verb), `route`
(path pattern, e.g. `/api/plans/:id`), and `status_class` (`2xx`, `4xx`,
`5xx`).

Buckets: 5 ms, 10 ms, 25 ms, 50 ms, 100 ms, 250 ms, 500 ms, 1 s, 2.5 s, 5 s,
10 s.

**Suggested alert:**
```
histogram_quantile(0.99,
  rate(payflow_http_request_duration_seconds_bucket[5m])
) > 2
```
99th-percentile latency above 2 s suggests a slow query or an overloaded DB.

---

### `payflow_db_query_duration_seconds` · histogram

Database query latency in seconds. Labelled by `operation` (`all`, `get`, `run`)
and `dialect` (`sqlite` or `postgres`).

Buckets: 1 ms, 5 ms, 10 ms, 25 ms, 50 ms, 100 ms, 250 ms, 500 ms, 1 s, 2.5 s.

**Suggested alert:**
```
histogram_quantile(0.95,
  rate(payflow_db_query_duration_seconds_bucket{operation="run"}[5m])
) > 0.5
```
Write latency above 500 ms indicates DB contention or a slow disk.

---

## Cardinality guarantee

The registry enforces a per-metric cap (`maxSeries`, default 1 000 distinct
label sets). Once the cap is reached, new label combinations are dropped and a
warning is logged. This prevents an accidental per-mandate or per-subscriber
label from growing the registry without bound.

Metrics with tighter caps are:

| Metric | `maxSeries` |
|---|---|
| `payflow_build_info` | 1 |
| `payflow_http_request_duration_seconds` | default (1 000) |
| `payflow_db_query_duration_seconds` | default (1 000) |

## Prometheus rules

See [`docs/prometheus-rules.yaml`](prometheus-rules.yaml) for the recording and
alerting rules the team uses.
