import type { DatabaseSync } from "node:sqlite";
import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Config } from "./config.ts";
import { logger } from "./lib/logger.ts";
import { metrics } from "./lib/metrics.ts";
import { simulationSource } from "./lib/simulate.ts";
import { planTokensByIds } from "./lib/queries.ts";
import type { KeeperPassSummary } from "./routes/types.ts";

export interface DueMandate {
  id: number;
  subscriber: string;
  merchant: string;
  next_charge: number;
  /** Decimal string in the token's smallest unit; never a JS number. */
  amount: string;
  /** The plan the mandate was opened against; its token names the vault balance. */
  plan_id: number;
}

/**
 * The RPC calls the keeper makes. Narrow so tests can supply a fake.
 *
 * `simulateTransaction` is optional: the vault-balance read is an
 * optimisation, not a requirement, so an RPC that cannot simulate settles
 * exactly as it did before the check was added.
 */
export type KeeperRpc = Pick<
  rpc.Server,
  | "getAccount"
  | "getFeeStats"
  | "prepareTransaction"
  | "sendTransaction"
  | "getTransaction"
> &
  Partial<Pick<rpc.Server, "simulateTransaction">>;

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
  /**
   * `settled` and `failed` are real, on-chain outcomes. `simulated` is a
   * dry run (`KEEPER_DRY_RUN=true`): the charge was simulated against the
   * RPC and nothing was submitted — an `error` on a `simulated` result is
   * the simulation's refusal, i.e. the charge would have failed.
   */
  status: "settled" | "failed" | "simulated";
  txHash?: string;
  error?: string;
}

/**
 * A mandate the keeper did not even try to settle: the subscriber's vault
 * does not hold enough to cover the charge. Every amount is a decimal string
 * in the token's smallest unit.
 */
export interface SkippedMandate {
  mandateId: number;
  /** The amount the charge needs. */
  required: string;
  /** The balance the vault holds. */
  balance: string;
  /** What is missing. */
  shortfall: string;
}

/**
 * One signing lane. A channel owns exactly one account sequence at a time:
 * the worker that pulls a mandate for this channel signs with `keys[active]`,
 * waits for the transaction to confirm, and only then builds the next one —
 * so two transactions from the same channel can never race for the same
 * sequence number, while separate channels settle in parallel.
 *
 * `Channel` is exported because it appears in the public `settle` signature;
 * the keeper constructs channels itself and nothing outside mutates them.
 */
