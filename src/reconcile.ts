import type { DatabaseSync } from "node:sqlite";
import {
  Account,
  Contract,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { big, num } from "./lib/stellar.ts";
import { logger } from "./lib/logger.ts";

/** One mandate's state as the subscription contract reports it. Amounts stay strings. */
export interface ChainMandate {
  id: number;
  status: string;
  chargesMade: number;
  nextCharge: number;
  /** Decimal string in the token's smallest unit; never a JS number. */
  amount: string;
}

/** One divergence between the projection and the chain. */
export interface Drift {
  mandateId: number;
  field: "status" | "charges_made" | "next_charge";
  projection: string | number;
  chain: string | number;
}

/** Outcome of one reconcile pass. */
export interface ReconcileResult {
  /** Active mandates sampled from the projection. */
  sampled: number;
  /** Mandates successfully re-read from the contract. */
  onChain: number;
  /** Rows fixed this pass. */
  corrections: number;
  /** RPC or read failures this pass. */
  errors: number;
  /** Last failure message, if any; cleared on a clean pass. */
  lastError: string | null;
  /** Every divergence found, whether or not it could be fixed. */
  drift: Drift[];
}

/** The RPC calls the reconciler makes: read-only contract simulations. */
export type ReconcileRpc = Pick<rpc.Server, "simulateTransaction">;

/** Fee for a read-only simulation; it is never submitted, so the floor is fine. */
const SIMULATION_FEE = "100";

/**
 * Periodically re-reads a sample of active mandates from the subscription
 * contract and repairs any divergence between the chain and the projection.
 *
 * The indexer is idempotent but not infallible: an RPC gap, a crashed pass or
 * a bug can leave the projection wrong forever, with nothing ever rewriting
 * the row. This pass trusts the chain over the projection and corrects
 * `status`, `charges_made` and `next_charge` in place. `amount` and `period`
 * are immutable after a mandate is created, so they cannot drift and are not
 * compared here.
 *
 * `get_mandate` is a read-only view on the subscription contract, simulated
 * through Soroban RPC: no signature, no fee, no state change. Every write is a
 * plain UPDATE keyed on the mandate id, so replaying a pass is a no-op once
 * the row matches the chain. A failure is logged and counted, then retried on
 * the next pass — it never crashes the loop.
 */
export class Reconciler {
  private readonly db: DatabaseSync;
  private readonly server: ReconcileRpc;
  private readonly subscriptionId: string;
  private readonly networkPassphrase: string;
  private readonly sampleSize: number;
  /** Invalidates a merchant's cached summary after a correction, so the API
   * serves the repaired projection instead of a stale summary until some other
   * event evicts it. */
  private readonly invalidateMerchant?: (merchant: string) => void;
  /** Guard against overlapping passes. The loop is serial by construction,
   * but this keeps a triggered or nested call safe too. */
  private running = false;

  constructor(
    db: DatabaseSync,
    server: ReconcileRpc,
    subscriptionId: string,
    networkPassphrase: string,
    sampleSize: number,
    invalidateMerchant?: (merchant: string) => void,
  ) {
    this.db = db;
    this.server = server;
    this.subscriptionId = subscriptionId;
    this.networkPassphrase = networkPassphrase;
    this.sampleSize = sampleSize;
    if (invalidateMerchant) this.invalidateMerchant = invalidateMerchant;
  }

  /** One pass: sample active mandates, re-read them from the contract, fix drift. */
  async tick(): Promise<ReconcileResult> {
    if (this.running) {
      return { sampled: 0, onChain: 0, corrections: 0, errors: 0, lastError: null, drift: [] };
    }
    this.running = true;
    const result: ReconcileResult = {
      sampled: 0,
      onChain: 0,
      corrections: 0,
      errors: 0,
      lastError: null,
      drift: [],
    };
    try {
      // Indexed on (status, ...): active mandates only, bounded by the sample.
      // Deterministic by id keeps the query short; drift on newer mandates is
      // caught as they are created and sampled on later passes.
      const ids = this.db
        .prepare(`SELECT id FROM mandates WHERE status = 'Active' ORDER BY id LIMIT ?`)
        .all(this.sampleSize) as { id: number }[];
      result.sampled = ids.length;
      if (ids.length === 0) return result;

      const rows = new Map<
        number,
        { status: string; charges_made: number; next_charge: number; merchant: string }
      >();
      for (const row of this.db
        // The interpolation builds nothing but `?` placeholders — one per
        // sampled id — so the query is fully parameterised and safe.
        // eslint-disable-next-line no-restricted-syntax
        .prepare(`SELECT id, status, charges_made, next_charge, merchant FROM mandates WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids.map(({ id }) => id)) as Array<{
          id: number;
          status: string;
          charges_made: number;
          next_charge: number;
          merchant: string;
        }>) {
        rows.set(row.id, row);
      }

      for (const { id } of ids) {
        let chain: ChainMandate | null = null;
        try {
          chain = await this.readMandate(id);
        } catch (err) {
          result.errors += 1;
          result.lastError = err instanceof Error ? err.message : String(err);
          // Never log the raw error object: its envelope can carry the caller's
          // payload, and the chain's diagnostics are not a secret but are not
          // useful in full either.
          logger.warn(
            { mandateId: id, error: result.lastError },
            "reconcile: chain read failed; retrying next pass",
          );
          continue;
        }
        result.onChain += 1;
        const row = rows.get(id);
        if (!row) continue; // vanished between the sample and the read

        const drift: Drift[] = [];
        if (row.status !== chain.status) {
          drift.push({ mandateId: id, field: "status", projection: row.status, chain: chain.status });
        }
        if (row.charges_made !== chain.chargesMade) {
          drift.push({
            mandateId: id,
            field: "charges_made",
            projection: row.charges_made,
            chain: chain.chargesMade,
          });
        }
        if (row.next_charge !== chain.nextCharge) {
          drift.push({
            mandateId: id,
            field: "next_charge",
            projection: row.next_charge,
            chain: chain.nextCharge,
          });
        }
        result.drift.push(...drift);

        for (const d of drift) {
          // `d.field` is one of three hard-coded column names, never user input,
          // so the interpolation is a vetted static fragment.
          // eslint-disable-next-line no-restricted-syntax
          this.db.prepare(`UPDATE mandates SET ${d.field} = ? WHERE id = ?`).run(d.chain, id);
          result.corrections += 1;
          this.invalidateMerchant?.(row.merchant);
          logger.info(
            {
              mandateId: id,
              merchant: row.merchant,
              field: d.field,
              projection: d.projection,
              chain: d.chain,
            },
            "reconcile: corrected projection drift",
          );
        }
      }
      return result;
    } catch (err) {
      result.errors += 1;
      result.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ error: result.lastError }, "reconcile pass failed");
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Read one mandate's state from the contract via a read-only simulation. */
  private async readMandate(id: number): Promise<ChainMandate> {
    // Simulation ignores the sequence number and never sees a signature, so a
    // deterministic source account derived from the contract id is enough.
    const source = new Account(
      StrKey.encodeEd25519PublicKey(hash(Buffer.from(this.subscriptionId, "utf8"))),
      "0",
    );
    const tx = new TransactionBuilder(source, {
      fee: SIMULATION_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        new Contract(this.subscriptionId).call("get_mandate", nativeToScVal(id, { type: "u64" })),
      )
      .setTimeout(0)
      .build();

    const res = await this.server.simulateTransaction(tx);
    if ("error" in res && res.error) {
      // Bound the diagnostics: host errors can be large, and there are no
      // secrets in them, but they are not useful in full either.
      throw new Error(`get_mandate(${id}): ${String(res.error).slice(0, 200).replace(/\s+/g, " ")}`);
    }
    // SDK <= 16 reported `results[]`; SDK 17 reports a single `result`.
    const retval = "result" in res ? res.result?.retval : undefined;
    if (!retval) throw new Error(`get_mandate(${id}): empty simulation result`);
    const map = scValToNative(retval) as Record<string, unknown>;
    return {
      id,
      status: typeof map.status === "string" ? map.status : "Unknown",
      chargesMade: num(map.charges_made),
      nextCharge: num(map.next_charge),
      amount: big(map.amount),
    };
  }
}
