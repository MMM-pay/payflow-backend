import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { mandatesRouter } from "./mandates.ts";
import {
  defaultMerchantSummaryCache,
  merchantsRouter,
  MerchantSummaryCache,
} from "./merchants.ts";
import { plansRouter } from "./plans.ts";
import { statsRouter } from "./stats.ts";
import { subscribersRouter } from "./subscribers.ts";

export { defaultMerchantSummaryCache, MerchantSummaryCache };

export interface NetworkRoutes {
  name: string;
  db: DatabaseSync;
  summaryCache?: MerchantSummaryCache | undefined;
  defaultToken?: string | undefined;
}

/**
 * Mount every network's routes. The first entry is the default network: it
 * serves the unprefixed paths, so existing clients are unaffected, and it also
 * answers under its own name. Every other network is reached only through
 * `/api/<name>/...`.
 */
export function buildApiRouter(networks: NetworkRoutes[]): Router {
  const defaultNetwork = networks[0];
  if (!defaultNetwork) {
    throw new Error("at least one network is required");
  }
  const router = Router();
  for (const network of networks) {
    router.use(`/${network.name}`, buildRoutes(network.db, network.summaryCache, network.defaultToken));
  }
  router.use(buildRoutes(defaultNetwork.db, defaultNetwork.summaryCache, defaultNetwork.defaultToken));
  return router;
}

/**
 * One router per resource: `plans.ts`, `mandates.ts`, `merchants.ts`,
 * `subscribers.ts` and `stats.ts`, with shared query helpers in
 * `helpers.ts` and response shapes in `types.ts`. This file only composes
 * them, so route ownership is obvious from a path prefix and two features
 * rarely touch the same file.
 *
 * The response types are the backend's single source of truth for the API:
 * handlers annotate their bodies with them and the typed client
 * (`src/client/index.ts`) re-exports them, so types are shared, not copied.
 */
export function buildRoutes(
  db: DatabaseSync,
  summaryCache: MerchantSummaryCache = defaultMerchantSummaryCache,
  defaultToken?: string,
): Router {
  const r = Router();
  r.use(plansRouter(db));
  r.use(mandatesRouter(db));
  r.use(merchantsRouter(db, summaryCache, defaultToken));
  r.use(subscribersRouter(db));
  r.use(statsRouter(db));
  return r;
}

export * from "./types.ts";
