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
> **Runbook:** [docs/RUNBOOK.md](docs/RUNBOOK.md)

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
- Mandate updates are guarded by `WHERE charges_made < ?`, so an out-of-order
  event can never move a mandate backwards.

## Quick start

```bash
npm install
cp .env.example .env      # already points at the deployed testnet contracts
npm test                  # 61 tests, no network needed
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
- **Events are validated against the contract spec.** Every decoded event is
  checked against `src/lib/event_spec.json` before it is projected. A renamed
  or retyped contract field makes the event fail validation: it is logged with
  the exact problems, counted in `/health`'s `indexer.mismatchedEvents`, and
  never silently stored as zeros. Update the spec file together with the
  contracts.

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

## API

Base path `/api`. All amounts are strings in the token's smallest unit
(stroops for XLM) to avoid JavaScript float precision loss.

`/health` is a **liveness** probe and always answers 200, so a slow backfill
does not get the service restarted. `/ready` is a **readiness** probe: it
answers 503 (`starting` until the indexer's first pass, then `catching_up`)
while the projection trails the network by more than 120 ledgers, and 200
`ready` once it is within that threshold. Point orchestration readiness
checks at `/ready` and liveness checks at `/health`.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | Status (`starting`, `ok`, `catching_up`), indexer cursor, lag, data freshness (`freshnessSeconds`), spec-mismatch count, contract IDs, active RPC endpoint |
| `GET` | `/ready` | Readiness probe: `200 ready` once caught up, `503` (`starting`/`catching_up`) while behind |
| `GET` | `/api/plans?merchant=&limit=` | Published plans |
| `GET` | `/api/plans/:id` | One plan |
| `GET` | `/api/mandates?ids=&subscriber=&merchant=&status=` | Mandates |
| `GET` | `/api/mandates/:id` | One mandate |
| `GET` | `/api/mandates/:id/charges` | Settlement history |
| `GET` | `/api/due` | Mandates chargeable right now |
| `GET` | `/api/merchants/:address/summary` | Active mandates, revenue, MRR and ARR |
| `GET` | `/api/merchants/:address/forecast?days=30` | Projected charges over the next N days, net of fees |
| `GET` | `/api/subscribers/:address/summary` | Mandates and total paid |
| `GET` | `/api/subscribers/:address/upcoming?days=30` | Charges due over the next N days, with projected times |
| `GET` | `/api/stats` | Protocol totals, charge volume, fees and last indexed ledger |

`/api/mandates` also accepts `ids`, a comma-separated batch of up to 100
mandate ids (`?ids=1,2,3`). Ids that do not exist are omitted; more than 100
ids returns `400 { "error": "too_many_ids" }` and a non-numeric id returns
`400 { "error": "invalid_ids" }`.

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
| `POST` | `/admin/keeper/run` | Run one settlement pass now |
| `GET` | `/admin/keeper/backoff` | Mandates backing off after failed charges |

Triggered passes share one serialized runner with the scheduled loops, so a
trigger queues behind a pass that is still running instead of overlapping it —
overlap would race the cursor and, for the keeper, the account sequence
number. The keeper endpoints answer `503 keeper_unavailable` when the keeper
is off (`KEEPER_ENABLED=false`). A pass that fails answers 500 and the failure
is logged; the next scheduled pass retries as usual.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | RPC endpoint, or a comma-separated list to fail over between |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Network id |
| `PLAN_REGISTRY_ID` | — | Deployed registry contract |
| `VAULT_ID` | — | Deployed vault contract |
| `SUBSCRIPTION_ID` | — | Deployed subscription contract |
| `TOKEN_ID` | — | Default token for the flat merchant-summary amounts. Unset, they span every token |
| `KEEPER_ENABLED` | `false` | Turn on automatic settlement |
| `KEEPER_SECRET` | â€” | `S...` key that pays settlement fees. Required when the keeper is on |
| `KEEPER_SECRET_NEXT` | â€” | Standby `S...` key for zero-downtime rotation; see [Rotating the keeper key](#rotating-the-keeper-key-without-downtime) |
| `KEEPER_INTERVAL_MS` | `60000` | Settlement poll interval |
| `KEEPER_ORDER` | `oldest` | Order for due mandates: `oldest` (due date ascending) or `largest` (amount descending) |
| `INDEXER_INTERVAL_MS` | `10000` | Indexing poll interval |
| `INDEXER_FETCH_CONCURRENCY` | `4` | Ledger windows one pass may fetch at once (max 16). Applied in order; `1` is sequential |
| `INDEXER_START_LEDGER` | `0` | Where to start with no saved cursor. `0` starts from the oldest ledger RPC still serves |
| `DATABASE_PATH` | `./payflow.db` | SQLite file |
| `PORT` | `8080` | HTTP port |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP/HTTP collector base URL. Unset disables tracing at no cost |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | How long shutdown waits for in-flight passes |
| `ADMIN_TOKEN` | — | Bearer token for `/admin`. Unset keeps those routes disabled |

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

## Related repositories

| Repo | Role |
|---|---|
| [payflow-contract](https://github.com/MMM-pay/payflow-contract) | Soroban contracts this service indexes |
| [payflow-backend](https://github.com/MMM-pay/payflow-backend) | This repo |
| [payflow-frontend](https://github.com/MMM-pay/payflow-frontend) | Consumes this API |
| [payflow-docs](https://github.com/MMM-pay/payflow-docs) | Protocol documentation |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs `lint`, `typecheck`, `test`
and `build`; all four must pass. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

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
