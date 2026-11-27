# API Conventions

This document describes the shared query conventions that apply across the
Payflow REST API. Every endpoint that lists, filters or sorts resources follows
these rules, so a caller can apply the same pattern everywhere.

The API is served under `/api/v1` (canonical) and `/api` (unversioned alias).
Both prefixes are identical; existing clients that use `/api` are unaffected
by versioning.

---

## Pagination

List endpoints use **cursor-based pagination** keyed on the row's internal
integer `id`. Cursor pages never skip or repeat a row when records are inserted
or deleted between page fetches, unlike offset pagination.

### Parameters

| Parameter | Type | Description |
|---|---|---|
| `cursor` | integer | The last `id` from the previous page. Rows with `id < cursor` are returned. Omit on the first request. |
| `limit` | integer | Maximum rows to return. Capped per endpoint (see table below). |

### Response shape

A paginated response includes a `nextCursor` field:

```json
{
  "rows": [...],
  "nextCursor": 1234
}
```

`nextCursor` is `null` when there are no further rows.

### Limits

| Endpoint | Default `limit` | Maximum `limit` |
|---|---|---|
| `GET /plans` | 50 | 200 |
| `GET /mandates` | 50 | 200 |
| `GET /merchants/:address/subscribers` | 50 | 200 |

Pass `limit=1` to probe whether any rows exist without fetching them all.

---

## Filtering

Filters are query string parameters. Only rows matching **all** supplied filters
are returned; omitting a filter means "no restriction on that field."

### Common filters

| Parameter | Applies to | Description |
|---|---|---|
| `merchant` | Plans, mandates | The merchant's Stellar address (`G...`). |
| `subscriber` | Mandates | The subscriber's Stellar address (`G...`). |
| `status` | Mandates | One of `Active`, `Cancelled`, `Completed`, `Ended`. |
| `q` | Plans | Case-insensitive substring match on the plan's `name`. |

### Address format

Every address parameter must be a valid Stellar ed25519 public key (`G...`,
56 characters). The API returns `400 invalid_request` with a field-level error
when an address is malformed.

---

## Sorting

List endpoints return rows **newest first**: descending by the internal `id`,
which monotonically increases with on-chain order. The sort is total and
stable: a tie on `id` is impossible because it is a primary key.

Time-based endpoints (`/revenue`, `/churn`, `/cohorts`) sort their buckets
**oldest first** within the response window so they can be rendered directly
as a time series.

---

## Time ranges and buckets

Endpoints that aggregate over time share these parameters:

| Parameter | Type | Description |
|---|---|---|
| `bucket` | string | The period size: `day`, `week` or `month`. Defaults to `month`. |
| `from` | integer | Range start, unix seconds (inclusive). |
| `to` | integer | Range end, unix seconds (exclusive). |
| `limit` | integer | Maximum number of buckets to return (most recent). |

Buckets are anchored to calendar UTC: a `day` bucket starts at UTC midnight,
a `week` bucket on Monday at UTC midnight, and a `month` bucket on the first
of the month. The bucket label for a `day` is `YYYY-MM-DD`; for a `week` it
is the Monday's date; for a `month` it is `YYYY-MM`.

All timestamps in time-range parameters are in **unix seconds**. Amounts and
close times in responses are in unix milliseconds (the chain's close time).

The window always covers every bucket between the first and last one that have
data, so a chart has no gaps. The `limit` trims the window to the most recent
N buckets.

---

## Error responses

Routes validate path parameters, supported query parameters and request bodies
before doing downstream work. Query parameters not listed for an endpoint,
repeated query values, malformed JSON, and unexpected body fields are rejected
with `400 invalid_request`. Numeric query values must use their documented
decimal form; the API does not parse exponent or hexadecimal notation.

All errors share the same envelope:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Human-readable description",
    "requestId": "uuid",
    "details": [
      { "path": "limit", "message": "must be a positive integer" }
    ]
  }
}
```

`details` is present only on `400 invalid_request` responses and lists each
invalid parameter. Common codes:

| HTTP status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | A parameter is malformed or out of range. |
| 401 | `unauthorized` | A protected route received no token or a bad one. |
| 403 | `unauthorized` | A scoped token lacks permission for this operation. |
| 404 | `not_found` | No resource at this path or id. |
| 429 | `rate_limited` | Too many requests; back off and retry. |
| 500 | `internal_error` | An unexpected server error; report if it persists. |
| 503 | `*_unavailable` | An optional subsystem (keeper, indexer) is not running. |

---

## Amounts

Every amount in the API is a **decimal string** in the token's smallest unit
(stroops for XLM, which has seven decimal places). JavaScript's `number` type
cannot represent all amounts exactly; always keep them as strings or `BigInt`.

The pattern throughout the API:

- `amount`: what the merchant receives per charge, net of the fee.
- `fee`: the protocol's share.
- `gross`: `amount + fee` — what the subscriber pays.
- `net`: `gross − fee` — the merchant's share (same as `amount`).

---

## Versioning

The canonical API root is `/api/v1`. The unversioned `/api` alias is a
permanent alias for `v1` and will not be removed until `v1` is retired under
the deprecation policy in `API_CHANGELOG.md`. Breaking changes are made in a
new version (`/api/v2`), never in-place.
