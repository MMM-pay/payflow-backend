# Security Policy

## Audit status

Unaudited. Testnet only. Do not point this service at mainnet contracts holding
real value.

## Scope

In scope: the indexer projection logic, the keeper's transaction construction
and signing, the REST API, and configuration handling.

Out of scope: the Soroban contracts (report in `payflow-contract`), the
frontend, and third-party RPC availability.

The API's trust boundaries, authentication and authorization model, and the
risks known and not yet fixed are written down in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). A finding listed there is
already known; a report that goes further than it, or a route it misses, is
welcome.

## Reporting

Do not open a public issue. Use GitHub private vulnerability reporting on this
repository, or email the maintainer in the README. Include reproduction steps
and impact. Acknowledgement within 72 hours.

## Operational notes

- **Enabled components fail closed on missing credentials.** Startup refuses
  `KEEPER_ENABLED=true` without `KEEPER_SECRET`, and refuses a configured
  `SEP10_SIGNING_KEY` without `SEP10_JWT_SECRET` and `SEP10_HOME_DOMAIN`.
  Leave the feature disabled when its credentials are not provisioned; set
  signing keys through the host's secret store, not a committed `.env`.
- **`KEEPER_SECRET` is a live signing key.** It pays transaction fees and
  nothing else — it holds no user funds and has no on-chain privilege — but a
  leak lets an attacker drain that account's XLM. Set it through the host's
  secret store, never in `render.yaml` or a committed `.env`.
- **The API is read-only and unauthenticated by design.** Everything it serves
  is already public on-chain. Do not add write endpoints without adding auth.
- **Admin and read-API credentials are strictly separate.** The operator routes
  (`/admin/*`) require `Authorization: Bearer <ADMIN_TOKEN>` and are absent
  unless `ADMIN_TOKEN` or `ADMIN_TOKENS` is set. They are mounted on a path that
  no read-API route can reach, and no read-API credential (including a SEP-10 JWT)
  is accepted there. Keep `ADMIN_TOKEN` in the host's secret store; rotate it if
  it is ever exposed, without touching `SEP10_SIGNING_KEY` or `SEP10_JWT_SECRET`.
- **Merchant notification preferences are account-scoped.** Reads and writes
  require a fresh signature from the merchant's Stellar key or a SEP-10 JWT
  issued to that same account. The update only accepts the supported webhook
  event names; an empty list disables notifications.
- **SQLite is a projection, not a source of truth.** It can be deleted and
  rebuilt from chain at any time. Never treat it as authoritative for money.
- **RPC history is bounded.** Soroban RPC retains a limited ledger window. A
  service offline longer than that window will have a gap; rebuild from a
  full-history provider rather than assuming the projection is complete.
- **Webhook URLs must resolve only to public IP addresses.** Registration and
  each delivery reject loopback, private, link-local, metadata and other
  non-public targets. DNS is checked again for each attempt and requests are
  pinned to the checked addresses; redirects are not followed. Update any
  existing webhook whose DNS points to an internal address.
- **HTTP request framing is strict.** A request carrying both `Content-Length`
  and `Transfer-Encoding`, duplicate or malformed framing headers, a transfer
  coding other than `chunked`, or a connection upgrade
  (`Upgrade`/`Connection: upgrade`) is rejected with `400 invalid_request` and
  the connection is closed. Clients must send a single, unambiguous framing.
  This is defense in depth against HTTP request smuggling; keep-alive reuse of a
  connection after such a rejection is not allowed.
- **CORS is an exact-origin allowlist.** `CORS_ORIGIN` lists the browser
  origins allowed to call the API, comma-separated and exactly as the browser
  sends them (`https://app.example`, `http://localhost:3000`). The default is
  empty: a deployment that has not listed its frontend gets no
  `Access-Control-Allow-Origin` and browsers refuse the cross-origin read.
  Set `CORS_ORIGIN=*` only for a deliberately public API. Entries are
  validated at startup: a path, query, credentials, a wildcard host or a
  `*` beside a list fails the boot rather than silently matching nothing.
  SEP-10 (`/api/auth`) always answers `*`, as that specification requires.
- **Security headers are set on every response.** `helmet` sets a strict CSP
  (`default-src 'self'`, `script-src 'self'` with no `unsafe-inline` or
  `unsafe-eval`, `frame-ancestors 'none'`, `object-src 'none'`),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, HSTS and the cross-origin isolation headers.
  `/api/docs` widens only `worker-src` to `'self' blob:` for ReDoc's worker;
  the bundle is served by this process, never a CDN. Framing the API or its
  documentation is refused by both the header and the CSP, including on error
  responses.
- **Duplicate event delivery is collapsed.** An event already present in the
  raw `events` table is not applied or counted again, so an overlapping RPC
  window, a replayed ledger range or a rewound cursor cannot inflate the
  projection's counters, the `payflow_events_applied_total` metric, or the
  number of webhook deliveries. A webhook receives at most one delivery per
  `(webhook, event)` pair; a repeated event carries the same
  `Idempotency-Key`, so a receiver can drop a repeat it has already
  processed.

