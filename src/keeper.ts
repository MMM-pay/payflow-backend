import type { DatabaseSync } from "node:sqlite";
import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { Config } from "./config.ts";
import { logger } from "./lib/logger.ts";
import type { KeeperPassSummary } from "./routes/types.ts";

export interface DueMandate {
  id: number;
  subscriber: string;
  merchant: string;
  next_charge: number;
  /** Decimal string in the token's smallest unit; never a JS number. */
  amount: string;
}

/** The RPC calls the keeper makes. Narrow so tests can supply a fake. */
export type KeeperRpc = Pick<
  rpc.Server,
  "getAccount" | "getFeeStats" | "prepareTransaction" | "sendTransaction" | "getTransaction"
>;

/** First retry delay after a failed charge; doubles per failure. */
const BACKOFF_BASE_S = 60;
/** Longest a failing mandate waits between attempts. */
const BACKOFF_MAX_S = 6 * 60 * 60;
/** Most charges submitted in one pass. */
const BATCH = 25;

/**
 * Errors that mean the *signing key* cannot pay for the transaction — a
 * missing or unfunded source account. Anything else (simulation refusals,
 * transient RPC failures) is a normal per-mandate failure and does not
 * trigger rotation.
 */
function isKeyFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not found|no such account|missing source|not funded/i.test(message);
}

function isCongestionFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (/txINSUFFICIENT_FEE|txInsufficientFee|TRY_AGAIN_LATER/i.test(message)) return true;
  try {
    const result = xdr.TransactionResult.fromXDR(message, "base64");
    return (result.result as unknown as { type: string }).type === "txInsufficientFee";
  } catch {
    return false;
  }
}

export interface SettleResult {
  mandateId: number;
  status: "settled" | "failed";
  txHash?: string;
  error?: string;
}

/**
 * Settles mandates that have fallen due.
 *
 * The keeper holds no user funds and has no privileged role on-chain: `charge`
 * is permissionless, so this process is a convenience, not a trust dependency.
 * If it stops, merchants or subscribers can settle their own mandates and
 * nothing is lost beyond timeliness.
 *
 * ### Key rotation without downtime
 *
 * The keeper signs with a list of keys: `KEEPER_SECRET` first and, when set,
 * `KEEPER_SECRET_NEXT` as standby. If the active key cannot pay for a
 * transaction (missing or unfunded source account), the keeper switches to
 * the standby key and retries the same mandate within the same pass — no
 * settlement window is missed. Once a pass succeeds with the rotated key, it
 * logs that the previous key can be retired. Secrets are also re-read on
 * SIGHUP (see `src/index.ts`), so an operator can promote
 * `KEEPER_SECRET_NEXT` to `KEEPER_SECRET` and reload without restarting.
 * Only public keys are ever logged, never secrets.
 */
export class Keeper {
  private readonly db: DatabaseSync;
  private readonly server: KeeperRpc;
  private config: Config;
  /**
   * Mandates whose last charge failed, with when to try again. Without this,
   * the oldest due mandates are retried first on every pass, so a batch's
   * worth of underfunded vaults would block every other mandate forever.
   */
  private readonly backoff = new Map<number, { failures: number; retryAt: number }>();
  /** Signing keys in priority order: the active one first, then standbys. */
  private keys: Keypair[] = [];
  /** Index of the key currently used to sign. */
  private active = 0;
  /**
   * Public key of a key that rotation has replaced. Cleared with an info log
   * after the first pass that settles with the new key, telling the operator
   * the old key can be retired. Never holds a secret.
   */
  private pendingRetirement: string | null = null;
  private readonly passes: KeeperPassSummary[] = [];

  constructor(db: DatabaseSync, server: KeeperRpc, config: Config) {
    this.db = db;
    this.server = server;
    this.config = config;
    if (!config.KEEPER_SECRET) {
      throw new Error("Keeper requires KEEPER_SECRET");
    }
    this.setKeys([config.KEEPER_SECRET, config.KEEPER_SECRET_NEXT]);
  }

