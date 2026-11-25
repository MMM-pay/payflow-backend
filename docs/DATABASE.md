# Database schema

This page describes every table the service keeps and how the indexer turns
contract events into rows. It is for contributors who need to add a column,
write a query or understand why a number in the API looks the way it does.

The schema is defined in [`src/lib/db.ts`](../src/lib/db.ts) (SQLite) and
mirrored in [`src/lib/store/postgres.ts`](../src/lib/store/postgres.ts)
(PostgreSQL, used when `DATABASE_URL` is set). The PostgreSQL schema does not
yet have `audit_logs` or `past_due_mandates`. The event handlers that write
the projections live in [`src/indexer.ts`](../src/indexer.ts).

## Three kinds of table

Every table falls into one of three groups. The group decides what a rebuild
does to it.

| Kind | Tables | Source of truth | On `npm run rebuild:projections` |
| --- | --- | --- | --- |
| **Raw log** | `events`, `cursor` | The chain, via Soroban RPC | Kept; it is the input |
| **Projection** | `plans`, `mandates`, `plan_active_subscribers`, `plan_subscriber_counts`, `charges`, `vault_events`, `fee_history`, `mandate_events`, `mandate_timeline`, `merchant_profiles`, `contract_upgrades` | Derived from `events` | Emptied and replayed from `events` |
| **Operational** | `webhooks`, `webhook_deliveries`, `webhook_event_receipts`, `webhook_attempts`, `merchant_notification_preferences`, `charge_attempts`, `keeper_claims`, `audit_logs`, `past_due_mandates` | Written by the API, keeper or webhook dispatcher | Kept |

A projection can always be thrown away and rebuilt from the raw log, so it is
never authoritative for money (see [SECURITY.md](../SECURITY.md)). Operational
tables have no on-chain source, so losing them loses data: back them up.

## How events become rows

The indexer stores every event it receives in `events` first, verbatim, and
only then decodes it. Each decoded event is checked against
[`src/lib/event_spec.json`](../src/lib/event_spec.json). An event that does
not match is kept in `events` but not projected.

| Event | Contract | Writes |
| --- | --- | --- |
| `plan_created` | Plan registry | Upsert `plans` |
| `plan_status_changed` | Plan registry | `plans.active` |
| `profile_updated` | Plan registry | Upsert `merchant_profiles`, only if the event's ledger is not older than the stored row |
| `subscribed` | Subscription | Upsert `mandates`; `plan_active_subscribers` and `plan_subscriber_counts`; `mandate_events` (`start`); `mandate_timeline` |
| `charged` | Subscription | Insert `charges`; advance `mandates.charges_made`, `next_charge` and `last_charge`; `mandate_timeline` |
| `cancelled` | Subscription | `mandates.status = 'Cancelled'`, `ended_by = 'subscriber'`; subscriber counts; `mandate_events` (`departure`); `mandate_timeline` |
| `mandate_ended` | Subscription | `mandates.status = 'Cancelled'`, `ended_by = 'merchant'`; subscriber counts; `mandate_events` (`departure`); `mandate_timeline` |
| `mandate_completed` | Subscription | `mandates.status = 'Completed'`; subscriber counts; `mandate_events` (`departure`); `mandate_timeline` |
| `pause_changed` | Subscription | `mandates.status` between `Active` and `Paused`; subscriber counts; `mandate_timeline` |
| `fee_changed` | Subscription | Insert `fee_history` |
| `deposit`, `withdraw`, `debit` | Vault | Insert `vault_events` |
| `upgraded` | Any | Insert `contract_upgrades` |

Any other event name is stored in `events` and otherwise ignored.

### Replays change nothing

RPC windows overlap, the indexer can crash halfway through a ledger, and a
reindex replays history from the start. Every write is therefore idempotent:

- **Upserts keyed on the on-chain id** for current state (`plans`, `mandates`,
  `merchant_profiles`).
- **Insert-or-ignore on a natural key** for logs (`charges` on
  `(tx_hash, mandate_id)`, `vault_events` on `(tx_hash, kind, user, amount)`,
  `fee_history` on `tx_hash`, `mandate_timeline` on
  `(mandate_id, tx_hash, kind)`).
- **Guards against going backwards.** A `charged` event only advances a
  mandate whose `charges_made` is lower than the event's. A status change only
  applies if the row is still in the status it was read in.

### Time is the chain's clock

Timestamps on projection rows come from the close time of the ledger the
event was emitted in, not from the indexer's clock. A charge indexed live and
the same charge indexed on a backfill a month later get the same
`created_at`, so reports bucket them the same way. The one fallback: a
`charged` event with no close time is stamped with the indexer's clock and a
warning is logged.

### Amounts are strings

Token amounts (`amount`, `fee`, `balance`, `shortfall`) are `i128` on chain
and are stored as decimal strings in the token's smallest unit. Never read
them into a JavaScript `number`; use `BigInt`.

## Raw log

### `events`

