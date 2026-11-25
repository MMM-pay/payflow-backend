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
- **Production serves HTTPS only.** With `NODE_ENV=production` (set by the
  Docker image) or `REQUIRE_HTTPS=true`, a request that did not arrive over
  TLS is rejected with `403 forbidden` instead of redirected, since anything it
  carried has already crossed the wire in clear. The scheme comes from
  `X-Forwarded-Proto` set by the single trusted proxy hop, so the service must
  sit behind a TLS-terminating proxy (Fly, Render, a load balancer).
  `/health`, `/ready` and `/metrics` stay reachable over plaintext for
  platform probes. Every response carries
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  (`HSTS_MAX_AGE_S` tunes it). Set `REQUIRE_HTTPS=false` only for a deployment
  that terminates TLS without forwarding the scheme.
- **HTTP request framing is strict.** A request carrying both `Content-Length`
  and `Transfer-Encoding`, duplicate or malformed framing headers, a transfer
  coding other than `chunked`, or a connection upgrade
  (`Upgrade`/`Connection: upgrade`) is rejected with `400 invalid_request` and
  the connection is closed. Clients must send a single, unambiguous framing.
  This is defense in depth against HTTP request smuggling; keep-alive reuse of a
  connection after such a rejection is not allowed.

