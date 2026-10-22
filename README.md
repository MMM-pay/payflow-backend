<h1 align="center">Payflow â€” Backend</h1>

<p align="center">
  <strong>Event indexer, settlement keeper, and read API for the Payflow protocol.</strong>
</p>

<p align="center">
  <a href="https://github.com/MMM-pay/payflow-backend/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/MMM-pay/payflow-backend/actions/workflows/ci.yml/badge.svg"/>
  </a>
  <img alt="Node" src="https://img.shields.io/badge/node-22-green"/>
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.9-blue"/>
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-green"/>
</p>

> **Live demo:** https://mmm-pay.github.io/payflow-frontend/ Â·
> **Docs:** https://mmm-pay.github.io/payflow-docs/ ·
> **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
> **Runbook:** [docs/RUNBOOK.md](docs/RUNBOOK.md) ·
> **API changelog:** [API_CHANGELOG.md](API_CHANGELOG.md)

---

## What this does

Soroban contracts can answer "what is the state of mandate 7?" but they cannot
answer "show me every mandate this merchant has, sorted by revenue." That is
what this service is for. It does three jobs:

| Component | Job |
|---|---|
| **Indexer** | Polls Soroban RPC for contract events and projects them into SQLite |
| **Keeper** | Finds mandates that have fallen due and calls `charge` on-chain |
| **API** | Serves the projection to the frontend over REST |

### The keeper is not a trust dependency

`charge` is permissionless on-chain. This keeper holds no user funds and has no
privileged role â€” it only pays the transaction fee to trigger settlement. If it
stops running, merchants and subscribers can settle their own mandates directly.
Nothing is lost but timeliness.

### Indexing is idempotent by construction

The ledger cursor advances only after a batch is applied, so a crash mid-batch
replays that range on restart. Every write is designed for that:

- `plans` and `mandates` are upserts keyed on the on-chain id.
- `charges` is keyed on `(tx_hash, mandate_id)`, so a replayed ledger cannot
  double-count revenue.
- A charge is stamped with the **close time of the ledger it was emitted
  in**, not with the moment the indexer saw it, so a backfill or a restart
  cannot collapse a merchant's history onto one instant.
- Mandate updates are guarded by `WHERE charges_made < ?`, so an out-of-order
  event can never move a mandate backwards.


### Mandate lifecycle timeline

`GET /api/mandates/:id/timeline` returns `{ "events": [...] }` in ascending
ledger order (ties ordered by transaction hash and event kind). A missing
mandate returns 404; an invalid ID returns 400. Each entry contains
`mandateId`, `txHash`, `kind`, `ledger`, `at` (ledger close time in
Unix seconds, or null if unavailable), and `details`.

The timeline records every `subscribed`, `charged`, `pause_changed`
(including both pause and resume), `cancelled`, `mandate_ended`, and
`mandate_completed` event. Charged amounts and fees in `details` are
decimal strings in the token's smallest unit, never JavaScript floats.
History is stored idempotently by mandate, transaction and event kind;
replaying an indexed range does not duplicate entries. The existing
`mandate_events` churn aggregation remains unchanged.

```bash
curl 'http://localhost:8080/api/mandates/1/timeline'
```

### Raw contract event feed

`GET /api/events` exposes the original contract events saved by the indexer.
This endpoint depends on the `events` table introduced in **#34**; deploy the
raw event storage migration before enabling this endpoint. No Soroban RPC call
is made by the feed.

| Parameter | Meaning |
|---|---|
| `contract` | Optional exact contract ID filter |
| `name` | Optional event name (decoded from topic 0) |
| `after` | Opaque cursor returned in the previous page's `next` |

Each response contains `{ "events": [...], "next": "..." }`, with at most 50
events per page; `next` is `null` at the end. The ordering is ascending by
`(ledger, event_id)`, which is stable across re-indexes and handles multiple
events in the same ledger. Pass the unchanged `next` value as `after` for
the next page. Invalid parameters return `400 invalid_request`.

An event contains `contract`, `ledger`, `txHash`, `index`, `name`,
`topics`, `data`, and `closeTime`. `topics` is an array of base64-encoded
Soroban XDR values and `data` is a base64-encoded Soroban XDR value. Decode
them using the Stellar SDK; monetary amounts are never coerced to floating
point. `name` may be `null` for an unknown topic representation. This is a
lossless feed, not a JSON-native value projection.

Example:

```bash
curl 'http://localhost:8080/api/events?contract=CONTRACT_ID&name=charged'
curl 'http://localhost:8080/api/events?after=CURSOR_FROM_NEXT'
```

On multi-network deployments, the same feed is also available at
`/api/<network>/events`; each network reads its own SQLite database.

## Quick start

```bash
npm install
cp .env.example .env      # already points at the deployed testnet contracts
npm test                  # 477 tests, no network needed
npm run test:coverage     # the same tests, with a coverage report and a threshold
npm run dev
```

Index until caught up with the network, then exit (cron, backfills):

```bash
npm run indexer
```

Run one settlement pass and exit (needs `KEEPER_SECRET`):

```bash
npm run keeper
```

