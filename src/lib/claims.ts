import type { Storage } from "./store/types.ts";

/**
 * Settlement claims (#249).
 *
 * Before a keeper submits a charge it claims that *due charge* — a mandate at
 * one `next_charge` — in `keeper_claims` with a single atomic upsert. The
 * upsert inserts a fresh row, or takes over an existing one only when it has
 * expired, and reports through `RETURNING` whether this caller now holds it.
 * Both SQLite and PostgreSQL evaluate that statement atomically, so two
 * workers in one process or two keeper processes sharing a database cannot
 * both win the same charge: exactly one settles it, the other skips it.
 *
 * Keying the claim by `(mandate_id, due_at)` rather than the mandate alone
 * means the claim covers one billing period. Once the indexer advances the
 * mandate's `next_charge`, the next period is a new key and claimable at
 * once, while a keeper still holding the stale due list keeps losing the old
 * key until it expires.
 *
 * A claim is never deleted by its owner; it is re-timed instead (see
 * {@link holdClaim}), and rows past their expiry are pruned on each pass.
 */

export interface ClaimRequest {
  mandateId: number;
  /** The mandate's `next_charge` this claim settles. */
  dueAt: number;
  /** The keeper instance asking; never a secret. */
  owner: string;
  /** Current unix seconds. */
  now: number;
  /** Seconds the claim lasts unless re-timed. */
  ttlSeconds: number;
}

/**
 * Claim one due charge. Resolves true when this owner now holds it, false
 * when another owner holds an unexpired claim on the same charge.
 */
export async function claimCharge(db: Storage, request: ClaimRequest): Promise<boolean> {
  const row = await db.get<{ mandate_id: number }>(
    `INSERT INTO keeper_claims (mandate_id, due_at, owner, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (mandate_id, due_at) DO UPDATE
       SET owner = excluded.owner, expires_at = excluded.expires_at
       WHERE keeper_claims.expires_at <= ?
     RETURNING mandate_id`,
    [request.mandateId, request.dueAt, request.owner, request.now + request.ttlSeconds, request.now],
  );
  return row !== undefined;
}

/**
 * Re-time a claim this owner holds so it lapses at `until`: the backoff's
 * retry time after a failure (so no other keeper retries sooner), or a
 * short hold after a settlement while the indexer catches up. A claim taken
 * over by another owner in the meantime is left alone.
 */
export async function holdClaim(
  db: Storage,
  claim: { mandateId: number; dueAt: number; owner: string; until: number },
): Promise<void> {
  await db.run(
    "UPDATE keeper_claims SET expires_at = ? WHERE mandate_id = ? AND due_at = ? AND owner = ?",
    [claim.until, claim.mandateId, claim.dueAt, claim.owner],
  );
}

/** Drop claims that have expired; a range delete on the expires_at index. */
export async function pruneClaims(db: Storage, now: number): Promise<void> {
  await db.run("DELETE FROM keeper_claims WHERE expires_at <= ?", [now]);
}