export interface Channel {
  /** Signing keys in priority order: the channel's own key first, then standbys. */
  keys: Keypair[];
  /** Index of the key currently used to sign for this channel. */
  active: number;
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
 *
 * ### Parallel settlement with channel accounts (#36)
 *
 * One account settles one transaction at a time — `getAccount` → prepare →
 * sign → send → poll must finish before the same sequence number is free
 * again — so a single key caps throughput at a few charges per minute and
 * large merchants get billed late. Two directions were considered:
 *
 * 1. *Fee-bump every channel transaction from the main key*, so the main key
 *    pays all fees. Rejected: a Stellar fee-bump consumes the **fee source's**
 *    sequence number, so every fee-bumped transaction would sequence against
 *    the one main account — reintroducing exactly the serialization this
 *    change is meant to remove (and a failed outer transaction would stall
 *    the whole pipeline behind it).
 * 2. *Each channel account signs and sequences its own transactions and pays
 *    its own fees* (the alternative the issue allows). Chosen: sequence
 *    numbers live on disjoint accounts and cannot collide, `charge` is
 *    permissionless so no channel key holds user funds or on-chain authority,
 *    and `KEEPER_SECRET` remains channel 1 with its `KEEPER_SECRET_NEXT`
 *    standby, which keeps single-key setups behaviourally unchanged.
 *
 * Due mandates are pulled from one shared queue by one worker per channel
 * (see `tick`): distribution is dynamic, one slow channel cannot stall the
 * others, and with a single channel the pass is exactly the old sequential
 * loop. Before distributing, each channel's account is checked with one
 * `getAccount` (only when several channels are configured); an unusable
 * channel is dropped for the pass, logged by public key, so its mandates
 * settle through the live channels instead of backing off against a dead key.
 *
 * ### Dry run (#38)
 *
 * With `KEEPER_DRY_RUN=true` a pass rehearses settlement: it builds and
 * simulates every charge exactly as a real pass would — account lookup,
 * inclusion fee, vault-balance skips and key rotation included — but stops
 * after `prepareTransaction`. Nothing is signed, `sendTransaction` is never
 * called, and the keeper's bookkeeping is untouched: no backoff, no pass
 * history, no metrics. Each mandate answers `simulated`, carrying the
 * simulation's error when the charge would fail, so an operator can
 * rehearse a first run on a new deployment before it costs a fee.
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
  /**
   * Signing lanes, primary first: `channels[0]` is `KEEPER_SECRET` (with
   * `KEEPER_SECRET_NEXT` as its standby in the same lane), every entry from
   * `KEEPER_CHANNEL_SECRETS` follows as its own lane. Each channel sequences
   * its own transactions, so lanes can settle in parallel without ever
   * competing for one account's sequence number.
   */
  private channels: Channel[] = [];
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
    this.buildChannels(config);
  }

  /** The primary channel (`KEEPER_SECRET` lane); never undefined. */
  private get primary(): Channel {
    return this.channels[0]!;
  }

  /** Public key of the key that signs on the primary channel. Public, safe to log. */
  get publicKey(): string {
    const channel = this.primary;
    return channel.keys[channel.active]!.publicKey();
  }

  /** How many signing channels are configured; 1 in a single-key setup. */
  get channelCount(): number {
    return this.channels.length;
  }

  /** Public keys the keeper may sign with, primary channel first. */
  get keyPublicKeys(): string[] {
    return this.channels.flatMap((channel) => channel.keys.map((key) => key.publicKey()));
  }

  /**
   * Replaces the signing keys from a (re)loaded config without restarting.
   * A changed `KEEPER_SECRET` is treated as a completed rotation: the next
   * successful pass logs that the previous key can be retired.
   */
  reloadFromConfig(config: Config): void {
    this.config = config;
    const previous = this.primary.keys[0]?.publicKey() ?? null;
    this.buildChannels(config);
    if (previous && previous !== this.primary.keys[0]!.publicKey()) {
      this.pendingRetirement = previous;
      logger.info(
        { previousKey: previous, newKey: this.primary.keys[0]!.publicKey() },
        "keeper key reloaded on SIGHUP; settlement continues with the new key",
      );
    }
  }

  /**
   * Installs the signing channels from (secret) config strings; blanks and
   * duplicates are dropped. Channel 1 is always `KEEPER_SECRET`, with
   * `KEEPER_SECRET_NEXT` kept in the *same* channel so a rotation continues
   * one sequence stream rather than opening a second lane; each
   * `KEEPER_CHANNEL_SECRETS` entry becomes its own channel afterwards.
   * Only called with config that already passed zod validation (or a test's
   * hand-built equivalent); secrets are never logged.
   */
  private buildChannels(config: Config): void {
    const seen = new Set<string>();
    const channels: Channel[] = [];
    const addChannel = (secrets: Array<string | undefined>): void => {
      const keys: Keypair[] = [];
      for (const secret of secrets) {
        if (!secret || seen.has(secret)) continue;
        seen.add(secret);
        keys.push(Keypair.fromSecret(secret));
      }
      if (keys.length > 0) channels.push({ keys, active: 0 });
    };
    addChannel([config.KEEPER_SECRET, config.KEEPER_SECRET_NEXT]);
    if (channels.length === 0) {
      throw new Error("Keeper requires KEEPER_SECRET");
    }
    for (const secret of config.KEEPER_CHANNEL_SECRETS ?? []) addChannel([secret]);
    this.channels = channels;
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
        `SELECT id, subscriber, merchant, next_charge, amount, plan_id
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
        `SELECT id, subscriber, merchant, next_charge, amount, plan_id
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
    // Mandates the vault cannot cover are dropped before any transaction is
    // built: the charge would fail in simulation anyway, and skipping it
    // saves the RPC call and the fee.
    const { chargeable, skipped } = await this.withoutShortfalls(due);
    const fee = chargeable.length > 0 ? await this.inclusionFee() : undefined;
    const channels = chargeable.length > 0 ? await this.distributableChannels() : [];
    // Read once per pass: the banner, pass history and metrics for one
    // pass all reflect the same mode even if a SIGHUP reload lands mid-pass.
    // Backoff follows each result's own status (see `record`), so a
    // simulation is never recorded as a real failure from either direction.
    const dryRun = this.config.KEEPER_DRY_RUN;
    if (dryRun && chargeable.length > 0) {
      logger.info(
        { mandates: chargeable.length },
        "keeper dry run: simulating each charge; nothing will be submitted",
      );
    }
    // One worker per channel pulls from the shared queue: within a channel
    // mandates settle strictly one after the other (one account, one sequence
    // stream), across channels they run in parallel. The cursor and the
    // result list are only touched between awaits, so plain increments are
    // safe here; results are re-sorted by due order so the summary does not
    // depend on which channel finished first.
    let cursor = 0;
    const ordered: { slot: number; result: SettleResult }[] = [];
    await Promise.all(
      channels.map(async (channel) => {
        for (;;) {
          const slot = cursor;
          cursor += 1;
          const mandate = chargeable[slot];
          if (!mandate) return;
          const result = await this.settle(mandate.id, fee, channel);
          this.record(result, now);
          ordered.push({ slot, result });
        }
      }),
    );
    ordered.sort((a, b) => a.slot - b.slot);
    const results = ordered.map((entry) => entry.result);
    // A dry run only reports: pass history and metrics describe work that
    // actually happened on chain, and there was none. A pending retirement
    // stays armed for the first pass that really settles.
    if (dryRun) return results;
    this.announceRetirement(results);
    this.recordPass(now, results, skipped);
    metrics.increment("keeper_passes");
    for (const result of results) {
      if (result.status === "settled") metrics.increment("charges_settled");
      else if (result.status === "failed") metrics.increment("charges_failed");
    }
    return results;
  }

  /**
   * Drop the mandates whose vault cannot cover the charge.
   *
   * `charge` pulls the whole amount out of the subscriber's vault, so a vault
   * holding less than the amount cannot pay: the simulation fails and the
   * transaction is wasted. Reading `vault.balance` first skips those
   * mandates, and tells `/api/due` which of the due mandates are actually
   * chargeable.
   *
   * A balance that cannot be read — the RPC is down, or the deployment has no
   * simulation support — is not a shortfall. The mandate is kept and the
   * charge decides, exactly as before, so a transient failure never stops a
   * settlement.
   *
   * Each skipped mandate is logged once per pass, with the shortfall, so an
   * operator can see what is waiting for a top-up.
   */
  private async withoutShortfalls(due: DueMandate[]): Promise<{
    chargeable: DueMandate[];
    skipped: SkippedMandate[];
  }> {
    const chargeable: DueMandate[] = [];
    const skipped: SkippedMandate[] = [];
    if (due.length === 0) return { chargeable, skipped };

    // A mandate carries no token of its own; it inherits its plan's, and the
    // vault balance is per (subscriber, token).
    const tokens = planTokensByIds(this.db, due.map((mandate) => mandate.plan_id));
    // One read per subscriber and token per pass: a subscriber with several
    // mandates on the same plan is one balance, not one read each.
    const balances = new Map<string, bigint | null>();

    for (const mandate of due) {
      const token = tokens.get(mandate.plan_id);
      if (!token) {
        chargeable.push(mandate);
        continue;
      }
      const key = `${mandate.subscriber}|${token}`;
      let balance = balances.get(key);
      if (balance === undefined) {
        balance = await this.vaultBalance(mandate.subscriber, token);
        balances.set(key, balance);
      }
      if (balance === null) {
        chargeable.push(mandate);
        continue;
      }
      const required = BigInt(mandate.amount);
      if (balance >= required) {
        chargeable.push(mandate);
        continue;
      }
      skipped.push({
        mandateId: mandate.id,
        required: required.toString(),
        balance: balance.toString(),
        shortfall: (required - balance).toString(),
      });
    }

    for (const skip of skipped) {
      logger.warn(
        {
          mandateId: skip.mandateId,
          required: skip.required,
          balance: skip.balance,
          shortfall: skip.shortfall,
        },
        "keeper skipped a mandate the vault cannot cover",
      );
    }
    return { chargeable, skipped };
  }

  /**
   * The subscriber's vault balance for one token, or null when it cannot be
   * read.
   *
   * The balance is read with a read-only simulation of the vault contract's
   * `balance(user, token)` view function — no transaction, no fee, no state
   * changed. A failure is logged and reported as "unknown", never thrown: the
   * caller's loop must not crash over it.
   */
  private async vaultBalance(subscriber: string, token: string): Promise<bigint | null> {
    if (typeof this.server.simulateTransaction !== "function") return null;
    const vaultId = this.config.VAULT_ID;
    if (!vaultId) return null;
    try {
      const tx = new TransactionBuilder(
        simulationSource(`vault-balance:${subscriber}:${token}`),
        { fee: "100", networkPassphrase: this.config.NETWORK_PASSPHRASE },
      )
        .addOperation(
          new Contract(vaultId).call(
            "balance",
            nativeToScVal(subscriber, { type: "address" }),
            nativeToScVal(token, { type: "address" }),
          ),
        )
        .setTimeout(0)
        .build();
      const res = await this.server.simulateTransaction(tx);
      if ("error" in res && res.error) {
        logger.warn(
          { subscriber, token, reason: res.error.slice(0, 200).replace(/\s+/g, " ") },
          "vault balance unavailable; settling as before",
        );
        return null;
      }
      // SDK <= 16 reported `results[]`; SDK 17 reports a single `result`.
      const retval = "result" in res ? res.result?.retval : undefined;
      if (!retval) return null;
      const value = scValToNative(retval);
      if (typeof value === "bigint") return value;
      if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
      return null;
    } catch (err) {
      logger.warn(
        { subscriber, token, err: err instanceof Error ? err.message : String(err) },
        "vault balance unavailable; settling as before",
      );
      return null;
    }
  }

  /**
   * The channels this pass may distribute due mandates over: every configured
   * channel whose signing account can pay, checked once per pass with a single
   * `getAccount` each (and only when several channels are configured). A
   * channel that cannot pay is dropped for the pass — logged by public key,
   * never a secret — so its mandates settle through the live channels instead
   * of backing off against a dead key. A *transient* RPC error keeps the
   * channel: `settle` will fail the mandate and the usual backoff retries it
   * on the next pass, never crashing the loop. If every channel looks unusable
   * (an RPC outage misread as dead accounts), all of them are kept and
   * per-mandate failure decides, exactly like the single-key path.
   */
  private async distributableChannels(): Promise<Channel[]> {
    if (this.channels.length === 1) return this.channels;
    const checked = await Promise.all(
      this.channels.map(async (channel) => {
        if (await this.canSign(channel)) return channel;
        const unusable = channel.keys[channel.active]!.publicKey();
        logger.warn(
          { channel: unusable },
          "keeper channel key cannot pay; skipping this channel for the pass",
        );
        return null;
      }),
    );
    const usable = checked.filter((channel): channel is Channel => channel !== null);
    return usable.length > 0 ? usable : this.channels;
  }

  /**
   * Whether the channel's active key can pay for a transaction, rotating to
   * its standby first when the active key cannot — the same rotation
   * `settle` performs mid-pass, done up front here so an unused channel never
   * strands its standby. A non-key failure (RPC hiccup) answers `true`: the
   * channel stays and the mandate's own error handling takes over.
   */
  private async canSign(channel: Channel): Promise<boolean> {
    for (;;) {
      const key = channel.keys[channel.active]!;
      try {
        await this.server.getAccount(key.publicKey());
        return true;
      } catch (err) {
        if (!isKeyFailure(err)) return true;
        if (this.rotateToStandby(channel)) continue;
        return false;
      }
    }
  }

  /**
   * Switch `channel` to its standby key when it has one; answers whether a
   * standby was available. Only the primary channel carries a standby
   * (`KEEPER_SECRET_NEXT`), and only a rotation of the primary key arms the
   * one-time "old key can be retired" log. Public keys only.
   */
  private rotateToStandby(channel: Channel, mandateId?: number): boolean {
    if (channel.active + 1 >= channel.keys.length) return false;
    const failed = channel.keys[channel.active]!.publicKey();
    if (channel === this.primary) {
      this.pendingRetirement ??= channel.keys[0]!.publicKey();
    }
    channel.active += 1;
    logger.warn(
      {
        ...(mandateId === undefined ? {} : { mandateId }),
        failedKey: failed,
        newKey: channel.keys[channel.active]!.publicKey(),
      },
      "keeper key is unusable; rotated to the standby key mid-pass",
    );
    return true;
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

  private recordPass(now: number, results: SettleResult[], skipped: SkippedMandate[] = []): void {
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
      skipped: skipped.map((skip) => ({ ...skip })),
      backoff: this.backoffList(now),
    });
    if (this.passes.length > 20) this.passes.shift();
  }

  private scrubError(message: string): string {
    const sensitive = [
      this.config.KEEPER_SECRET,
      this.config.KEEPER_SECRET_NEXT,
      ...(this.config.KEEPER_CHANNEL_SECRETS ?? []),
      ...this.keyPublicKeys,
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
    // A simulated result is neither a settlement nor a failure: a dry run
    // must leave the backoff exactly as it was.
    if (result.status === "simulated") return;
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
   * loop. A failure of the signing key itself rotates the channel to its
   * standby key and retries the same mandate, so a leaked or drained key
   * causes no downtime; `channel` selects the signing lane and defaults to the
   * primary, so a plain `settle(id)` behaves exactly as the single-key keeper.
   */
  async settle(
    mandateId: number,
    inclusionFee: bigint = BigInt(BASE_FEE),
    channel?: Channel,
  ): Promise<SettleResult> {
    const lane = channel ?? this.primary;
    const maxFee = BigInt(this.config.KEEPER_MAX_FEE ?? "100000");
    let fee = inclusionFee < maxFee ? inclusionFee : maxFee;
    let congestionRetries = 0;
    for (;;) {
      try {
        const result = await this.submit(mandateId, fee, lane);
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
        if (isKeyFailure(err) && this.rotateToStandby(lane, mandateId)) {
          continue;
        }
        logger.warn(
          { mandateId, fee: fee.toString(), error },
          this.config.KEEPER_DRY_RUN ? "dry run: charge simulation failed" : "charge skipped",
        );
        return this.config.KEEPER_DRY_RUN
          ? { mandateId, status: "simulated", error }
          : { mandateId, status: "failed", error };
      }
    }
  }

  /**
   * Builds and simulates one `charge` with the channel's active key, then
   * signs and submits it — unless `KEEPER_DRY_RUN` stops it after the
   * simulation, answering `simulated` without ever touching a secret or the
   * network's submit path.
   */
  private async submit(mandateId: number, fee: bigint, channel: Channel): Promise<SettleResult> {
    const key = channel.keys[channel.active]!;
    const account = await this.server.getAccount(key.publicKey());
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
    if (this.config.KEEPER_DRY_RUN) {
      // Dry run: the simulation above is the whole exercise. The
      // transaction is never signed or sent, so nothing reaches the chain.
      logger.info(
        { mandateId, fee: fee.toString() },
        "dry run: charge simulated; not submitting",
      );
      return { mandateId, status: "simulated" };
    }
    prepared.sign(key);

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