Answer the questions an incident asks, without writing SQL (see
[the operator CLI](#the-operator-cli)):

```bash
npm run cli -- status
npm run cli -- mandate 42
npm run cli -- due
```

### The operator CLI

`npm run cli -- <command>` is the same projection the API serves, read and
written through the same code, so it cannot drift from what the service does.

| Command | What it does |
|---|---|
| `status` | The indexer's and the API's health for a network: cursor, lag, counts, due mandates, keeper channels |
| `mandate <id>` | One mandate, its plan, its token and the charges it has settled |
| `due` | The mandates that are due for charging, each with the `funded` flag the last indexed vault balance gives |
| `charge <id>` | Trigger a charge for one mandate, through the keeper |
| `reindex` | Rebuild the projection from a ledger |

Every command has its own help:

```bash
npm run cli -- --help
npm run cli -- charge --help
```

Two rules shape it:

- **Nothing destructive happens by accident.** `charge` moves a subscriber's
  money and `reindex` rewrites the projection, so both refuse to run until
  `--yes` says so. `reindex --from` also refuses to move the cursor *forward*,
  because the ledgers in between would never be applied; `--skip-ahead` is
  how an operator accepts that gap on purpose.
- **Amounts stay strings.** An amount is printed as the decimal string the
  projection stores and compared as a bigint; it never becomes a JavaScript
  number, so a stroop-scale amount keeps every digit. Secrets are never
  printed: the keeper's public keys are shown, its secret seeds are not.

`status`, `mandate` and `due` read the projection only and need no network;
`--offline` keeps `status` from asking the RPC for the latest ledger at all.
`charge` and `reindex` need the network, and `charge` needs `KEEPER_SECRET`.

Point `status` at a running API to see what the service thinks of itself:

```bash
npm run cli -- status --api http://127.0.0.1:3000
```

That adds the API's verdict and the *live* indexer's health — whether it is
paused, how far it trails, what it last failed on and how many events it
rejected — which the projection file on its own does not hold.

### Running it in Docker

The image carries the service, its dependencies and the Node runtime it needs
(`node:sqlite` wants Node 22.5 or newer), so a checkout and a `.env` are all
it takes:

```bash
cp .env.example .env      # the same file the compose file reads
docker compose up         # builds the image and serves the API on :8080
docker compose logs -f api
```

The projection lives in the named volume `payflow-data`, so the container can
be recreated without losing the indexer's cursor — it picks up where it left
off instead of replaying the chain. `docker compose down` removes the
container and keeps the data; `docker compose down -v` removes the data too.

The image runs `node dist/index.js` as the unprivileged `node` user, and
[`Dockerfile`](Dockerfile) builds it in two stages: `npm ci && npm run build`
in the builder, production dependencies only in the final image.

### How the loops behave

- **No overlapping passes.** Each loop schedules its next pass only after the
  current one finishes, so a slow backfill cannot race itself on the cursor
  and the keeper cannot submit two transactions with the same sequence number.
- **Where indexing starts.** The saved cursor; with none, `INDEXER_START_LEDGER`
  (the ledger the contracts were deployed at); with neither, the oldest ledger
  the RPC node still serves. A cursor older than the node's retention window is
  moved forward with a warning, since RPC rejects ranges that start before it.
- **Exact ranges.** Each pass reads `[cursor, cursor + 8000)` windows and
  never a ledger the RPC node is still closing. Up to
  `INDEXER_FETCH_CONCURRENCY` windows are fetched at once, but they are
  applied in ledger order and the cursor advances only after a window is
  applied. Paging continues until a page is empty or passes the range end: a
  short page does not mean the range is exhausted.
- **Failing mandates back off.** A mandate whose charge fails (usually an
  empty vault) is retried after 1 minute, then 2, 4 and so on up to 6 hours. A
  success clears it. Without this, 25 underfunded mandates at the front of the
  queue would block every other mandate.
- **Dry run before the first real pass.** `KEEPER_DRY_RUN=true` makes a pass
  rehearse settlement: every due charge is built and simulated exactly as a
  real pass would — account lookup, inclusion fee, vault-balance skips and
  key rotation included — but nothing is signed or submitted, and no
  backoff, pass history or metrics change. Each mandate is logged as
  `simulated`, carrying the simulation's error when the charge would fail, so
  a new deployment can be exercised before it costs a fee. Set it back to
  `false` (or edit the env and send `SIGHUP`) to settle for real.
- **A mandate the vault cannot cover is skipped, not charged.** Before it
  settles anything, the keeper reads `vault.balance(subscriber, token)` from
  the contract — a read-only simulation, no transaction and no fee. One read
  per subscriber and token per pass, so a subscriber with several mandates
  costs one read, not one each. A mandate whose amount the vault cannot cover
  is skipped, and the skip is logged once per pass with the shortfall. The
  other mandates of the pass settle as usual, and a balance that cannot be
  read (RPC down) is not treated as a shortfall: the charge decides, exactly
  as before.
- **Batch settlement when the contract supports it.** Due mandates are
  grouped into one `charge_many` transaction of up to `KEEPER_BATCH_SIZE`
  mandates (default 10) instead of one `charge` each, so a pass pays one fee
  for the whole group. Support is detected from the contract itself: the
  first simulation that reports no `charge_many` switches the keeper to
  single charges for the rest of the process (a `SIGHUP` reload re-detects,
  for a redeployed contract), and a batch that cannot run — refused in
  simulation, rejected, or failed on chain — falls back to single charges
  for that group in that pass. The contract's per-id `Vec<bool>` result
  still fails and backs off skipped mandates individually, and
  `KEEPER_BATCH=false` disables batching entirely.
- **Events are validated against the contract spec.** Every decoded event is
  checked against `src/lib/event_spec.json` before it is projected. A renamed
  or retyped contract field makes the event fail validation: it is logged with
  the exact problems, counted in `/health`'s `indexer.mismatchedEvents`, and
  never silently stored as zeros. Update the spec file together with the
  contracts.

### Reconciling the projection with the chain

Idempotent indexing repairs replays, but it cannot repair a missed event: an
RPC gap or a bug can leave the projection wrong forever. Every
`RECONCILE_INTERVAL_MS` the reconciler samples `RECONCILE_SAMPLE_SIZE` active
mandates from the projection, re-reads each one from the subscription
contract through a read-only `get_mandate` simulation, and compares `status`,
`charges_made` and `next_charge`. Anything that differs is rewritten in place,
keyed on the mandate id, so re-running the pass is a no-op once the row
matches the chain. A failed RPC read is logged and retried on the next pass;
it never crashes the loop. Corrections are logged and reported on `/health`
under `indexer.reconciliations` and `indexer.corrections`.

### Rebuilding the projection from scratch

When the database is corrupted, stop the server and run:

```bash
npm run reindex
```

For every configured network it moves the SQLite file (with its `-wal` and
`-shm` files) aside to `<DATABASE_PATH>.bak-<UTC timestamp>`, creates a fresh
database and catches up from `INDEXER_START_LEDGER`. The old file is never
deleted; remove the backup yourself once the new projection checks out.

The running server holds `<DATABASE_PATH>.lock` (its PID), and `reindex`
refuses to run while that process is alive, so it cannot move a database out
from under a live server. A lock left by a crashed process is detected by its
dead PID and taken over.

### Rotating the keeper key without downtime

`charge` is permissionless, so the keeper key is only a fee payer â€” but losing
it used to mean an outage until someone edited the config and restarted. It no
longer does:

1. Fund a new testnet account and set `KEEPER_SECRET_NEXT` to its `S...` key.
   The keeper keeps signing with `KEEPER_SECRET`.
2. If the primary key becomes unusable (unfunded, deleted, or compromised and
   drained), the keeper switches to the standby key and retries the same
   mandate within the same pass. Once a pass settles with the new key, the log
   line `keeper settled with the rotated key; the previous key can now be
   retired` names both public keys.
3. Promote the standby: make it `KEEPER_SECRET`, drop `KEEPER_SECRET_NEXT`,
   and send the process `SIGHUP` (`kill -HUP <pid>`). Node re-reads `.env`,
   the config is re-validated and the running keeper swaps its signing keys â€”
   no restart, and the next successful pass confirms the old key can be
   retired. A leaked key can be abandoned mid-pass the same way; nothing is
   lost but a few seconds of timeliness.

Secrets are never logged; rotation logs only public keys.

### Settling in parallel with channel accounts

A single account can only have one transaction in flight — the next `charge`
has to wait for the previous one's sequence number — so one key settles a few
charges per minute and large merchants get billed hours late. List extra
signing accounts in `KEEPER_CHANNEL_SECRETS` (comma-separated `S...` keys) and
one pass distributes the due mandates across them:

- Each channel signs and sequences **its own** transactions and pays its own
  fees, so sequence numbers live on separate accounts and cannot collide.
  Channel keys need only XLM for fees: `charge` is permissionless, so no
  channel key holds user funds or any on-chain authority.
- Due mandates are pulled from one shared queue by one worker per channel —
  strictly one transaction at a time *within* a channel, several channels in
  parallel. With a single channel the pass is exactly the old sequential
  behaviour, and `KEEPER_SECRET` is always the first channel.
- Before distributing, each channel's account is checked with one `getAccount`.
  A channel that cannot pay (unfunded, deleted) is skipped for the pass —
  logged by public key — and its share settles through the live channels
  instead of backing off against a dead key. `KEEPER_SECRET_NEXT` rotation
  still applies to the primary channel, before and during the pass.

A fee-bump design (main key pays every fee) was deliberately rejected: a
Stellar fee-bump consumes the *fee source's* sequence number, so every
transaction would sequence against the one main account and serialize again.

## API

Base path `/api`. All amounts are strings in the token's smallest unit
(stroops for XLM) to avoid JavaScript float precision loss.

`/health` is a **liveness** probe and always answers 200, so a slow backfill
does not get the service restarted. `/ready` is a **readiness** probe: it
answers 503 (`starting` until the indexer's first pass, then `catching_up`)
while the projection trails the network by more than 120 ledgers, and 200
`ready` once it is within that threshold. Point orchestration readiness
checks at `/ready` and liveness checks at `/health`.

When extra networks are configured (see below), every route also answers under
`/api/<network>/...` — `/api/mainnet/plans`, `/api/testnet/stats` — while
`/api/...` keeps serving the default network unchanged.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | Status (`starting`, `ok`, `catching_up`), indexer cursor, lag, `paused` state, data freshness (`freshnessSeconds`), spec-mismatch count, contract IDs, active RPC endpoint |
| `GET` | `/ready` | Readiness probe: `200 ready` once caught up, `503` (`starting`/`catching_up`) while behind |
| `GET` | `/metrics` | Prometheus metrics: the indexer's gauges and the keeper's counters (only when `METRICS_ENABLED=true`) |
| `GET` | `/api/openapi.json` | The OpenAPI 3.1 description of this API |
| `GET` | `/api/plans?merchant=&limit=` | Published plans |
| `GET` | `/api/plans/:id` | One plan |
| `GET` | `/api/plans/:id/stats` | Per-plan statistics: active and total mandates, cancellations, total collected, average charges per mandate |
| `GET` | `/api/mandates?ids=&subscriber=&merchant=&status=` | Mandates |
| `GET` | `/api/mandates/:id` | One mandate |
| `GET` | `/api/mandates/:id/charges` | Settlement history |
| `GET` | `/api/stream?merchant=&subscriber=` | Server-sent `charged`, `subscribed`, `cancelled` and `mandate_ended` events (25-second heartbeat) |
| `POST` | `/api/webhooks` | Register a URL to receive signed `charged` events; proves control of the merchant address with a signature |
| `POST` | `/api/webhooks/:id/rotate` | Replace a webhook's signing secret; both secrets sign during the overlap |
| `POST` | `/api/webhooks/:id/test` | Send a signed `ping` through the normal delivery path; returns status code and latency |
| `GET` | `/api/webhooks/:id/deliveries` | The webhook's last 100 delivery attempts: event, status code, error, attempt, next retry |
| `GET` / `POST` | `/api/auth` | SEP-10 challenge, and a JWT for a signed challenge (only when `SEP10_SIGNING_KEY` is set) |
| `GET` | `/api/vault/:address` | Latest balance per token |
| `GET` | `/api/vault/:address/events?limit=` | Vault deposit, withdrawal and debit history, newest first |
| `GET` | `/api/protocol` | Current protocol fee (`fee_bps`) and fee-change history |
| `GET` | `/api/keeper` | Last 20 keeper passes, failures, skipped mandates and mandate backoff (only when enabled) |
| `GET` | `/api/due` | Mandates chargeable right now, each with a `funded` flag |
| `GET` | `/api/merchants/:address/summary` | Active mandates, revenue, MRR and ARR |
| `GET` | `/api/merchants/:address/subscribers?limit=` | The merchant's distinct subscribers, grouped by lifetime value |
| `GET` | `/api/merchants/:address/churn?bucket=month&limit=` | Per-bucket churn: mandates started, cancelled, ended and completed, and the net |
| `GET` | `/api/merchants/:address/revenue?bucket=day&from=&to=` | Revenue over time: gross, fee and net per bucket |
| `GET` | `/api/merchants/:address/forecast?days=30` | Projected charges over the next N days, net of fees |
| `GET` | `/api/subscribers/:address/summary` | Mandates and total paid |
| `GET` | `/api/subscribers/:address/upcoming?days=30` | Charges due over the next N days, with projected times |
| `GET` | `/api/stats` | Protocol totals, charge volume, fees and last indexed ledger |

`/api/mandates` also accepts `ids`, a comma-separated batch of up to 100
mandate ids (`?ids=1,2,3`). Ids that do not exist are omitted; more than 100
ids returns `400` with `error.code = "too_many_ids"` and a non-numeric id
returns `400` with `error.code = "invalid_ids"`.

Every address the API takes is checked as a Stellar StrKey — an account
(`G...`) or a contract (`C...`) — so a mistyped address is a `400
invalid_request` rather than an empty page. The checksum is checked too: a
one-character typo has the right shape but the wrong checksum, and it names
no merchant.

### The OpenAPI description

`GET /api/openapi.json` serves an [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0)
document describing every route above, with the parameters each one takes, the
responses it answers and the schema of each body. Amounts are documented as
decimal strings in the token's smallest unit, so a generated client knows not
to read them as numbers.

The document is served by the instance it belongs to, so it lists the routes
that instance actually has: the operator endpoints (`/admin/...`), the metrics
endpoint and the keeper history are in it whatever the configuration says,
and each says in its description what has to be true for it to answer.

```bash
curl -s localhost:8080/api/openapi.json | jq '.paths | keys'
```

A test compares the document with the routes Express registers, so a route
that is added without being documented fails the build.

The document's `externalDocs` points at
[API_CHANGELOG.md](API_CHANGELOG.md), which records what changed in the API
between releases and how long a deprecated field or route keeps working before
it is removed — one minor release of notice, announced in the response with
`Deprecation` and `Sunset` headers.

### Metrics

With `METRICS_ENABLED=true` the service serves `/metrics` in the Prometheus
text format. It is off by default: the numbers are operational data, and a
deployment that does not scrape them should not expose them.

| Metric | Type | What it says |
|---|---|---|
| `payflow_indexer_cursor` | gauge | The ledger up to which events have been projected |
| `payflow_indexer_latest_ledger` | gauge | The latest ledger the RPC node reported |
| `payflow_indexer_lag` | gauge | How many ledgers the projection trails the network by |
| `payflow_events_applied_total` | counter | Contract events applied to the projection |
| `payflow_charges_settled_total` | counter | Charges the keeper settled |
| `payflow_charges_failed_total` | counter | Charges the keeper could not settle |
| `payflow_keeper_passes_total` | counter | Keeper passes run |

The three indexer gauges carry a `network` label, so an instance that serves
testnet and mainnet reports both. The counters are the process's own totals:
they reset when the process restarts, which is what Prometheus expects.

### The due list and the vault balance

`GET /api/due` lists the mandates that can be charged right now. Each one
carries a `funded` flag: whether the last vault balance the indexer saw covers
the charge.

```json
{
  "now": 1750000000,
  "due": [
    {
      "id": 7,
      "subscriber": "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR",
      "merchant": "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH",
      "next_charge": 1749999940,
      "amount": "10000000",
      "funded": true
    }
  ]
}
```

The balance is the one the indexer last saw, so it can be behind the chain: a
subscriber who has just funded their vault is reported as not funded until the
deposit is indexed. The keeper does not rely on it — it reads
`vault.balance(subscriber, token)` from the contract before it settles
anything, and skips a mandate the vault cannot cover. A skipped mandate is
logged once per pass with the shortfall, and it does not take the pass's place:
the other mandates settle as usual.

### Merchant churn

`GET /api/merchants/:address/churn` reports how a merchant's mandate base
moved over time: how many mandates started, how many departed (cancelled by
the subscriber, ended by the merchant, or completed their full charge count),
and the net of the two.

```json
{
  "merchant": "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH",
  "bucket": "month",
  "buckets": [
    {
      "bucket": "2025-01",
      "started": 3,
      "cancelled": 1,
      "ended": 0,
      "completed": 2,
      "net": 0
    }
  ],
  "totals": { "started": 3, "cancelled": 1, "ended": 0, "completed": 2, "net": 0 }
}
```

- `bucket` picks the period: `day`, `week` or `month` (the default). Buckets
  are calendar periods in UTC — a month bucket is labelled `2025-01`, a day
  bucket `2025-01-15`, and a week bucket carries the Monday's date.
- `limit` caps how many of the most recent buckets are reported (12 by
  default, 120 at most). Every bucket in the range is present, so a chart has
  no gaps in it.
- `net` is `started` minus the departures, i.e. the growth of the mandate
  base in that bucket.

The counts are bucketed by the **ledger close time** of each event, so they
describe the chain's own history rather than when the indexer happened to
index it. Replaying a ledger range therefore leaves the report unchanged.

### Merchant revenue

`GET /api/merchants/:address/revenue` reports what a merchant took in, what
the protocol took and what was left, over time — the time series behind the
lifetime totals of `/summary`.

```json
{
  "merchant": "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH",
  "bucket": "day",
  "from": null,
  "to": null,
  "buckets": [
    {
      "bucket": "2025-01-15",
      "gross": "10000000",
      "fee": "100000",
      "net": "9900000",
      "charges": 1
    }
  ],
  "totals": { "gross": "10000000", "fee": "100000", "net": "9900000", "charges": 1 }
}
```

- `bucket` picks the period: `day`, `week` or `month` (the default). Buckets
  are calendar periods in UTC, labelled like the churn report's.
- `from` and `to` bound the range in unix seconds, half-open: a charge
  exactly at `to` is excluded. Without them the report covers the merchant's
  whole history, and the response echoes the range it was given (`null` when
  it was unbounded).
- `limit` caps how many of the most recent buckets are reported (366 by
  default, 1000 at most). Every bucket between the first and the last one
  with data is present, so a chart has no gaps in it.
- `gross` is what the subscribers paid (the charge amount plus the fee),
  `fee` is the protocol's share of it and `net` is what the merchant kept,
  so `gross − fee = net`. All three are decimal strings in the token's
  smallest unit, like every other amount in this API.
- The buckets are taken from the **ledger close time** of each charge, not
  from when the indexer saw it, so the report is the chain's own history and
  replaying a ledger range leaves it unchanged.

### Error responses

Every non-2xx response uses one structured envelope, so a client can branch on
a stable `code` and show the human-readable `message` without parsing prose:

```json
{
  "error": {
    "code": "plan_not_found",
    "message": "No plan exists with that id.",
    "requestId": "b1e4..."
  }
}
```

- `code` is machine-readable and stable per condition (the closed set below);
  new variants are added, never renamed.
- `message` is safe to display. It never carries an exception string, a bound
  SQL value, or an RPC URL — `internal_error` always uses fixed copy.
- `requestId` echoes the response's `X-Request-Id` header so a report can be
  tied to the matching server log line. It is `null` only if no id was minted.
- `details` is present for `invalid_request` only: one entry per parameter
  that was wrong, naming it and saying what was expected.

> **Migration note.** This envelope replaces the earlier `{ "error": "<code>" }`
> string body. Consumers that read the error must now read `error.code`.

> **Migration note (parameters).** A parameter the API does not accept is now
> answered with `400 invalid_request` instead of being ignored: a mistyped
> address, an unknown `status`, a non-numeric id, a malformed `limit`, `days`
> or `bucket`. Before, those were cast and quietly matched nothing, so a
> client bug looked like an empty page. Valid requests are unaffected; an
> empty value (`?merchant=`) still means "no filter".

> **Migration note (charges).** `GET /api/mandates/:id/charges` now answers
> `404 mandate_not_found` for a mandate that does not exist, like
> `GET /api/mandates/:id` does. Before, it answered `200` with an empty
> list, so "no such mandate" and "no charges yet" looked the same.

### Webhooks

Merchants can register a URL to receive signed `POST`s whenever one of their
mandates charges, instead of polling. `POST /api/webhooks` registers a URL,
and the caller proves control of the merchant's Stellar address with an
ed25519 signature over `payflow-webhook:v1:<merchant>:<url>:<timestamp>`
(signatures older than ten minutes are refused). The response carries the
HMAC-SHA256 secret used to sign deliveries; treat it as a secret and never
log it.

Every delivery is a `POST` to the registered URL carrying:

- `Idempotency-Key`: a UUID reused across retries, so receivers can collapse
  duplicate attempts (delivery is at-least-once).
- `Payflow-Signature: sha256=<hex>`: an HMAC-SHA256 over the request body
  using the webhook's secret, so the merchant can verify the request came
  from this service.
- The charge event as a JSON body (`event`, `mandate_id`, `subscriber`,
  `merchant`, `amount`, `fee`, `ledger`).

Failing deliveries retry with exponential backoff (1 minute, doubling, up to
six hours) for at most five attempts. A webhook that gives up is marked
failed and stops receiving deliveries until re-registered. Undelivered
deliveries are retried on a short cadence, so a silent indexer still makes
delivery progress.

`GET /api/webhooks?merchant=<G...>&timestamp=<unix s>&signature=<base64>`
lists the merchant's webhooks, newest first, signed over
`payflow-webhook-list:v1:<merchant>:<timestamp>`. Secrets are never returned
again: each entry shows only `secretLast4`. `DELETE /api/webhooks/:id` removes
one, with `{ merchant, timestamp, signature }` as a JSON body (or the same
three query parameters) signed over
`payflow-webhook-delete:v1:<merchant>:<id>:<timestamp>`; a deleted webhook gets
no further deliveries and its scheduled retries are dropped. Each action has
its own message prefix, so a signature for one cannot be replayed as another.
A wrong, malformed or expired (older than ten minutes) signature is a `401
unauthorized`.

`POST /api/webhooks/:id/rotate` (signed over
`payflow-webhook-rotate:v1:<merchant>:<id>:<timestamp>`) replaces a webhook's
secret and returns the new one once. For `WEBHOOK_SECRET_OVERLAP_S` (one day
by default; `0` retires the old secret at once, for a leak) every delivery
carries both signatures, `Payflow-Signature: sha256=<new>, sha256=<old>`;
receivers should accept a request when any listed signature matches a secret
they hold. After the overlap only the new secret signs.

`POST /api/webhooks/:id/test` (signed over
`payflow-webhook-test:v1:<merchant>:<id>:<timestamp>`) delivers
`{ "event": "ping", "webhook_id", "merchant" }` through the normal path — same
headers, same signatures, same retries — and answers with the attempt's
`status`, `statusCode`, `latencyMs`, `error` and `nextRetryAt`.

`GET /api/webhooks/:id/deliveries` (signed over
`payflow-webhook-deliveries:v1:<merchant>:<id>:<timestamp>`, as query
parameters) lists the webhook's last 100 delivery attempts, newest first: a
delivery that failed and was retried shows each attempt, with its status code,
error and the retry it scheduled. Older attempts are pruned as new ones are
written.

#### SEP-10 sign-in

Instead of signing a message for every call, a merchant can sign in once with
[SEP-10](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md):
`GET /api/auth?account=<G...>` returns a challenge transaction, the wallet
signs it, and `POST /api/auth` with `{ "transaction": "<signed XDR>" }` (JSON
or form-encoded) returns `{ "token": "<JWT>" }`. Every webhook route accepts
that token as `Authorization: Bearer <token>` in place of `merchant`,
`timestamp` and `signature`. Tokens last `SEP10_JWT_TTL_S` (an hour by
default), are valid only on the network that issued them, and each challenge
yields one token. An account that exists must sign with signers meeting its
medium threshold; one that does not must sign with its master key. Publish
the server's public key as `SIGNING_KEY` and the endpoint as
`WEB_AUTH_ENDPOINT` in the home domain's `stellar.toml`.

| `error.code` | HTTP | Where |
|---|---|---|
| `not_found` | 404 | An unknown path, or a method/path the API does not expose |
| `plan_not_found` | 404 | `GET /api/plans/:id` or `GET /api/plans/:id/stats` with no such plan |
| `mandate_not_found` | 404 | `GET /api/mandates/:id` or `GET /api/mandates/:id/charges` with no such mandate |
| `invalid_ids` | 400 | `?ids=` contains a non-positive-integer token |
| `too_many_ids` | 400 | `?ids=` lists more than 100 ids |
| `invalid_request` | 400 | A query or path parameter is not valid; `error.details` says which |
| `invalid_token_id` | 400 | `GET /api/tokens/:id` with a malformed contract id |
| `token_metadata_unavailable` | 502 | `GET /api/tokens/:id` while the token contract cannot be read |
| `rate_limited` | 429 | API request exceeded the configured per-IP limit; includes `Retry-After` |
| `stream_limit` | 503 | `GET /api/stream` when the concurrent stream cap is reached |
| `unauthorized` | 401 | A `/admin/*` request without a valid bearer token, or a webhook management request with a wrong or expired signature or an invalid or expired SEP-10 token |
| `reindex_unavailable` | 503 | `POST /admin/reindex` on a process without an indexer |
| `indexer_unavailable` | 503 | `/admin/indexer/pause`/`resume` on a process without an indexer |
| `keeper_unavailable` | 503 | A keeper endpoint while `KEEPER_ENABLED=false` |
| `reindex_failed` | 500 | `POST /admin/reindex` threw (operator message retained) |
| `keeper_pass_failed` | 500 | `POST /admin/keeper/run` threw (operator message retained) |
| `internal_error` | 500 | Any unhandled failure at the API boundary |

Example:

```bash
curl localhost:8080/api/merchants/GB343X.../summary
{
  "merchant": "GB343X...",
  "activeMandates": 1,
  "totalCollected": "19800000",
  "chargeCount": 2,
  "arr": "5256000000000",
  "tokens": [
    { "token": "CDLZFC...", "totalCollected": "19800000", "mrr": "432000000000" }
  ]
}
```

`mrr` and `arr` normalise every active mandate's own period to a 30-day month
(2,592,000 s) and a 365-day year (31,536,000 s) respectively:

```
mrr = sum(amount Ã— 2592000 / period)   over active mandates
arr = sum(amount Ã— 31536000 / period)  over active mandates
```

A yearly plan of 120,000000 stroops therefore reports `arr` of 120000000 and
an `mrr` of 9863013. A short-period demo plan produces a very large figure;
that is arithmetic, not a bug.

### Golden response fixtures

`test/golden.test.ts` captures every route's JSON for a seeded in-memory
database and compares it against a checked-in snapshot in `test/fixtures/`.
Because the comparison is a full deep-equal, a renamed field, a dropped field,
or a changed value fails the test even when the targeted assertions still pass
— this is what stops a response shape drifting silently out from under the
frontend.

The capture is deterministic by construction: the clock is frozen for the whole
run, the indexer status is fixed, and a fixed `x-request-id` header is echoed
into every error envelope. No test touches the network.

Update the snapshots **intentionally** when a response change is meant to land:

```bash
UPDATE_GOLDEN=1 npm test         # rewrites test/fixtures/*.json from the API
git diff test/fixtures           # review it like any other contract change
```

A snapshot should only move because you asked it to; an unexpected diff is the
regression the fixture exists to catch.

### Typed API client

Response shapes are declared once, in `src/routes/types.ts`. The route
handlers annotate their bodies with those types, one router per resource
lives in `src/routes/*.ts`, and the client in `src/client/index.ts`
re-exports the same declarations â€” types are shared, not copied, so backend
and frontend cannot drift.

```ts
import { PayflowClient, PayflowApiError } from "payflow-backend/client";

const api = new PayflowClient("http://localhost:8080");
const { plans } = await api.plans({ merchant });
const summary = await api.merchantSummary(merchant); // MerchantSummary, typed
try {
  await api.plan(999);
} catch (err) {
  if (err instanceof PayflowApiError && err.status === 404) { /* ... */ }
}
```

Every endpoint is covered: `health`, `plans`, `plan`, `mandates`, `mandate`,
`charges`, `due`, `merchantSummary`, `subscriberSummary`, `stats`. The
package is private for now: the frontend depends on it from the repository
(it is built by `npm run build` into `dist/client`), and publishing it to a
registry is a release-time step for maintainers.

`tokens` breaks the same revenue down per token, joined through each charge's
mandate and plan. With `TOKEN_ID` configured, the flat `totalCollected` and
`mrr` cover that default token only, so a merchant's other tokens cannot
inflate them; without one they keep their previous all-token meaning.
`chargeCount` always counts every token's charges.

`upcoming` projects each active mandate's charges over the next `days`
(default 30, capped at 365). A mandate already due is projected at `now` — the
keeper settles it on its next pass — and then every `period`; a future one
starts at its `next_charge`. Missed periods are not replayed, matching the
contract, which sets `next_charge = charge time + period` rather than walking
the ones it skipped. A `max_charges` cap limits the count to the remaining
allowance, charges are listed oldest-first inside `[now, until)`, `amount` is
the gross per-charge the subscriber pays, and `truncated` marks output clipped
by the per-mandate cap of 400 occurrences.

`forecast` sums the charges active mandates will produce in the next `days`
(default 30, capped at 365), each occurrence net of the mandate's `fee_bps`.
Occurrence times are `next_charge + k × period`; a `max_charges` of 0 means no
expiry, otherwise the remaining allowance caps the count. The response carries
its `assumptions` (window bounds, fee normalisation, vault funding ignored)
so consumers do not have to infer them.

### Operator endpoints

`/admin/*` exists only when `ADMIN_TOKEN` is set, and every request needs
`Authorization: Bearer <token>`, compared in constant time. Without the
variable the paths are absent and 404 like any other unknown route.

| Method | Path | Action |
|---|---|---|
| `POST` | `/admin/reindex` | Run one indexer pass now |
| `POST` | `/admin/indexer/pause` | Hold the indexer loop back without stopping the API |
| `POST` | `/admin/indexer/resume` | Let indexer passes run again |
| `POST` | `/admin/keeper/run` | Run one settlement pass now |
| `GET` | `/admin/keeper/backoff` | Mandates backing off after failed charges |

Triggered passes share one serialized runner with the scheduled loops, so a
trigger queues behind a pass that is still running instead of overlapping it —
overlap would race the cursor and, for the keeper, the account sequence
number. The keeper endpoints answer `503 keeper_unavailable` when the keeper
is off (`KEEPER_ENABLED=false`). A pass that fails answers 500 and the failure
is logged; the next scheduled pass retries as usual.

Pausing the indexer makes each scheduled pass a no-op: no RPC reads, no
writes, and the saved cursor is preserved, so resuming continues exactly where
it left off. The API keeps serving the projection as it stands throughout, and
`/health` reports `indexer.paused: true` while held back. This is the runtime
investigation switch — it does not stop the process, so a bad event can be
examined without API downtime.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | RPC endpoint, or a comma-separated list to fail over between |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Network id |
| `PLAN_REGISTRY_ID` | — | Deployed registry contract |
| `VAULT_ID` | — | Deployed vault contract |
| `SUBSCRIPTION_ID` | — | Deployed subscription contract |
| `TOKEN_ID` | — | Default token for the flat merchant-summary amounts. Unset, they span every token |
| `NETWORKS` | *(empty)* | Extra networks to serve, comma-separated (see below) |
| `KEEPER_ENABLED` | `false` | Turn on automatic settlement |
| `KEEPER_DRY_RUN` | `false` | Rehearse each pass: simulate every due charge and log the outcome without signing or submitting anything |
| `KEEPER_SECRET` | — | `S...` key that pays settlement fees. Required when the keeper is on |
| `KEEPER_SECRET_NEXT` | — | Standby `S...` key for zero-downtime rotation; see [Rotating the keeper key](#rotating-the-keeper-key-without-downtime) |
| `KEEPER_CHANNEL_SECRETS` | *(empty)* | Extra `S...` channel keys, comma-separated: each settles in parallel with its own sequence and fees; see [Settling in parallel with channel accounts](#settling-in-parallel-with-channel-accounts) |
| `KEEPER_INTERVAL_MS` | `60000` | Settlement poll interval |
| `KEEPER_ORDER` | `oldest` | Order for due mandates: `oldest` (due date ascending) or `largest` (amount descending) |
| `KEEPER_MERCHANTS` | *(empty)* | Only settle mandates payable to these merchants, comma-separated `G...` addresses. Empty settles every merchant |
| `KEEPER_FEE_PERCENTILE` | `90` | Soroban inclusion-fee percentile used for charge transactions (`50`, `60`, `70`, `80`, `90`, `95`, or `99`) |
| `KEEPER_MAX_FEE` | `100000` | Maximum inclusion fee in stroops; congestion retries cannot exceed this cap |
| `KEEPER_BATCH` | `true` | Use `charge_many` when supported, falling back to single charges when unavailable |
| `KEEPER_BATCH_SIZE` | `10` | Mandates per `charge_many` call (2–25) |
| `KEEPER_BATCH` | `true` | Settle due mandates through the contract's `charge_many` in groups, falling back to single `charge` transactions when the contract does not support it |
| `KEEPER_BATCH_SIZE` | `10` | Mandates per `charge_many` call (2–25); keep it at or below the contract's list cap |
| `INDEXER_INTERVAL_MS` | `10000` | Indexing poll interval |
| `INDEXER_FETCH_CONCURRENCY` | `4` | Ledger windows one pass may fetch at once (max 16). Applied in order; `1` is sequential |
| `INDEXER_START_LEDGER` | `0` | Where to start with no saved cursor. `0` starts from the oldest ledger RPC still serves |
| `RECONCILE_INTERVAL_MS` | `600000` | How often the reconciler re-checks a sample of active mandates against the contract state, in ms |
| `ARCHIVE_URL` | *(empty)* | Full-history archive URL used to backfill the gap between the stored cursor and the oldest ledger the RPC still serves |
| `ALLOW_GAPS` | `false` | Advance the cursor past a gap the RPC cannot serve, accepting lost history; without it the indexer refuses to advance past a gap |
| `RECONCILE_SAMPLE_SIZE` | `25` | Active mandates sampled per reconcile pass; each sample costs one read-only RPC simulation |
| `DATABASE_PATH` | `./payflow.db` | SQLite file |
| `PORT` | `8080` | HTTP port |
| `API_RATE_LIMIT_WINDOW_MS` | `60000` | Per-IP API rate-limit window in milliseconds |
| `API_RATE_LIMIT_MAX` | `120` | Maximum requests per IP in each API rate-limit window |
| `METRICS_ENABLED` | `false` | Serve the Prometheus metrics at `/metrics` |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP/HTTP collector base URL. Unset disables tracing at no cost |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | How long shutdown waits for in-flight passes |
| `ADMIN_TOKEN` | — | Bearer token for `/admin`. Unset keeps those routes disabled |
| `WEBHOOK_SECRET_OVERLAP_S` | `86400` | Seconds a rotated webhook secret keeps signing beside the new one (0–604800) |
| `SEP10_SIGNING_KEY` | — | Secret seed of the SEP-10 server account. Unset keeps `/api/auth` disabled |
| `SEP10_JWT_SECRET` | — | HMAC key for SEP-10 JWTs, at least 32 characters; required with `SEP10_SIGNING_KEY` |
| `SEP10_HOME_DOMAIN` | — | Home domain of the challenge (`<home domain> auth`); required with `SEP10_SIGNING_KEY` |
| `SEP10_WEB_AUTH_DOMAIN` | `SEP10_HOME_DOMAIN` | Domain serving `/api/auth`, the challenge's `web_auth_domain` |
| `SEP10_JWT_TTL_S` | `3600` | JWT lifetime in seconds (60–86400) |

Setting `OTEL_EXPORTER_OTLP_ENDPOINT` exports OpenTelemetry spans for every
RPC call (`rpc.<method>`), indexer and keeper pass, and HTTP request. Every
response carries an `X-Request-Id` (a caller-supplied id is reused), which also
appears in the request logs. Secrets such as `KEEPER_SECRET` are redacted from
logs.

To try tracing locally, start any OTLP/HTTP collector (for example the
Jaeger all-in-one image, which accepts OTLP on port 4318) and run:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev
```

Spans are batched and sent to `<endpoint>/v1/traces` every few seconds and on
shutdown. Without the variable, tracing does nothing and costs nothing.

The keeper is **off** by default. Turning it on requires funding
`KEEPER_SECRET` with XLM for transaction fees.

`SOROBAN_RPC_URL` may list several endpoints. Calls go to the active endpoint
(reported under `rpc.active` on `/health`). If a call fails, the next endpoint
is tried and takes over, so an outage at one provider does not stop indexing
or settlement; the caller's loop logs the failure and retries next pass. A
lagging endpoint — one that answers but from an older ledger — loses to the
freshest endpoint the health probe finds. Reads get a 15-second timeout, so a
hung provider fails over instead of stalling a pass forever.

### Serving testnet and mainnet from one instance

Everything above describes the default network. To serve additional networks
beside it, list them in `NETWORKS` and configure each one with `<NAME>_`
prefixed variables:

```bash
NETWORKS=mainnet
MAINNET_SOROBAN_RPC_URL=https://mainnet.sorobanrpc.example
MAINNET_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
MAINNET_PLAN_REGISTRY_ID=C...
MAINNET_VAULT_ID=C...
MAINNET_SUBSCRIPTION_ID=C...
MAINNET_INDEXER_START_LEDGER=5110418
```

Each network runs its own indexer with its own cursor and its own SQLite
database — derived from `DATABASE_PATH` (`./payflow.db` becomes
`./payflow-mainnet.db`) unless `<NAME>_DATABASE_PATH` says otherwise — so
ledger numbers, replay windows and outages on one network never affect the
other. Unprefixed `/api/...` routes always serve the default network
(`STELLAR_NETWORK`); everything is also reachable under `/api/<name>/...`. The
keeper settles the default network only.


## Deployment

**API.** `render.yaml` is a Render blueprint for the free plan: Node 22 and
`/health` as the health check. The free plan has no disk, so the SQLite
projection is rebuilt from `INDEXER_START_LEDGER` after each restart, which
takes seconds while the deployment ledger is within RPC retention (about 7
days on testnet). On a paid plan, add a disk and point `DATABASE_PATH` at it.

**Keeper.** [`.github/workflows/keeper.yml`](.github/workflows/keeper.yml)
settles due testnet mandates roughly every 15 minutes from GitHub Actions,
using the `KEEPER_SECRET` repository secret, and caches its projection between
runs. A free web service sleeps when idle, so it is not a reliable place for
the keeper. The key only pays fees: if the workflow stops, anyone can still
call `charge`.

**Fly.io.** [`fly.toml`](fly.toml) deploys the container image with a 1 GB
volume mounted at `/data` for the SQLite file, so the projection survives
restarts, plus `/health` checks and small-instance autostop. From a checkout:

```bash
fly auth login
fly apps create payflow-backend        # pick another name if taken, then update fly.toml
fly volumes create payflow_data --region sjc --size 1
fly secrets set KEEPER_SECRET=S...     # optional; only to settle due mandates
fly deploy
curl https://payflow-backend.fly.dev/health
```

`fly.toml` ships with the deployed testnet contract IDs and
`DATABASE_PATH=/data/payflow.db`; override either with
`fly secrets set`. The image's entrypoint runs the app as a non-root user and
takes ownership of the data directory, which a fresh root-owned volume
requires.

**Container image.** [`Dockerfile`](Dockerfile) builds a multi-stage image
(`npm ci && npm run build`, then production dependencies only) that serves the
API and runs the indexer loop on `node dist/index.js` as a non-root user.
Pushing a `v*` tag publishes `ghcr.io/mmm-pay/payflow-backend:<version>` via
[`.github/workflows/release.yml`](.github/workflows/release.yml):

```bash
docker run --env-file .env -v payflow_data:/data ghcr.io/mmm-pay/payflow-backend:0.2.0
```

For local work, [`docker-compose.yml`](docker-compose.yml) runs the same
image with `.env` and a named volume (see [Running it in
Docker](#running-it-in-docker)).

## Related repositories

| Repo | Role |
|---|---|
| [payflow-contract](https://github.com/MMM-pay/payflow-contract) | Soroban contracts this service indexes |
| [payflow-backend](https://github.com/MMM-pay/payflow-backend) | This repo |
| [payflow-frontend](https://github.com/MMM-pay/payflow-frontend) | Consumes this API |
| [payflow-docs](https://github.com/MMM-pay/payflow-docs) | Protocol documentation |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs `lint`, `typecheck`, `test`,
`build`, a container build and a production `audit`; all six must pass, and
Dependabot keeps dependencies current. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md), and changes to the API surface in
[API_CHANGELOG.md](API_CHANGELOG.md).

## Security

See [SECURITY.md](SECURITY.md). Unaudited, testnet only.

## Maintainers

| Name | Role | Contact |
|---|---|---|
| Victor Adeleke | Lead maintainer | [@titilope12](https://github.com/titilope12) |

## Contributors

<a href="https://github.com/MMM-pay/payflow-backend/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MMM-pay/payflow-backend"/>
</a>

## License

Apache-2.0.