Every contract event the indexer has fetched, kept as the original XDR even
when the current decoder does not understand it. This is what a rebuild
replays. Old rows are pruned after `RAW_EVENT_RETENTION_DAYS` (falling back to
`DATA_RETENTION_DAYS`); `0` keeps them forever.

| Column | Meaning |
| --- | --- |
| `event_id` | RPC event id, stable across overlapping windows. Primary key |
| `contract_id` | Emitting contract |
| `ledger` | Ledger sequence |
| `tx_hash` | Transaction hash |
| `event_index` | Position of the event in its transaction |
| `topics` | JSON array of base64 XDR `ScVal` topics |
| `data` | Base64 XDR `ScVal` payload |
| `close_time` | Ledger close time, unix seconds. Null if RPC did not report it |

Indexed on `(ledger, event_id)` for replay order and
`(contract_id, ledger, event_id)` for the raw event feed.

### `cursor`

A single row (`id = 1`) holding `last_ledger`, the last ledger fully applied.
The indexer resumes from here after a restart.

## Projections

### `plans`

One row per subscription plan, from `plan_created`.

| Column | Meaning |
| --- | --- |
| `id` | On-chain plan id |
| `merchant` | Merchant account (`G...`) |
| `name` | Plan name; `''` for plans created before names existed |
| `token` | Token contract (`C...`) |
| `amount` | Price per period, smallest unit |
| `period` | Billing period in seconds |
| `active` | `1` while the plan accepts subscribers; set by `plan_status_changed` |
| `ledger` | Ledger the plan was created in |

### `mandates`

One row per subscription (a subscriber's standing authorisation to be charged
for a plan), from `subscribed`, updated by every later lifecycle event.

| Column | Meaning |
| --- | --- |
| `id` | On-chain mandate id |
| `subscriber`, `merchant` | The two parties |
| `plan_id` | Plan subscribed to |
| `amount`, `period` | Terms copied from the plan at subscription time |
| `next_charge` | When the next charge is due, unix seconds. The keeper's due list reads this |
| `last_charge` | When the latest charge settled (`next_charge - period`); `0` before the first |
| `charges_made` | Charges settled so far |
| `max_charges` | Cap on charges; `0` means unlimited |
| `fee_bps` | Protocol fee in basis points at subscription time |
| `status` | `Active`, `Paused`, `Cancelled` or `Completed` |
| `ended_by` | `subscriber` or `merchant` once cancelled; null otherwise |
| `ledger` | Ledger of the `subscribed` event |

`(status, next_charge)` is indexed for the keeper. Several covering indexes
serve the merchant and subscriber summaries without touching the table.

### `plan_active_subscribers` and `plan_subscriber_counts`

The number of **distinct** subscribers with at least one `Active` mandate on
each plan. Kept incrementally so `GET /plans` never has to scan `mandates`.

- `plan_active_subscribers (plan_id, subscriber, mandate_count)`: one row per
  subscriber per plan, with how many of their mandates on that plan are
  active. The row is deleted when the count reaches zero.
- `plan_subscriber_counts (plan_id, active_subscribers)`: how many rows the
  table above has for each plan.

Both are updated whenever a mandate moves into or out of `Active`
(see [`src/lib/plan-subscribers.ts`](../src/lib/plan-subscribers.ts)).

### `charges`

Append-only log of settled charges, one row per mandate per `charged` event.
Keyed on `(tx_hash, mandate_id)` so a replay can never double-count revenue.

| Column | Meaning |
| --- | --- |
| `tx_hash`, `mandate_id` | Primary key |
| `subscriber`, `merchant` | Copied from the event topics |
| `amount` | Gross amount charged, smallest unit |
| `fee` | Protocol fee taken from it |
| `charges_made` | The mandate's count after this charge |
| `next_charge` | The mandate's next due time after this charge |
| `ledger` | Ledger sequence |
| `created_at` | Ledger close time, **unix milliseconds** |

Revenue, forecast, CSV export and protocol-fee reports all read this table.

### `vault_events`

Vault balance movements from `deposit`, `withdraw` and `debit`.

| Column | Meaning |
| --- | --- |
| `tx_hash`, `kind` | Transaction and event name |
| `user` | Vault owner |
| `token` | Token contract |
| `counterparty` | The other side of a `debit` (the merchant); null otherwise |
| `amount` | Amount moved |
| `balance` | The user's vault balance for the token after the event |
| `ledger` | Ledger sequence |

Because each row carries the resulting `balance`, a user's current balance is
the newest row for `(user, token)`; the `(user, token, ledger DESC)` index
serves that lookup.

### `fee_history`

Protocol fee changes from `fee_changed`: `tx_hash`, `old_fee_bps`,
`new_fee_bps`, `ledger`.

### `mandate_events`

The churn log behind `GET /merchants/:address/churn`. One row per mandate per
**slot**:

| Column | Meaning |
| --- | --- |
| `mandate_id`, `slot` | Primary key. `slot` is `start` or `departure` |
| `merchant` | Merchant the event is attributed to |
| `kind` | `started`, `cancelled`, `ended` or `completed` |
| `at` | Ledger close time, **unix seconds** |
| `ledger` | Ledger sequence |