  /** Public key of the key that signs right now. Public, safe to log. */
  get publicKey(): string {
    return this.keys[this.active]!.publicKey();
  }

  /** Public keys the keeper may sign with, active first. */
  get keyPublicKeys(): string[] {
    return this.keys.map((k) => k.publicKey());
  }

  /**
   * Replaces the signing keys from a (re)loaded config without restarting.
   * A changed `KEEPER_SECRET` is treated as a completed rotation: the next
   * successful pass logs that the previous key can be retired.
   */
  reloadFromConfig(config: Config): void {
    this.config = config;
    const previous = this.keys[0]?.publicKey() ?? null;
    this.setKeys([config.KEEPER_SECRET, config.KEEPER_SECRET_NEXT]);
    if (previous && previous !== this.keys[0]!.publicKey()) {
      this.pendingRetirement = previous;
      logger.info(
        { previousKey: previous, newKey: this.keys[0]!.publicKey() },
        "keeper key reloaded on SIGHUP; settlement continues with the new key",
      );
    }
  }

  /** Installs a de-duplicated key list from secret strings; empties ignored. */
  private setKeys(secrets: Array<string | undefined>): void {
    const unique: string[] = [];
    for (const secret of secrets) {
      if (secret && !unique.includes(secret)) unique.push(secret);
    }
    if (unique.length === 0) {
      throw new Error("Keeper requires KEEPER_SECRET");
    }
    this.keys = unique.map((secret) => Keypair.fromSecret(secret));
    this.active = 0;
  }

  /**
   * Mandates the indexer believes are chargeable right now, in the order set
   * by `KEEPER_ORDER` (`oldest` = oldest-due first, the default; `largest` =
   * largest amount first), skipping any that are backing off after a failed
   * charge.
   */
  findDue(now: number = Math.floor(Date.now() / 1000), limit = BATCH): DueMandate[] {
    const due: DueMandate[] = [];
    // Read past the backing-off mandates so they cannot fill the batch.
    for (const m of this.queryDue(now, limit + this.backoff.size)) {
      const wait = this.backoff.get(m.id);
      if (wait && wait.retryAt > now) continue;
      due.push(m);
      if (due.length === limit) break;
    }
    return due;
  }

  private queryDue(now: number, limit: number): DueMandate[] {
    if (this.config.KEEPER_ORDER === "largest") return this.queryDueLargest(now, limit);
    return this.db
      .prepare(
        `SELECT id, subscriber, merchant, next_charge, amount
           FROM mandates
          WHERE status = 'Active'
            AND next_charge <= ?
            AND (max_charges = 0 OR charges_made < max_charges)
          ORDER BY next_charge ASC
          LIMIT ?`,
      )
      .all(now, limit) as unknown as DueMandate[];
  }

  /**
   * Chargeable mandates ordered by amount descending, the batch set by
   * `KEEPER_ORDER=largest`. `amount` is a decimal string in the token's
   * smallest unit, so SQLite's TEXT ordering would sort it lexicographically
   * and a JS number would lose precision on large amounts; the sort therefore
   * compares `BigInt` values in JavaScript. Ties break by oldest-due first,
   * then id, so the order is deterministic. The scan is unbounded by design:
   * "largest first" must see every due mandate before it can pick a batch.
   */
  private queryDueLargest(now: number, limit: number): DueMandate[] {
    const rows = this.db
      .prepare(
        `SELECT id, subscriber, merchant, next_charge, amount
           FROM mandates
          WHERE status = 'Active'
            AND next_charge <= ?
            AND (max_charges = 0 OR charges_made < max_charges)`,
      )
      .all(now) as unknown as DueMandate[];
    rows.sort((a, b) => {
      const amountDiff = BigInt(b.amount) - BigInt(a.amount);
      if (amountDiff > 0n) return 1;
      if (amountDiff < 0n) return -1;
      if (a.next_charge !== b.next_charge) return a.next_charge - b.next_charge;
      return a.id - b.id;
    });
    return rows.slice(0, limit);
  }

