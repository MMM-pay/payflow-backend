# API changelog

Changes to the **HTTP API** — routes, request parameters, response fields,
status codes and error codes — in the order a client meets them.
[CHANGELOG.md](CHANGELOG.md) records changes to the service as a whole (the
indexer, the keeper, the build, the deployment). This file is the one to read
before upgrading an integration.

Both files follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [semantic versioning](https://semver.org/). The API version is
the one the service serves at `GET /api/openapi.json` (`info.version`), and it
moves with the service's own.

## Deprecation policy

An integration has to be able to plan an upgrade, so a field, parameter or
route is never removed in the release that deprecates it.

- **One minor release of notice.** A response field, request parameter, route
  or error code that is going away is announced in one minor release and keeps
  working through it. The release that removes it comes after; a major release
  is the usual place, and a minor one may do it only if the deprecation was
  announced at least one minor release earlier.
- **The response says so.** A route that returns a deprecated field, or a
  route that is itself deprecated, answers with:

  - `Deprecation: @<unix seconds>` — the timestamp of the release that
    announced it ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745.html)).
  - `Sunset: <HTTP date>` — the date after which the field or route may be
    gone, never earlier than that release's announcement plus one minor
    release.
  - `Link: <https://github.com/MMM-pay/payflow-backend/blob/main/API_CHANGELOG.md>; rel="deprecation"`
    — the entry below that names the replacement.

- **The document says so.** A deprecated operation, parameter or schema
  property carries `deprecated: true` in `GET /api/openapi.json`, and its
  `description` names the replacement, so a generated client warns while it is
  being generated instead of failing at runtime.
- **This file says so.** Every deprecation is an entry under `Deprecated` in
  the release that starts the clock, naming what replaces it and the earliest
  release and date the old form may disappear.
- **Additions are not deprecations.** A new optional field, parameter or route
  is not a breaking change and needs no notice; clients are expected to ignore
  fields they do not know. A rename is a removal plus an addition, and follows
  the rules above.
- **A security fix can skip the window.** A field or route that leaks data or
  cannot be made safe may be removed immediately; the entry says which, and
  why. Nothing else skips it.
- **Enum values.** A new value can appear in an existing enum at any time, so
  a client must treat an unknown value as unknown rather than as an error. A
  value that is removed follows the rules above.

Nothing is deprecated today: there are no `Deprecation` or `Sunset` headers in
any response, and no `deprecated: true` in the OpenAPI document.

## Since 0.2.0 (unreleased)

Compiled from the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md); the
release that ships them numbers them here.

### Added

- `GET /api/openapi.json` — an OpenAPI 3.1 description of every route.
- `GET /ready` — a readiness probe answering `503` while the projection trails
  the network by more than 120 ledgers. `/health` stays a liveness probe.
- `GET /metrics` — Prometheus metrics, only when `METRICS_ENABLED=true`.
- `GET /api/plans/:id/stats` — per-plan mandates, cancellations, collected
  amount and average charges per mandate.
- `GET /api/merchants/:address/revenue` — gross, fee and net per `day`, `week`
  or `month` bucket.
- `GET /api/merchants/:address/churn` — mandates started, cancelled, ended and
  completed per bucket, and the net.
- `GET /api/merchants/:address/forecast` — projected charges over the next N
  days, net of fees.
- `GET /api/subscribers/:address/upcoming` — charges due over the next N days,
  with their projected times.
- `GET /api/mandates?ids=` — up to 100 mandates in one request.
- `POST /api/webhooks` — register a URL for signed `charged` events.
- `/api/<network>/...` — every route again, per configured network.
- `/api/mandates` and `/api/plans` accept `?cursor=` and return `nextCursor`.
- `/api/stats` reports charge volume and fees; `/api/due` gained `funded`;
  `/api/merchants/:address/summary` gained `arr` and per-token totals;
  `/health` reports the active RPC endpoint and the full list.

### Changed

- **Parameters the API does not accept are now refused.** `400
  invalid_request`, with `error.details` naming the parameter, instead of an
  empty page: a mistyped address (checksum included), an unknown `status`, a
  non-numeric id, an oversized `limit`.
- **An unknown mandate's charges are `404 mandate_not_found`** rather than
  `200` with an empty list.
- **`charges.created_at` is the ledger's close time** in unix milliseconds, not
  the moment the indexer saw the charge. Rows written earlier keep the value
  they were given.

## [0.2.0] - 2026-10-09

### Added

- `GET /health` reports `starting`, `ok` or `catching_up`, the indexer cursor,
  its lag behind the network and the last error.
- `mandate_ended` events are projected as `Cancelled`, and a mandate records
  who ended it in `ended_by`.

## [0.1.0] - 2026-09-02

- The first API: `/api/plans`, `/api/mandates`, `/api/merchants/:address/*`,
  `/api/subscribers/:address/*`, `/api/vault/:address*`, `/api/protocol`,
  `/api/due` and `/health`. Every amount is a decimal string in the token's
  smallest unit.
