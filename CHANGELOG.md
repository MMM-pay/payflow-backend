# Changelog

All notable changes to payflow-backend. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added
- **A versioned API (#173).** Every route is served under `/api/v1/...` and
  `/api/...` remains an alias, mounted from the same router, so an existing
  client keeps working and a breaking change lands in the next version. The
  OpenAPI document lists both surfaces, and the typed client calls `/api/v1`.
- **A consumer schema artifact (#174).** `npm run schema` writes the OpenAPI
  3.1 document to `api-schema.json` and CI publishes it as the `api-schema`
  artifact. `test/consumer.test.ts` validates the golden response fixtures
  against the documented response schemas, so the published contract and the
  responses the tests see cannot drift apart.
- **A dev container (#176).** `.devcontainer/` uses Node 22, runs `npm ci`,
  installs the Stellar CLI and recommends the project's editor extensions, so
  a Codespace needs no host setup.
- **A readable API reference (#162).** `GET /api/docs` renders the OpenAPI
  document with ReDoc. The page, its bootstrap and the ReDoc bundle are all
  served by the service, so the reference works offline with no third-party
  CDN. The CSP is widened only with `worker-src 'self' blob:` for ReDoc's
  search worker; every other directive stays helmet's default.
- **The typed client as a standalone npm package (#163).**
  `@mmm-pay/payflow-client` is built from the same response types as the
  backend and has no runtime dependencies. It keeps its own version and
  changelog under `client/`, and `client-v*` releases publish it with npm
  provenance.
- **A mandate's charges can be filtered by date (#164).**
  `GET /api/mandates/:id/charges` accepts `from` and `to`, as unix seconds or
  ISO 8601 dates (a date covers its whole UTC day), and returns only charges
  whose ledger close time falls in the inclusive range. A `from` after `to` is
  `400 invalid_request`, and the filter is served by a
  `(mandate_id, created_at)` index.
- **A subscriber's payments can be exported as CSV (#165).**
  `GET /api/subscribers/:address/charges.csv` streams every settled charge
  oldest first, with date, merchant, plan, amount, fee and tx hash. Amounts
  are decimal strings in token units, and `from`/`to` bound the range.
- **Protocol fee revenue over time (#149).** `GET /api/protocol/fees` sums
  charge fees per `day`, `week` or `month` bucket of ledger close time,
  reading only the requested window through a covering index on
  `charges(created_at, fee)`.
- **Most popular plans (#148).** `GET /api/plans?sort=subscribers` ranks plans
  by active mandates, ties broken by plan id, counting each plan through a
  covering index on `mandates(plan_id, status)`.
- **Merchant profiles (#147).** The plan registry's `profile_updated` event is
  in the spec and projected into `merchant_profiles` (replay-safe: an older
  event never overwrites a newer profile), served at
  `GET /api/merchants/:address/profile` and joined onto plans as
  `merchantName`. The profile is self-declared and unverified.
- **Unpaid mandates report (#146).** `GET /api/merchants/:address/unpaid` lists
  the merchant's due mandates whose last known vault balance cannot cover the
  charge, using the same funded test as `/api/due`, with the shortfall and
  time overdue, longest overdue first.
- **SEP-10 sign-in for merchant-only endpoints (#141).** `GET /api/auth` issues
  a SEP-10 challenge signed with `SEP10_SIGNING_KEY`, and `POST /api/auth`
  verifies the signed challenge and returns a short-lived JWT. Webhook routes
  accept it as a bearer token beside their signed messages.
- **Webhook delivery history (#140).** Every delivery attempt is logged, the
  newest 100 per webhook, and served at `GET /api/webhooks/:id/deliveries`.
- **Webhook secret rotation (#139).** `POST /api/webhooks/:id/rotate` returns a
  new secret once; both secrets sign for `WEBHOOK_SECRET_OVERLAP_S`.
- **Webhook test events (#138).** `POST /api/webhooks/:id/test` delivers a
  signed `ping` through the normal path and reports status code and latency.
- **A coverage report with a minimum threshold (#49).** `npm run test:coverage`
  runs the tests with Node's own coverage and writes an lcov report to
  `lcov.info`, which CI uploads as an artifact. The `coverage` job
  fails when the line coverage of `src/` falls below the threshold
  `--test-coverage-lines` sets: 94%, the measured baseline of 96.63% minus
  two percentage points. No coverage tool is added as a dependency — the test
  runner already knows how to measure itself.
- **An operator CLI (#41).** `npm run cli -- <command>` answers the questions an
  incident asks — is the projection current, what does mandate 42 look like,
  what is due, settle this mandate, rebuild the projection — without an ad-hoc
  script or a hand-written SQL query. `status`, `mandate` and `due` read the
  projection only and need no network; `charge` and `reindex` use the keeper and
  the indexer themselves, so the CLI cannot drift from what the service does.
  Every command has its own `--help`. The two commands that change something
  refuse to run until `--yes` says so, amounts are printed as the decimal
  strings the projection stores, and no secret is ever printed. `status --api`
  adds the running instance's verdict and the live indexer's health — whether
  it is paused, what it last failed on, how many events it rejected — which the
  projection file on its own does not hold. `reindex --from` refuses to move
  the cursor *forwards*, because the ledgers in between would never be applied;
  `--skip-ahead` is how an operator accepts that gap on purpose.
- **An API changelog and a deprecation policy (#172).** `API_CHANGELOG.md`
  records what changed in the HTTP API apart from the service's own changelog,
  and states how long a deprecated field or route keeps working: one minor
  release of notice, announced in the response with `Deprecation` and `Sunset`
  headers and in the OpenAPI document with `deprecated: true`. The document's
  `externalDocs` links the file, and a test reads it to prove the link and the
  policy are both there.
- **Keeper dry-run mode (#38).** `KEEPER_DRY_RUN=true` makes a settlement pass
  rehearse instead of settle: every due charge is built and simulated against
  the RPC exactly as a real pass would — account lookup, inclusion fee,
  vault-balance skips and key rotation included — but the keeper stops after
  the simulation: nothing is signed, `sendTransaction` is never called, and
  backoff, pass history and metrics are left untouched. Each mandate answers
  `simulated`, carrying the simulation's error when the charge would fail, so
  an operator can exercise a first run on a new deployment before it costs a
  fee. The new variable is in the README's configuration table.
- **An OpenAPI description of the API (#7).** `GET /api/openapi.json` serves an
  OpenAPI 3.1 document covering every route and `/health`, with the parameters
  each route takes, the responses it answers and the schema of each body.
  Amounts are documented as decimal strings in the token's smallest unit, so a
  generated client knows not to read them as numbers. A test compares the
  document with the routes Express registers, so a route that is added without
  being documented fails the build.
- **Prometheus metrics (#9).** With `METRICS_ENABLED=true` the service serves
  `/metrics` in the Prometheus text format: gauges for the indexer's cursor,
  the latest ledger and the lag, and counters for the events applied, the
  charges settled, the charges failed and the keeper passes. The endpoint is
  off by default; the new variable is in `.env.example` and the README's
  configuration table.
- **The keeper skips mandates the vault cannot cover (#8).** Before it settles
  anything, the keeper reads `vault.balance(subscriber, token)` from the
  contract — a read-only simulation, no transaction and no fee — and skips a
  mandate whose amount the vault does not hold, logging the shortfall once per
  pass. A balance that cannot be read is not treated as a shortfall, so an RPC
  hiccup never stops a settlement. `GET /api/due` gained a `funded` flag per
  mandate, computed from the last vault balance the indexer saw.
- **Merchant revenue over time (#12).** `GET /api/merchants/:address/revenue`
  reports what a merchant took in, what the protocol took and what was left,
  in `day`, `week` or `month` buckets: `gross`, `fee` and `net` per bucket,
  all decimal strings in the token's smallest unit. The buckets come from the
  close time of the ledger each charge was emitted in, so the report is the
  chain's own history and replaying a ledger range leaves it unchanged. The
  typed client gained `merchantRevenue`.
- **Request validation (#14).** Query and path parameters are validated with
  zod instead of being cast: an address must be a real Stellar StrKey (an
  account `G...` or a contract `C...`, checksum included), a `status` must be
  one the projection writes, an id must be a positive integer and a `limit`,
  `days` or `bucket` must be a value the API knows. A bad one is answered
  with `400 invalid_request` and an `error.details` list naming it, so a
  client bug looks like an error instead of an empty page. Valid requests are
  unaffected.
- **Local development with Docker (#11).** `docker-compose.yml` runs the
  service from the same `Dockerfile` the deployment uses, reads `.env` and
  keeps the projection on a named volume, so `docker compose up` is enough to
  run the backend. CI builds the image (and pushes nothing), so a Dockerfile
  that no longer builds is caught before it reaches a deployment.
- **Parallel settlement with keeper channel accounts (#36).** Extra signing
  accounts listed in `KEEPER_CHANNEL_SECRETS` become parallel settlement
  channels: due mandates are pulled from one shared queue by one worker per
  channel, so every account sequences its own transactions (paying its own
  fees) while channels settle concurrently — a single key manages only a few
  charges per minute and large merchants were billed hours late. A channel
  whose account cannot pay is skipped for the pass (logged by public key) and
  its share settles through the live channels instead of backing off against
  a dead key; with one channel the pass is the old sequential behaviour and
  makes no extra RPC call. A fee-bump design was rejected because a fee bump
  consumes the *fee source's* sequence number, which would serialize every
  transaction against the main key again. Tested with three channels: no
  sequence-number collisions, all channels sign, results keep due order.
- **Merchant churn metrics (#30).** `GET /api/merchants/:address/churn` reports
  how a merchant's mandate base moved over time: mandates started, cancelled
  by the subscriber, ended by the merchant, and completed, plus the net, in
  `day`, `week` or `month` buckets. The indexer records each lifecycle event
  in a new `mandate_events` log stamped with the ledger's close time, so the
  buckets are the chain's calendar and not the indexer's wall clock, and
  replaying a ledger range leaves the report unchanged.
- **Per-plan statistics (#29).** `GET /api/plans/:id/stats` reports a plan's
  active and total mandates, cancellations, gross amount collected and the
  average number of settled charges per mandate, so merchants can compare
  plans side by side. The collected total stays a decimal string in the
  token's smallest unit, and an unknown plan is `404 plan_not_found`.
- **Zero-downtime keeper key rotation (#71).** The keeper accepts a standby
  key in `KEEPER_SECRET_NEXT`: if the active key's source account is unusable
  it rotates mid-pass and retries the same mandate, and after a pass settles
  with the new key it logs that the previous key can be retired. Secrets are
  reloaded on `SIGHUP` (`.env` re-read, config re-validated) so promotion of
  the standby needs no restart. Tested by swapping keys between passes.
- **Typed API client (#72).** `src/client/index.ts` is a small typed fetch
  client for every endpoint, returning the same response types the route
  handlers annotate their bodies with (`src/routes/types.ts`) — shared, not
  copied. Exposed as the `payflow-backend/client` subpath after `npm run
  build` and tested against the HTTP test server.
- **Spec-driven event decoding (#73).** Event shapes live in the committed
  contract spec `src/lib/event_spec.json`. The indexer validates every
  decoded event before projecting it: mismatches (renamed fields, wrong
  types, extra data or topics) are logged with the exact problems, counted
  per pass in `TickResult.mismatched` and in `/health`'s
  `indexer.mismatchedEvents`, and never stored as zeros.
- **`arr` on the merchant summary.** `/api/merchants/:address/summary` now
  reports annual recurring revenue next to `mrr`: every active mandate
  normalised to a 365-day year. Both formulas are documented in the README.
- **Parallel window backfill (#59).** The indexer fetches up to
  `INDEXER_FETCH_CONCURRENCY` (default 4, max 16) 8,000-ledger windows at
  once and applies them in ledger order. The cursor advances only after a
  window is applied, so a failed later window resumes at the last applied
  one; `1` restores strictly sequential reads.
- **Batch mandate lookup (#61).** `/api/mandates?ids=1,2,3` returns up to 100
  mandates in one request. Unknown ids are omitted, more than 100 ids is
  `400 too_many_ids`, and a non-numeric id is `400 invalid_ids`. The typed
  client's `MandatesQuery` gained `ids`.
- **SQL template lint rule (#65).** ESLint rejects `prepare()` calls whose
  SQL is an interpolated template literal. Vetted static fragments carry an
  explained `eslint-disable-next-line` comment, and a test runs the real
  config against a deliberately bad query to prove the rule fires.
- **Volume and fee statistics (#55).** `/api/stats` reports 24-hour and all-time
  charge volume (gross: net amount plus protocol fee), total fees and the
  number of merchants with an active mandate, alongside the existing counts.
  Amounts are decimal strings.
- **RPC endpoint failover (#60).** `SOROBAN_RPC_URL` now accepts a comma-separated
  list. Calls go to the active endpoint and switch to the next when one fails;
  a health probe prefers the endpoint with the freshest ledger, so a reachable
  but lagging node does not hold the indexer back either. `/health` reports the
  active endpoint and the full list under `rpc`.
- **`/api/subscribers/:address/upcoming` (#62).** Projects each active mandate's
  charges over the next `days` (default 30, capped at 365), following the
  contract's scheduling rule — a due mandate at `now`, a future one at its
  `next_charge`, then every `period` — and stops at a mandate's remaining
  `max_charges` allowance. Each entry is the gross per-charge the subscriber
  pays, with the projected time; `truncated` flags the per-mandate cap.
- **`/ready` readiness probe (#58).** Answers 503 (`starting`, then `catching_up`)
  until the indexer's projection trails the network by no more than 120
  ledgers, so orchestrators do not route traffic to an instance that is still
  backfilling. `/health` stays a liveness probe answering 200.
- **Merchant revenue forecast (#63).** `/api/merchants/:address/forecast` projects
  the charges a merchant's active mandates will produce over the next `days`
  (default 30, capped at 365), each occurrence net of the mandate's fee, and
  returns the window and assumptions it used.
- **Token-protected `/admin` operator endpoints (#64).** Trigger an indexer pass,
  run a keeper pass, or read the keeper's backoff list. They exist only when
  `ADMIN_TOKEN` is set, require `Authorization: Bearer`, and the token is
  compared in constant time. Triggered passes queue behind any pass already
  running rather than overlapping it.
- **Dependabot and an audit gate**: weekly npm and GitHub Actions updates, and
  CI now fails on high or critical advisories in production dependencies
  (`npm audit --omit=dev --audit-level=high`).
- **Container image on release**: pushing a `v*` tag builds the Dockerfile and
  publishes `ghcr.io/mmm-pay/payflow-backend:<version>` to GHCR.
- **A Dockerfile and Fly.io configuration**: a multi-stage image that runs the
  API and indexer as a non-root user, and a `fly.toml` with a volume for the
  SQLite file, `/health` checks and autostop.
- **Several networks from one instance**: `NETWORKS` lists extra networks
  beside the default one. Each gets its own indexer, cursor and SQLite
  database, and its routes under `/api/<name>/...`; unprefixed routes keep
  serving the default network unchanged. `/health` reports every network.
- A route test suite for two configured networks.
- **Cursor pagination for list endpoints (#3).** `GET /api/plans` and
  `GET /api/mandates` accept an opaque `?cursor=` and return `nextCursor`,
  keyed on the primary key (`id DESC`) instead of an offset, so clients can
  page past the 200-row cap. `nextCursor` is `null` on the final page, the
  existing `limit` behaviour is unchanged (capped at 200), and an invalid
  cursor is answered `400 invalid_request`. The typed client gained `cursor`
  on `PlansQuery` and `MandatesQuery`, and the OpenAPI document gained the
  parameter and `nextCursor` on both pages.
- **Full-history archive backfill (#4).** The indexer detects when the stored
  cursor falls behind the oldest ledger the RPC still serves, logs a
  structured warning naming the exact missing ledger range, and refuses to
  advance the cursor past the gap unless `ALLOW_GAPS=true` is set. With
  `ARCHIVE_URL` configured, an `HttpArchive` backfills the gap with
  idempotent event application before indexing continues, so a service
  offline longer than RPC retention does not silently under-report. Both
  variables are in `.env.example` and the README's configuration table.
- **Webhook dispatcher for charge events (#5).** Merchants register a URL
  with `POST /api/webhooks`, proving control of their Stellar address with an
  ed25519 signature. Each `charged` event dispatches a signed `POST`
  (`Payflow-Signature: sha256=<hex>` HMAC, `Idempotency-Key` for at-least-once
  delivery) per registered webhook. Failing deliveries retry with exponential
  backoff for at most five attempts before the webhook is marked failed. The
  indexer's `events` feed drives delivery, and a short-cadence retry pass
  makes progress between indexer passes.
- **Replay test against recorded testnet events (#6).** `test/fixtures/replay-events.json`
  records five real `getEvents` responses from the deployed contracts, and
  `test/replay.test.ts` replays them through `decodeEvent` and the projection,
  asserts the resulting database state matches a committed snapshot, and proves
  that replaying the fixture twice leaves the database unchanged.

### Changed

- **The indexer's idempotency is tested under random orderings (#48).** The
  projection was checked against a handful of hand-written replays. A seeded
  generator now builds a random history across several mandates, plans and
  vault rows, applies it in ledger order, and applies the same history again
  as a shuffled, repeated replay; the two projections have to be identical.
  The seed is part of the test, so a failure is reproducible. The two orderings
  the projection does not survive — an update that arrives before the row it
  updates, and a pause that arrives after the unpause that followed it — are
  pinned down by their own tests, so what the property relies on is written
  down rather than assumed.

- **The test files are type-checked (#50).** `tsconfig.json` only covered
  `src/`, so a type error in a test was never reported: it surfaced as a
  confusing runtime failure, or not at all. A `tsconfig.test.json` now covers
  `test/` as well, the CI typecheck job runs it, and `npm run typecheck` runs
  both. The types that were wrong are fixed, not worked around.
- **A mandate that does not exist has no charges (#10).**
  `GET /api/mandates/:id/charges` used to answer `200` with an empty list for
  an unknown id, so "no such mandate" and "no charges yet" looked the same. It
  now answers `404 mandate_not_found`, like `GET /api/mandates/:id` does.
- **A charge is stamped with the chain's clock (#13).** `charges.created_at`
  was the moment the indexer happened to see the charge, so every charge
  indexed in one backfill shared one timestamp and any time-based view of the
  history was wrong after a redeploy. It is now the close time of the ledger
  the charge was emitted in, in unix milliseconds. The row is still written
  with `INSERT OR IGNORE`, so replaying a ledger range leaves the stored value
  untouched — which also means a row written before this change keeps the
  timestamp it was given. A charge whose event carried no close time falls
  back to the indexer's wall clock, and says so in the log.
- **Parameters the API does not accept are refused (#14).** `?status=whatever`,
  `/api/plans/abc`, a mistyped address and a malformed `limit` used to be
  cast and quietly matched nothing, so a client bug looked like an empty
  page. They are now `400 invalid_request`, with `error.details` naming the
  parameter and what was expected. Valid requests are unaffected, and an
  empty value (`?merchant=`) still means "no filter".
- **An empty `OTEL_EXPORTER_OTLP_ENDPOINT` means tracing is off.** The shipped
  `.env.example` leaves the variable blank, and a container that reads that
  file used to refuse to start over a URL that is not there.
- **Summary query indexes (#66).** Covering indexes for the merchant and
  subscriber summary aggregates (`mandates(merchant, status, period, amount)`,
  `charges(merchant, amount)`, `charges(subscriber, amount, fee)`) are added
  through the startup migration, so existing databases gain them without a
  rebuild. `EXPLAIN QUERY PLAN` now reports covering-index searches instead
  of table lookups.
- **One router per resource (#74).** `src/routes/index.ts` is split into
  `plans.ts`, `mandates.ts`, `merchants.ts`, `subscribers.ts` and `stats.ts`
  with shared query helpers in `helpers.ts`. No change in behaviour: paths,
  query handling and response shapes are identical and the existing API
  tests pass unchanged.

- **Express 5 (#77).** `express` and `@types/express` move to 5.x. No removed
  API was in use — no `app.del`, no `res.send(status)`, no wildcard or
  regex paths for path-to-regexp v8 to reject — so routes and response shapes
  are untouched and payflow-frontend needs no migration note. What does change
  is where a failure lands: Express 5 awaits a handler's result and forwards a
  rejected promise to the error middleware, so an `async` route no longer needs
  a manual `try`/`catch` to avoid leaving the caller hanging with an unhandled
  rejection. The four-argument handler in `src/app.ts` is now the single
  boundary for every failure, is exported as `errorHandler`, hands back errors
  whose response has already started, and logs `loggableError(err)` (type,
  message, status, stack) instead of the raw error — `body-parser` hangs the
  caller's request body off its `SyntaxError`, and that must not reach a log
  line.

### Fixed

- **Merchant totals no longer mix tokens (#56).** `/api/merchants/:address/summary`
  summed every charge into one figure even when the merchant's plans used
  several tokens. Revenue and MRR are now also grouped per token in a `tokens`
  array, and the flat fields report the default token (`TOKEN_ID`) when one is
  configured — without one they keep their previous all-token meaning.

### Security

- Patched transitive advisories in `proxy-addr` (critical) and `qs`
  (moderate) with `npm audit fix`; the production audit is clean.


## [0.2.0] - 2026-10-09

Points at the v0.2.0 contract suite on testnet.

### Fixed

- **The keeper could stall behind failing mandates.** Every pass retried the
  25 oldest due mandates first, so 25 underfunded vaults blocked every other
  mandate indefinitely. A failed charge now backs off (1 minute, doubling, up
  to 6 hours) and a success clears it.
- **Passes could overlap.** Indexer and keeper ran on `setInterval`, so a pass
  slower than the interval ran alongside the next one. Overlapping indexer
  passes could move the cursor backwards; overlapping keeper passes submitted
  transactions with the same sequence number. Each loop now waits for its pass
  to finish.
- **A fresh indexer saw only the last ~11 hours.** With no cursor it started
  8,000 ledgers back. It now starts at `INDEXER_START_LEDGER` or, if unset, the
  oldest ledger the RPC node serves, and moves a cursor that fell out of
  retention forward instead of failing.
- **Ranges could end early.** A page with fewer than 200 events was taken to
  mean the range was exhausted. Paging now continues until a page is empty or
  passes the end of the range, which is passed to RPC as `endLedger`.
- **`npm run indexer` indexed one window and exited.** It now runs until it has
  caught up.
- **`npm run lint` could not run**: ESLint was not installed. ESLint 9 with
  typescript-eslint is configured and CI enforces it.
- **The Render blueprint could not deploy on the free plan**, which has no
  persistent disk. It now rebuilds the projection from the deployment ledger.

### Added

- `mandate_ended` events (a merchant ending a mandate) are projected as
  `Cancelled`, and mandates record who ended them in `ended_by`.
- `/health` reports `starting`, `ok` or `catching_up`, the indexer cursor, its
  lag behind the network, and the last error.
- A scheduled GitHub Actions keeper that settles due testnet mandates without
  an always-on server.

### Changed

- `@stellar/stellar-sdk` 13 → 17, for testnet's current protocol.
- 24 → 39 tests, including indexer sync against a fake RPC node, keeper
  backoff, and loop overlap.

## [0.1.0] - 2026-09-02

Event indexer, settlement keeper and read API for the first testnet
deployment.

[Unreleased]: https://github.com/MMM-pay/payflow-backend/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MMM-pay/payflow-backend/releases/tag/v0.2.0
