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

- **`KEEPER_SECRET` is a live signing key.** It pays transaction fees and
  nothing else — it holds no user funds and has no on-chain privilege — but a
  leak lets an attacker drain that account's XLM. Set it through the host's
  secret store, never in `render.yaml` or a committed `.env`.
- **The API is read-only and unauthenticated by design.** Everything it serves
  is already public on-chain. Do not add write endpoints without adding auth.
- **SQLite is a projection, not a source of truth.** It can be deleted and
  rebuilt from chain at any time. Never treat it as authoritative for money.
- **RPC history is bounded.** Soroban RPC retains a limited ledger window. A
  service offline longer than that window will have a gap; rebuild from a
  full-history provider rather than assuming the projection is complete.