  async tick(now: number = Math.floor(Date.now() / 1000)): Promise<SettleResult[]> {
    const due = this.findDue(now);
    const fee = due.length > 0 ? await this.inclusionFee() : undefined;
    const results: SettleResult[] = [];
    for (const mandate of due) {
      const result = await this.settle(mandate.id, fee);
      this.record(result, now);
      results.push(result);
    }
    this.announceRetirement(results);
    this.recordPass(now, results);
    return results;
  }

  private async inclusionFee(): Promise<bigint> {
    const maxFee = BigInt(this.config.KEEPER_MAX_FEE ?? "100000");
    try {
      const stats = await this.server.getFeeStats();
      const percentile = `p${this.config.KEEPER_FEE_PERCENTILE ?? "90"}` as keyof typeof stats.sorobanInclusionFee;
      const requestedFee = BigInt(stats.sorobanInclusionFee[percentile]);
      const baseFee = BigInt(BASE_FEE);
      const fee = requestedFee > baseFee ? requestedFee : baseFee;
      return fee < maxFee ? fee : maxFee;
    } catch {
      logger.warn("keeper fee stats unavailable; using BASE_FEE for this pass");
      const baseFee = BigInt(BASE_FEE);
      return baseFee < maxFee ? baseFee : maxFee;
    }
  }

  /** Most recent pass first; errors are already scrubbed of keys and secrets. */
  passHistory(): KeeperPassSummary[] {
    return [...this.passes].reverse().map((pass) => ({
      ...pass,
      failures: pass.failures.map((failure) => ({ ...failure })),
      backoff: pass.backoff.map((item) => ({ ...item })),
    }));
  }

  private recordPass(now: number, results: SettleResult[]): void {
    this.passes.push({
      time: now,
      attempted: results.length,
      settled: results.filter((result) => result.status === "settled").length,
      failures: results
        .filter((result) => result.status === "failed")
        .map((result) => ({
          mandateId: result.mandateId,
          error: this.scrubError(result.error ?? "Settlement failed"),
        })),
      backoff: this.backoffList(now),
    });
    if (this.passes.length > 20) this.passes.shift();
  }

  private scrubError(message: string): string {
    const sensitive = [
      this.config.KEEPER_SECRET,
      this.config.KEEPER_SECRET_NEXT,
      ...this.keys.map((key) => key.publicKey()),
    ];
    return sensitive.reduce<string>(
      (safe, value) => (value ? safe.replaceAll(value, "[redacted]") : safe),
      message,
    );
  }

  /**
   * After a pass that settled with the rotated key, tell the operator the old
   * key is no longer needed. Only public keys are ever logged.
   */
  private announceRetirement(results: SettleResult[]): void {
    if (!this.pendingRetirement) return;
    if (!results.some((r) => r.status === "settled")) return;
    logger.info(
      { retiredKey: this.pendingRetirement, activeKey: this.publicKey },
      "keeper settled with the rotated key; the previous key can now be retired",
    );
    this.pendingRetirement = null;
  }

  /** Seconds until `mandateId` is next attempted; 0 when not backing off. */
  retryIn(mandateId: number, now: number = Math.floor(Date.now() / 1000)): number {
    const wait = this.backoff.get(mandateId);
    return wait ? Math.max(0, wait.retryAt - now) : 0;
  }

  /** Mandates currently backing off, soonest retry first. Read by /admin. */
  backoffList(now: number = Math.floor(Date.now() / 1000)): {
    mandateId: number;
    failures: number;
    retryAt: number;
    retryIn: number;
  }[] {
    return [...this.backoff.entries()]
      .map(([mandateId, wait]) => ({
        mandateId,
        failures: wait.failures,
        retryAt: wait.retryAt,
        retryIn: Math.max(0, wait.retryAt - now),
      }))
      .sort((a, b) => a.retryAt - b.retryAt);
  }

  private record(result: SettleResult, now: number): void {
    if (result.status === "settled") {
      this.backoff.delete(result.mandateId);
      return;
    }
    const failures = (this.backoff.get(result.mandateId)?.failures ?? 0) + 1;
    const delay = Math.min(BACKOFF_BASE_S * 2 ** (failures - 1), BACKOFF_MAX_S);
    this.backoff.set(result.mandateId, { failures, retryAt: now + delay });
  }

