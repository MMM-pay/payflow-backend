# Settlement Keeper Runbook

Use this runbook when scheduled settlements are late, a keeper pass appears
stalled, or settlement attempts repeatedly fail. The keeper triggers the
permissionless on-chain `charge` operation; it holds no subscriber funds, but
every submitted transaction is a real production transaction and spends XLM
on fees.

## What the keeper does

The keeper reads active due mandates from the local projection, checks vault
funding and its persisted retry backoff, claims each due charge, simulates the
contract call, then signs and submits it through Soroban RPC. A successful
settlement is reflected in the projection after the indexer processes its
event. A failed attempt is recorded in `charge_attempts`; its backoff is
restored from that table on restart.

The long-running service runs a pass every `KEEPER_INTERVAL_MS` (60 seconds by
default) when `KEEPER_ENABLED=true`. `npm run keeper` runs one pass and exits.
The repository's testnet scheduler is
[`.github/workflows/keeper.yml`](../.github/workflows/keeper.yml): it indexes
first, then runs the keeper every 15 minutes, preserving the projection in an
Actions cache. Other deployments should use their configured process or
scheduler; do not assume that workflow monitors production.

## Symptoms and first checks

Common symptoms:

- Due mandates remain due while `payflow_charges_settled_total` does not move.
- `payflow_charges_failed_total` increases, or a mandate repeatedly appears in
  the keeper backoff list.
- A keeper process stops logging pass completion, or
  `payflow_keeper_in_flight` remains non-zero without progress.
- A scheduled Actions run fails, times out, or does not run.

Start with read-only checks:

```bash
# Projection, due counts, and configured keeper channels (no secrets printed)
npm run cli -- status

# Environment, database, RPC reachability and projection-lag preflight
npm run cli -- doctor

# Current due mandates and their last indexed funding status
npm run cli -- due

# On a running API, inspect keeper history (present when the keeper is enabled)
curl -fsS http://localhost:8080/api/keeper | jq .

# The API's health describes indexer/RPC state, not keeper liveness.
curl -fsS http://localhost:8080/health | jq .
curl -fsS http://localhost:8080/ready | jq .
```

`/metrics` is available only when `METRICS_ENABLED=true`. The keeper-related
metrics are process-local counters/gauges, not durable history:

| Metric | What to check |
|---|---|
| `payflow_keeper_passes_total` | Whether passes are running |
| `payflow_charges_settled_total` | Whether charges are completing |
| `payflow_charges_failed_total` | Whether attempts are failing |
| `payflow_keeper_in_flight` | Transactions currently awaiting completion |

For Compose deployments, inspect the combined service logs:

```bash
docker compose logs --tail=200 api
```

Look for `keeper enabled`, `keeper pass`, `keeper pass failed`, `charge skipped`,
`charge failed`, RPC errors and the public `mandateId`/transaction hash. On the
repository's scheduled testnet runner, inspect the `Keeper` workflow run and
its `Index` and `Settle due mandates` steps in GitHub Actions. Never copy
authorization headers, environment dumps, or secret key material into logs or
incident reports.

## Diagnose the failure

1. **Configuration and network.** Confirm the intended `STELLAR_NETWORK`,
   `NETWORK_PASSPHRASE`, subscription contract ID and `SOROBAN_RPC_URL` are
   configured for the keeper's default network. In a multi-network service,
   the keeper settles only the default network. `doctor` checks the
   configuration, database and RPC. `/health` reports the active RPC endpoint
   when one is available; it does not report keeper liveness.
2. **Signing account and fees.** `KEEPER_ENABLED=true` requires
   `KEEPER_SECRET`. Confirm the configured account is funded with enough XLM
   for fees using an approved Stellar account/balance tool. Only public keys
   may be shared for diagnosis; never reveal or paste `KEEPER_SECRET`,
   `KEEPER_SECRET_NEXT`, or channel secrets. The keeper needs fee funds, not
   user funds.