Because `slot` is part of the key, a mandate has exactly one start and at most
one departure, so it can never be counted as leaving twice. An event with no
merchant or no close time is skipped here (the mandate row is still updated).

### `mandate_timeline`

Every lifecycle event of a mandate, for `GET /mandates/:id/timeline`. Kept
separate from `mandate_events` because that table deliberately collapses
history into two slots.

| Column | Meaning |
| --- | --- |
| `mandate_id`, `tx_hash`, `kind` | Primary key. `kind` is the event name |
| `ledger` | Ledger sequence |
| `at` | Ledger close time, unix seconds; may be null |
| `details` | JSON: `{ paused }` for `pause_changed`; `{ amount, fee, chargesMade }` for `charged`; `{}` otherwise |

### `merchant_profiles`

A merchant's self-declared display `name` and `url` from `profile_updated`,
one row per merchant. The contract does not verify either value. The upsert
only applies when the event's `ledger` is at least the stored one, so a
replayed older event cannot overwrite a newer profile.

### `contract_upgrades`

Code upgrades from `upgraded` events: `contract_id`, `tx_hash`, `ledger`,
`close_time`, `new_hash` (hex wasm hash) and `old_hash` (currently always
null). Keyed on `(contract_id, ledger, tx_hash)`.

## Operational tables

None of these come from the chain. A rebuild leaves them alone.

### `webhooks`

Merchant webhook registrations: `merchant`, `url`, signing `secret`,
`active`, and delivery health (`failed`, `failures`, `last_attempt`,
`last_status`). During a secret rotation, `previous_secret` keeps signing
beside the new one until `previous_secret_expires_at` (unix seconds; see
`WEBHOOK_SECRET_OVERLAP_S`).

### `webhook_deliveries`

The delivery queue: one row per event per webhook, with `status`
(`pending`, `delivered` or `failed`), `attempt`, `retry_at`, the `payload`
sent, an `idempotency_key`, and the last `http_status`, `response_body` and
`error`. `(status, retry_at)` is indexed for the dispatcher's due scan.

### `webhook_event_receipts`

`(webhook_id, event_key)` pairs recording that an event was already enqueued
for a webhook, so a replayed ledger does not deliver it twice. `event_key` is
the event id, plus `:<mandate_id>` for `charged`.

### `webhook_attempts`

Delivery history: one row per HTTP attempt, so a delivery that failed and
then succeeded shows both. Trimmed to the newest 100 rows per webhook on every
insert.

### `merchant_notification_preferences`

Which webhook event names each merchant wants: `merchant`, `events` (JSON
array) and `updated_at`. An empty list turns notifications off.

### `charge_attempts`

One row per keeper charge attempt: `attempted_at` (unix seconds), `result`
(`settled`, `failed` or `skipped` when the vault could not cover it),
`error_code`, `tx_hash`, `shortfall` for a skip, the mandate's failure streak
`failures` after the attempt and its next `retry_at`. A mandate's newest row
is its whole backoff state (#248): the keeper's due query skips a mandate
whose newest `retry_at` is still ahead (one seek on the `(mandate_id, id)`
index per candidate), so a restarted keeper, or another keeper on the same
database, resumes where it left off. Only the mandate's own failures grow
`failures`; network and keeper-signer failures keep it and retry after the
base delay (see the README's *Per-mandate backoff*). Rows older than
`CHARGE_ATTEMPT_RETENTION_DAYS` (90) are pruned, which is why
`KEEPER_BACKOFF_MAX_S` may not outlast it.

### `keeper_claims`

Settlement claims that stop two keeper workers or processes settling the same
charge. A worker claims `(mandate_id, due_at)` with one atomic upsert before
submitting anything. `owner` is the keeper instance; `expires_at` is when
another instance may take over (the claim TTL while in flight, the backoff
after a failure). Expired rows are pruned on each pass.

### `audit_logs`

Admin actions such as reindexes, keeper passes and data pruning: `action`,
`subject` (the id acted on), `details` (JSON), `success`, `error_msg` and
`created_at` (unix seconds). Served by `GET /admin/audit-logs`.

### `past_due_mandates`

Meant to track mandates that passed their due date without a charge
(`first_past_due_at`, `last_checked_at`, `still_past_due`).
`GET /admin/past-due` reads the rows where `still_past_due = 1`, but nothing
writes to the table yet, so that endpoint currently returns an empty list.

## Changing the schema

Schema changes are forward-only. A new table goes in `SCHEMA` with
`CREATE TABLE IF NOT EXISTS`. A new column on an existing table also goes in
`ADDED_COLUMNS`, and a new index on one goes in `ADDED_INDEXES`. `migrate()`
applies these only when they are missing, so restarts are no-ops. Make the
same change in `src/lib/store/postgres.ts`.

If you add a projection table, also add it to the list `rebuildProjections()`
empties in `src/indexer.ts`. Otherwise a rebuild will replay events on top of
stale rows.