  /**
   * Submit one `charge`. Simulation failures are expected and benign — an
   * underfunded vault or a mandate cancelled since the last index pass both
   * surface here — so they are logged and skipped, never retried in a tight
   * loop. A failure of the signing key itself rotates to the standby key and
   * retries the same mandate, so a leaked or drained key causes no downtime.
   */
  async settle(mandateId: number, inclusionFee: bigint = BigInt(BASE_FEE)): Promise<SettleResult> {
    const maxFee = BigInt(this.config.KEEPER_MAX_FEE ?? "100000");
    let fee = inclusionFee < maxFee ? inclusionFee : maxFee;
    let congestionRetries = 0;
    for (;;) {
      try {
        const result = await this.submit(mandateId, fee);
        if (result.status === "failed" && isCongestionFailure(result.error)) {
          const retryFee = fee * 2n < maxFee ? fee * 2n : maxFee;
          if (congestionRetries === 0 && retryFee > fee) {
            congestionRetries += 1;
            fee = retryFee;
            logger.warn({ mandateId, fee: fee.toString() }, "retrying charge with a higher fee");
            continue;
          }
        }
        logger.info({ mandateId, fee: fee.toString() }, "keeper inclusion fee selected");
        return result.status === "failed"
          ? { ...result, error: this.scrubError(result.error ?? "Settlement failed") }
          : result;
      } catch (err) {
        if (isCongestionFailure(err)) {
          const retryFee = fee * 2n < maxFee ? fee * 2n : maxFee;
          if (congestionRetries === 0 && retryFee > fee) {
            congestionRetries += 1;
            fee = retryFee;
            logger.warn({ mandateId, fee: fee.toString() }, "retrying charge with a higher fee");
            continue;
          }
        }
        const error = this.scrubError(err instanceof Error ? err.message : String(err));
        if (isKeyFailure(err) && this.active + 1 < this.keys.length) {
          const failed = this.keys[this.active]!.publicKey();
          this.pendingRetirement ??= this.keys[0]!.publicKey();
          this.active += 1;
          logger.warn(
            { mandateId, failedKey: failed, newKey: this.publicKey },
            "keeper key is unusable; rotated to the standby key mid-pass",
          );
          continue;
        }
        logger.warn({ mandateId, fee: fee.toString(), error }, "charge skipped");
        return { mandateId, status: "failed", error };
      }
    }
  }

  /** Builds, simulates, signs and submits one `charge` with the active key. */
  private async submit(mandateId: number, fee: bigint): Promise<SettleResult> {
    const account = await this.server.getAccount(this.publicKey);
    const contract = new Contract(this.config.SUBSCRIPTION_ID);

    const tx = new TransactionBuilder(account, {
      fee: fee.toString(),
      networkPassphrase: this.config.NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call("charge", nativeToScVal(mandateId, { type: "u64" })),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(this.keys[this.active]!);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "TRY_AGAIN_LATER") {
      return { mandateId, status: "failed", error: sent.status };
    }
    if (sent.status === "ERROR") {
      return {
        mandateId,
        status: "failed",
        error:
          this.scrubError(
            typeof sent.errorResult === "string"
              ? sent.errorResult
              : JSON.stringify(sent.errorResult ?? sent.status),
          ),
      };
    }

    const confirmed = await this.poll(sent.hash);
    if (confirmed.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      logger.info({ mandateId, txHash: sent.hash }, "mandate settled");
      return { mandateId, status: "settled", txHash: sent.hash };
    }
    return { mandateId, status: "failed", txHash: sent.hash, error: confirmed.status };
  }

  private async poll(
    hash: string,
    attempts = 10,
    delayMs = 1_000,
  ): Promise<rpc.Api.GetTransactionResponse> {
    let latest = await this.server.getTransaction(hash);
    for (let i = 0; i < attempts; i += 1) {
      if (latest.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return latest;
      await new Promise((r) => setTimeout(r, delayMs));
      latest = await this.server.getTransaction(hash);
    }
    return latest;
  }
}
