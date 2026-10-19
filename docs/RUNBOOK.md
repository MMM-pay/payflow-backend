# Payflow Backend Operator Runbook

This runbook outlines operational procedures and recovery workflows for common incidents involving the Payflow backend service.

---

## Table of Contents
1. [Service Health & Diagnostic Commands](#1-service-health--diagnostic-commands)
2. [Incident 1: Indexer Stuck or Lagging](#2-incident-1-indexer-stuck-or-lagging)
3. [Incident 2: Soroban RPC Outage](#3-incident-2-soroban-rpc-outage)
4. [Incident 3: Keeper Out of XLM](#4-incident-3-keeper-out-of-xlm)
5. [Incident 4: Rotating the Keeper Key](#5-incident-4-rotating-the-keeper-key)
6. [Incident 5: Rebuilding the Database](#6-incident-5-rebuilding-the-database)
7. [Incident 6: Contract Redeploy](#7-incident-6-contract-redeploy)

---

## 1. Service Health & Diagnostic Commands

Use these commands to quickly inspect service state:

```bash
# Check service health, lag, and data freshness
curl -s http://localhost:8080/health | jq .

# Scrape the Prometheus metrics (only when METRICS_ENABLED=true)
curl -s http://localhost:8080/metrics

# Inspect indexer progress directly in SQLite
sqlite3 payflow.db "SELECT * FROM meta WHERE key = 'cursor';"

# View total mandates, plans, and charges projected
sqlite3 payflow.db "SELECT count(*) FROM plans; SELECT count(*) FROM mandates; SELECT count(*) FROM charges;"

# Check process logs using pino-pretty or journalctl
journalctl -u payflow-backend -n 100 --no-pager
# Or if running via Docker/Render CLI:
# render logs -s srv-xxxx --tail 100
```

### What the metrics say

`/metrics` is the history behind `/health`: `/health` says whether the
indexer is behind right now, the metrics say how long it has been.

| Metric | Alert on |
|---|---|
| `payflow_indexer_lag` | A lag that keeps growing: the indexer is not keeping up |
| `payflow_indexer_cursor` | A cursor that stops moving while the lag grows |
| `payflow_events_applied_total` | A counter that stops growing while the lag grows |
| `payflow_charges_settled_total` | No charges settled although mandates are due |
| `payflow_charges_failed_total` | Failures climbing: the keeper cannot settle |
| `payflow_keeper_passes_total` | A pass count that stops growing: the keeper is stuck |

The keeper logs a mandate it skipped because the vault could not cover it:

```bash
journalctl -u payflow-backend -g "cannot cover" --no-pager
```

Each line names the mandate and the shortfall, so a subscriber that needs a
top-up can be found without reading the chain.

---

## 2. Incident 1: Indexer Stuck or Lagging

### Symptoms
- `/health` reports `"status": "catching_up"` with a high `lag` (greater than 120 ledgers).
- `freshnessSeconds` increases continuously.
- Dashboard does not display recent subscriptions or charges.

### Diagnosis
Check if the cursor is advancing or failing on contract spec mismatch:
```bash
# Check recent indexer errors and cursor
curl -s http://localhost:8080/health | jq '.indexer | {cursor, latestLedger, lag, freshnessSeconds, lastError, mismatchedEvents}'

# Look for event mismatch logs
journalctl -u payflow-backend -g "does not match the contract spec" --no-pager
```

### Recovery Procedure
If the indexer process is frozen or hung on a slow RPC call, restart the service:
```bash
# Restart systemd service
sudo systemctl restart payflow-backend
```

If the cursor is stuck on a corrupt range or needs rewinding by 1,000 ledgers to replay events:
```bash
# 1. Stop backend service
sudo systemctl stop payflow-backend

# 2. View current cursor
CURRENT_CURSOR=$(sqlite3 payflow.db "SELECT value FROM meta WHERE key = 'cursor';")
echo "Current cursor: $CURRENT_CURSOR"

# 3. Rewind cursor by 1000 ledgers (or to a known good ledger)
NEW_CURSOR=$((CURRENT_CURSOR - 1000))
sqlite3 payflow.db "UPDATE meta SET value = '$NEW_CURSOR' WHERE key = 'cursor';"

# 4. Run standalone indexer to catch up and verify
npm run indexer

# 5. Restart backend service
sudo systemctl start payflow-backend
```

---

## 3. Incident 2: Soroban RPC Outage

### Symptoms
- Logs report `indexer pass failed` or `getEvents failed` with network timeout, HTTP 502/503, or connection refused.
- `/health` indexer reports `lastError: "fetch failed"` or `lastError: "rpc unavailable"`.

### Diagnosis
Test RPC responsiveness directly:
```bash
# Query the configured Soroban RPC endpoint
curl -s -X POST "https://soroban-testnet.stellar.org" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq .
```

### Recovery Procedure
If the primary RPC provider is degraded or down, switch to an alternative Soroban RPC endpoint:

```bash
# 1. Update the RPC URL in .env
sed -i 's|^SOROBAN_RPC_URL=.*|SOROBAN_RPC_URL="https://testnet.stellar.org/soroban/rpc"|' .env

# 2. If running via systemd, reload environment and restart
sudo systemctl restart payflow-backend

# 3. Verify health endpoint reports ok
curl -s http://localhost:8080/health | jq .
```

---

## 4. Incident 3: Keeper Out of XLM

### Symptoms
- Keeper logs: `charge skipped` or `Simulation failed: InsufficientBalance`.
- Keeper cannot submit settlement transactions due to lack of fee funds.

### Diagnosis
Check the keeper's public key and current balance:
```bash
# 1. Get the keeper's public key from logs
KEEPER_PUB=$(journalctl -u payflow-backend -g "keeper enabled" -n 1 --output cat | jq -r .keeper)
echo "Keeper public key: $KEEPER_PUB"

# 2. Query account balance via Horizon or RPC
curl -s "https://horizon-testnet.stellar.org/accounts/$KEEPER_PUB" | jq '.balances[] | select(.asset_type=="native")'
```

### Recovery Procedure
Fund the account with XLM:

**On Testnet (Friendbot):**
```bash
curl -s "https://friendbot.stellar.org?addr=$KEEPER_PUB" | jq .
```

**On Mainnet:**
Send 20 XLM from an operational wallet to `$KEEPER_PUB`:
```bash
# Using Stellar CLI
stellar tx send --source <OPERATOR_SECRET> --destination "$KEEPER_PUB" --amount 20
```

Verify balance and trigger a keeper pass:
```bash
npm run keeper
```

---

## 5. Incident 4: Rotating the Keeper Key

The service supports zero-downtime key rotation via `SIGHUP`.

### Procedure

1. **Generate and fund a new standby keypair:**
```bash
# Generate a new random Stellar keypair
stellar keys generate keeper-standby --network testnet

# Get public key and secret
STANDBY_PUB=$(stellar keys address keeper-standby)
STANDBY_SEC=$(stellar keys show keeper-standby)
echo "Standby Public Key: $STANDBY_PUB"

# Fund the standby keypair (testnet)
curl -s "https://friendbot.stellar.org?addr=$STANDBY_PUB"
```

2. **Add standby key to environment configuration:**
```bash
# Append KEEPER_SECRET_NEXT to .env
echo "KEEPER_SECRET_NEXT=\"$STANDBY_SEC\"" >> .env
```

3. **Reload process configuration without restart:**
```bash
# Send SIGHUP to the running backend process
PID=$(pgrep -f "dist/index.js" || pgrep -f "src/index.ts")
kill -HUP "$PID"

# Confirm config reload in logs
journalctl -u payflow-backend -n 20 --no-pager | grep "SIGHUP"
```

4. **Promote standby key to primary:**
Once the keeper has used the standby key or is ready to promote:
```bash
# Replace KEEPER_SECRET with the standby secret in .env and remove KEEPER_SECRET_NEXT
sed -i "s|^KEEPER_SECRET=.*|KEEPER_SECRET=\"$STANDBY_SEC\"|" .env
sed -i "/^KEEPER_SECRET_NEXT=/d" .env

# Send SIGHUP again to finalize rotation
kill -HUP "$PID"
```

---

## 6. Incident 5: Rebuilding the Database

Because indexing is idempotent by construction, SQLite can be safely wiped and rebuilt from the deployment ledger.

### Procedure

```bash
# 1. Stop the application service
sudo systemctl stop payflow-backend

# 2. Archive the existing database
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mv payflow.db "payflow.db.backup_${TIMESTAMP}"

# 3. Fast-sync the database from INDEXER_START_LEDGER using the standalone runner
npm run indexer

# 4. Verify rebuilt database state
sqlite3 payflow.db "SELECT count(*) AS mandates FROM mandates; SELECT count(*) AS charges FROM charges;"

# 5. Restart backend service
sudo systemctl start payflow-backend

# 6. Verify health endpoint
curl -s http://localhost:8080/health | jq .
```

---

## 7. Incident 6: Contract Redeploy

When smart contracts are redeployed to testnet or mainnet:

### Procedure

```bash
# 1. Stop the backend service
sudo systemctl stop payflow-backend

# 2. Update contract IDs and start ledger in .env
NEW_REGISTRY_ID="C..."
NEW_VAULT_ID="C..."
NEW_SUBSCRIPTION_ID="C..."
NEW_START_LEDGER=1234567

sed -i "s|^PLAN_REGISTRY_ID=.*|PLAN_REGISTRY_ID=\"$NEW_REGISTRY_ID\"|" .env
sed -i "s|^VAULT_ID=.*|VAULT_ID=\"$NEW_VAULT_ID\"|" .env
sed -i "s|^SUBSCRIPTION_ID=.*|SUBSCRIPTION_ID=\"$NEW_SUBSCRIPTION_ID\"|" .env
sed -i "s|^INDEXER_START_LEDGER=.*|INDEXER_START_LEDGER=$NEW_START_LEDGER|" .env

# 3. Archive old projection database
mv payflow.db "payflow.db.old_contracts_$(date +%Y%m%d)"

# 4. Run initial backfill
npm run indexer

# 5. Restart backend service
sudo systemctl start payflow-backend

# 6. Verify health endpoint reports new contract IDs
curl -s http://localhost:8080/health | jq .
```