3. **Mandate and vault.** Run `npm run cli -- mandate <id>` and
   `npm run cli -- due`. The projected funding flag may lag the chain; the
   keeper reads the vault before settlement. An underfunded vault is skipped,
   not repaired by restarting the keeper.
4. **Attempt and retry state.** Read
   `GET /api/mandates/<id>/attempts` for the recent recorded outcomes. With
   admin credentials, `GET /admin/keeper/backoff` shows failures and the next
   retry time; `GET /admin/past-due` lists past-due mandates. These routes are
   absent unless the corresponding admin/keeper capabilities are configured.
   The initial failure backoff is one minute, doubles per failure, and caps at
   six hours. Success clears the backoff. Charge attempts are retained for 90
   days by default.
5. **RPC or transaction errors.** Check RPC availability and configured
   endpoint/network alignment before changing keys or retrying. Simulation
   errors often identify contract, authorization, sequence or resource issues;
   submission results may identify fee congestion or a stale sequence. The
   keeper retries a stale sequence a bounded number of times and retries
   congestion once with a higher fee up to `KEEPER_MAX_FEE`. Do not raise the
   fee cap or rotate keys without confirming the actual failure and approved
   operating limits.
6. **A stuck claim or in-flight transaction.** Claims prevent two keeper
   instances from settling the same due charge. A claim expires after
   `KEEPER_CLAIM_TTL_S` (300 seconds by default); a process crash can therefore
   delay another attempt until expiry. Do not delete `keeper_claims` rows or
   manually clear retry state. Wait for the in-flight RPC operation or claim
   to expire, then verify the on-chain state and recorded attempt before
   retrying.

## Safe recovery

1. Check that the mandate is still due, inspect its attempts/backoff, and
   confirm no other scheduled or long-running keeper is working on the same
   database. The database claim protects shared-store workers, but do not
   start overlapping jobs against independent projections.
2. Fix the cause first: restore RPC connectivity, correct the network/contract
   configuration, replenish the fee account through the approved funding
   process, or resolve vault underfunding with the account owner.
3. If the keeper process is unhealthy, use the deployment platform's normal
   graceful restart/redeploy procedure. `SIGTERM`/`SIGINT` stop the keeper from
   taking new mandates and allow in-flight settlements to finish until
   `SHUTDOWN_TIMEOUT_MS`; check logs for shutdown timeout before forcing a
   kill. Do not delete or rebuild the projection to recover a keeper.
4. Let the normal schedule retry after its persisted backoff, or—only after
   checking the due set and ensuring no overlapping pass—use the authenticated
   `POST /admin/keeper/run` operator endpoint or the configured one-shot
   `npm run keeper` process. Both can submit live transactions. Do not use
   `npm run cli -- charge <id> --yes` as a generic retry; that command directly
   submits a charge and bypasses the normal scheduled queue/backoff flow.
5. Do not reset the database, remove claims, or manually replay settlements.
   The contract/indexer flow is idempotent for projection replay, but that is
   not permission to submit duplicate transactions. Check the transaction
   hash/on-chain result and whether the indexer has applied the event before
   any manual action. `keeper_claims` protects workers sharing a database;
   independently provisioned databases do not share that protection.

## Verify recovery and escalate

Confirm that the keeper logs a completed pass, in-flight work returns to zero,
pass history advances, and success/failure counters behave as expected.
Re-check `npm run cli -- due` and the affected mandate's attempt history; a
settled charge should disappear from the due set after the indexer catches up.
For recurring deployments, confirm the next scheduled run also succeeds.

If recovery fails, escalate through the on-call/maintainer process with:

- deployment, version, network and public contract/account identifiers;
- UTC incident window, keeper process/job run ID, and sanitized relevant logs;
- `doctor` output, health/RPC state, due/backoff state and affected mandate IDs;
- attempt error codes and transaction hashes, plus whether each transaction is
  present on-chain.

Do not include secret seeds, admin tokens, bearer headers, `.env` files, or
unredacted credentials. Avoid manual production settlement until the
maintainer/on-call owner has confirmed the on-chain state and retry plan.
