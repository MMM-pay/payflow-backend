/**
 * Read-only contract calls through Soroban RPC simulations.
 *
 * A simulation never signs and never submits: it asks the node what a
 * contract call would do. That makes it the cheap way to read a contract's
 * state — the token metadata in `lib/tokens.ts` and the vault balance the
 * keeper checks before it settles a mandate both go through it.
 *
 * The source account of a simulation is never on-chain, so it needs no
 * signature and no funds. A deterministic address derived from what is being
 * read keeps two calls from sharing a transaction hash.
 */
import { Account, StrKey, hash } from "@stellar/stellar-sdk";

/**
 * Source account for a read-only simulation.
 *
 * Simulation ignores the sequence number and never sees a signature, so a
 * deterministic address derived from the call is enough — and keeps two
 * different reads from sharing a hash.
 */
export function simulationSource(seed: string): Account {
  return new Account(StrKey.encodeEd25519PublicKey(hash(Buffer.from(seed, "utf8"))), "0");
}
