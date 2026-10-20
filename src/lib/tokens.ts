/**
 * Token metadata: what a token contract id actually means.
 *
 * The projection stores a token contract id per plan, and amounts in that
 * token's smallest unit. On its own that is ambiguous — 1_000_000 is a
 * different amount of money depending on the token's decimals — so the API
 * resolves `symbol`, `name` and `decimals` from the token contract itself
 * rather than assuming XLM and 7.
 *
 * Two rules from the rest of the service hold here: amounts stay strings /
 * numbers of a unit that is never money-scaled here (decimals is a small u32),
 * and an RPC failure must never crash a request or a loop — it is reported as
 * an unavailable metadata read and retried on the next lookup.
 */
import {
  Asset,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { TokenMetadata } from "../routes/types.ts";
import { logger } from "./logger.ts";
import { simulationSource } from "./simulate.ts";

/** Stroops per lumien: fixed by the protocol, never read from the network. */
export const NATIVE_DECIMALS = 7;

/**
 * The view functions the Stellar Asset Contract exposes for metadata.
 * `decimal` is the pre-protocol-23 name of `decimals`.
 */
type MetadataFunction = "symbol" | "name" | "decimals" | "decimal";

/** The only RPC call this module makes; narrow so tests can supply a fake. */
export type TokenRpc = Pick<rpc.Server, "simulateTransaction">;

export type SimulateResponse = rpc.Api.SimulateTransactionResponse;

/** Raised when a token's metadata cannot be read: RPC down, host error, bad id. */
export class TokenMetadataUnavailable extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`token metadata unavailable: ${reason}`);
    this.name = "TokenMetadataUnavailable";
    this.reason = reason;
  }
}

/** Reads one token's metadata. Implementations may hit the network and throw. */
export type TokenReader = (tokenId: string) => Promise<TokenMetadata>;

/**
 * Contract id of the network's native asset (XLM) account contract, derived
 * from the passphrase instead of being hard-coded per network.
 */
export function nativeTokenId(networkPassphrase: string): string {
  return Asset.native().contractId(networkPassphrase);
}

/** A token id that means "the network's native asset". */
export function isNativeToken(tokenId: string, networkPassphrase: string): boolean {
  const trimmed = tokenId.trim();
  // Plans may store the derived SAC address or the plain word the contracts
  // emit for an `Address`-typed native asset.
  return trimmed.toLowerCase() === "native" || trimmed === nativeTokenId(networkPassphrase);
}

export function nativeMetadata(networkPassphrase: string): TokenMetadata {
  return {
    token: nativeTokenId(networkPassphrase),
    symbol: "XLM",
    name: "Stellar Lumens",
    decimals: NATIVE_DECIMALS,
  };
}

