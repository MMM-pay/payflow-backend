import { StrKey } from "@stellar/stellar-sdk";

/**
 * A deterministic, valid Stellar address for tests.
 *
 * The API validates addresses as StrKeys: a mistyped address has a broken
 * checksum, so a fixture that merely looks like one would be refused. These
 * are derived from a fixed seed, so they are the same on every run and never
 * collide with an address the projection holds.
 */
export function testAddress(seed: number): string {
  return StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(seed % 256));
}
