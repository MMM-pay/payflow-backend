/** Shared helpers for the per-resource routers. */
import type { TokenMetadataService } from "../lib/tokens.ts";
import type { TokenFields } from "./types.ts";

/** Upper bound on `limit` so one query cannot drag the synchronous SQLite. */
export const MAX_LIMIT = 200;

/** Upper bound on the buckets a churn report may carry. */
export const MAX_CHURN_BUCKETS = 120;

/** Upper bound on the buckets a revenue report may carry. */
export const MAX_REVENUE_BUCKETS = 1_000;

/** Buckets a revenue report carries when the caller does not say: a year of days. */
export const DEFAULT_REVENUE_BUCKETS = 366;

/** Both recurring-revenue figures normalise each mandate's period to these. */
export const SECONDS_PER_MONTH = 2_592_000; // a 30-day month
export const SECONDS_PER_YEAR = 31_536_000; // a 365-day year

export function limitOf(raw: unknown, fallback = 50): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}

/**
 * Resolve a token's symbol/decimals to join onto a row's amounts. Never
 * throws: an unreadable token yields `null` fields rather than failing the
 * request, because the amount stays a valid string in its own smallest unit.
 */
export async function tokenFields(
  tokens: TokenMetadataService,
  tokenId: string | null | undefined,
): Promise<TokenFields> {
  const meta = await tokens.resolve(tokenId);
  return { tokenSymbol: meta?.symbol ?? null, decimals: meta?.decimals ?? null };
}

/**
 * Encode a list cursor: the primary key of the last row on a page, as
 * base64url JSON (`{ id }`). Opaque to clients — the server pages by primary
 * key, never by offset — so a row inserted or deleted between pages does not
 * skip or repeat anything beyond the keyed window itself.
 */
export function encodeCursor(id: number): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

/**
 * Decode a cursor back to the primary key it names. Invalid cursors are the
 * caller's responsibility to reject with `400 invalid_request`.
 */
export function decodeCursor(raw: string): number | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { id: unknown };
    if (typeof decoded.id === "number" && Number.isSafeInteger(decoded.id) && decoded.id > 0) {
      return decoded.id;
    }
  } catch {
    // Not a cursor we issued.
  }
  return null;
}