/** Simulates one zero-argument view function and decodes its return value. */
async function simulateView(
  server: TokenRpc,
  networkPassphrase: string,
  tokenId: string,
  fn: MetadataFunction,
): Promise<unknown> {
  const tx = new TransactionBuilder(simulationSource(tokenId), {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(new Contract(tokenId).call(fn))
    .setTimeout(0)
    .build();

  const res = await server.simulateTransaction(tx);
  if ("error" in res && res.error) {
    // One line per failure, without the raw host error text beyond a bound:
    // diagnostics can be large and carry no secrets, but they are not useful
    // in full.
    throw new TokenMetadataUnavailable(`${fn}: ${res.error.slice(0, 200).replace(/\s+/g, " ")}`);
  }
  // SDK <= 16 reported `results[]`; SDK 17 reports a single `result`.
  const retval = "result" in res ? res.result?.retval : undefined;
  if (!retval) throw new TokenMetadataUnavailable(`${fn}: empty simulation result`);
  return scValToNative(retval);
}

/**
 * A reader that asks the token contract itself, through Soroban RPC
 * simulations. `decimal` was the name of the decimals view function before the
 * current Stellar Asset Contract, so it is tried when `decimals` is rejected.
 */
export function makeSimulationReader(
  server: TokenRpc,
  networkPassphrase: string,
): TokenReader {
  return async (tokenId: string): Promise<TokenMetadata> => {
    const decimals = await readDecimals(server, networkPassphrase, tokenId);
    const [symbol, name] = await Promise.all([
      simulateView(server, networkPassphrase, tokenId, "symbol"),
      simulateView(server, networkPassphrase, tokenId, "name"),
    ]);
    if (typeof symbol !== "string" || typeof name !== "string") {
      throw new TokenMetadataUnavailable(`${tokenId}: symbol and name must be strings`);
    }
    return { token: tokenId, symbol, name, decimals };
  };
}

/** `decimals` on the current contract, `decimal` on older deployments. */
async function readDecimals(
  server: TokenRpc,
  networkPassphrase: string,
  tokenId: string,
): Promise<number> {
  let scale: unknown;
  try {
    scale = await simulateView(server, networkPassphrase, tokenId, "decimals");
  } catch (err) {
    const missing =
      err instanceof TokenMetadataUnavailable && err.reason.includes("symbol not found");
    if (!missing) throw err;
    scale = await simulateView(server, networkPassphrase, tokenId, "decimal");
  }
  // A decimal count is a u32 scale, not an amount, so a number is the right type.
  if (typeof scale !== "number" || !Number.isInteger(scale) || scale < 0 || scale > 255) {
    throw new TokenMetadataUnavailable(`${tokenId}: decimals out of range`);
  }
  return scale;
}

export interface TokenCacheOptions {
  /** How long a resolved entry is reused before the contract is read again. */
  ttlMs?: number;
  /** Highest number of tokens kept; the least recently used is dropped. */
  max?: number;
  /** Clock injection point, so expiry is testable without sleeping. */
  now?: () => number;
  /**
   * Passphrase of the network being served. With it, the derived native
   * (XLM) asset contract is recognised without a read; without it only the
   * plain `native` alias is.
   */
  networkPassphrase?: string;
}

interface CacheEntry {
  value: TokenMetadata;
  expiresAt: number;
}

/**
 * Caches token metadata by contract id.
 *
 * Token metadata is immutable in practice (a SAC cannot change its decimals),
 * but a token id can be re-pointed at a different contract after a redeploy,
 * so entries expire. Reads for the same id that overlap share one RPC call,
 * which matters most for the plan and mandate lists, where one page can name
 * the same token many times.
 */
export class TokenMetadataService {
  private readonly reader: TokenReader;
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly networkPassphrase: string | undefined;
  /** Resolved entries, oldest first so the front is the least recently used. */
  private readonly entries = new Map<string, CacheEntry>();
  /** Reads in flight, so concurrent lookups of one token share an RPC call. */
  private readonly pending = new Map<string, Promise<TokenMetadata>>();

  constructor(reader: TokenReader, options: TokenCacheOptions = {}) {
    this.reader = reader;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.max = options.max ?? 256;
    this.now = options.now ?? (() => Date.now());
    this.networkPassphrase = options.networkPassphrase;
  }

  /**
   * Metadata for a token id that denotes the network's native asset, or null.
   * The native SAC reports its own symbol as `native`, so XLM and its 7
   * decimals come from the protocol instead of from a read.
   */
  private nativeFor(tokenId: string): TokenMetadata | null {
    const passphrase = this.networkPassphrase;
    if (!passphrase) return null;
    return isNativeToken(tokenId, passphrase) ? nativeMetadata(passphrase) : null;
  }

  /** Cached metadata, or `undefined` when absent or expired. */
  cached(tokenId: string): TokenMetadata | undefined {
    const hit = this.entries.get(tokenId);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(tokenId);
      return undefined;
    }
    // Re-insert so this key becomes the most recently used.
    this.entries.delete(tokenId);
    this.entries.set(tokenId, hit);
    return hit.value;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
  }

  /** Reads metadata, throwing `TokenMetadataUnavailable` when it cannot be had. */
  fetch(tokenId: string): Promise<TokenMetadata> {
    const native = this.nativeFor(tokenId);
    if (native) return Promise.resolve(native);

    const hit = this.cached(tokenId);
    if (hit) return Promise.resolve(hit);

    const inFlight = this.pending.get(tokenId);
    if (inFlight) return inFlight;

    const read = this.reader(tokenId)
      .then((value) => {
        this.remember(tokenId, value);
        return value;
      })
      .finally(() => {
        // A failure is not cached: the next lookup retries the RPC.
        this.pending.delete(tokenId);
      });
    this.pending.set(tokenId, read);
    return read;
  }

  /** Never throws, so a list endpoint cannot fail because RPC is unreachable. */
  async resolve(tokenId: string | null | undefined): Promise<TokenMetadata | null> {
    if (!tokenId) return null;
    try {
      return await this.fetch(tokenId);
    } catch (err) {
      logger.warn({ token: tokenId, err }, "token metadata unavailable");
      return null;
    }
  }

  private remember(tokenId: string, value: TokenMetadata): void {
    this.entries.set(tokenId, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * A source that reports every token as unavailable. `createApp` falls back to
 * it when no RPC-backed service is wired, so unit tests and a service started
 * without an RPC url never reach out to the network from a request handler.
 */
export const unavailableTokens: TokenReader = async (tokenId: string) => {
  throw new TokenMetadataUnavailable(`no token reader configured for ${tokenId}`);
};

/** Wraps a reader so failures surface as `TokenMetadataUnavailable`. */
export function asReader(source: TokenReader | null | undefined): TokenReader {
  return source ?? unavailableTokens;
}
