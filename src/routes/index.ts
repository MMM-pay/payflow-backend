import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { TokenMetadataService } from "../lib/tokens.ts";
import { mandatesRouter } from "./mandates.ts";
import {
  defaultMerchantSummaryCache,
  merchantsRouter,
  MerchantSummaryCache,
} from "./merchants.ts";
import { plansRouter } from "./plans.ts";
import { statsRouter } from "./stats.ts";
import { subscribersRouter } from "./subscribers.ts";
import { tokensRouter } from "./tokens.ts";

export { defaultMerchantSummaryCache, MerchantSummaryCache };

/**
 * One router per resource: `plans.ts`, `mandates.ts`, `merchants.ts`,
 * `subscribers.ts`, `stats.ts` and `tokens.ts`, with shared query helpers in
 * `helpers.ts` and response shapes in `types.ts`. This file only composes
 * them, so route ownership is obvious from a path prefix and two features
 * rarely touch the same file.
 *
 * The response types are the backend's single source of truth for the API:
 * handlers annotate their bodies with them and the typed client
 * (`src/client/index.ts`) re-exports them, so types are shared, not copied.
 *
 * `tokens` resolves a token contract id to its symbol/decimals (see
 * `lib/tokens.ts`); the plan and mandate routers join their amounts onto it
 * and `tokensRouter` serves them directly.
 */
export function buildRoutes(
  db: DatabaseSync,
  tokens: TokenMetadataService,
  summaryCache: MerchantSummaryCache = defaultMerchantSummaryCache,
  defaultToken?: string,
): Router {
  const r = Router();
  r.use(plansRouter(db, tokens));
  r.use(mandatesRouter(db, tokens));
  r.use(merchantsRouter(db, summaryCache, defaultToken));
  r.use(subscribersRouter(db));
  r.use(statsRouter(db));
  r.use(tokensRouter(tokens));
  return r;
}

export * from "./types.ts";
