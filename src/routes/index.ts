import { Router } from "express";
import type { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import type { TokenMetadataService } from "../lib/tokens.ts";
import type { WebhookDispatcher } from "../lib/webhooks.ts";
import { authRouter, type Sep10Auth } from "./auth.ts";
import { mandatesRouter } from "./mandates.ts";
import { rawEventsRouter } from "./events.ts";
import {
  defaultMerchantSummaryCache,
  merchantsRouter,
  MerchantSummaryCache,
} from "./merchants.ts";
import { plansRouter } from "./plans.ts";
import { protocolRouter } from "./protocol.ts";
import { statsRouter } from "./stats.ts";
import { subscribersRouter } from "./subscribers.ts";
import { tokensRouter } from "./tokens.ts";
import { streamRouter } from "./stream.ts";
import { vaultRouter } from "./vault.ts";
import { webhooksRouter } from "./webhooks.ts";

export { defaultMerchantSummaryCache, MerchantSummaryCache };

export interface NetworkRoutes {
  name: string;
  db: DatabaseSync;
  summaryCache?: MerchantSummaryCache | undefined;
  defaultToken?: string | undefined;
  /** Resolves this network's token contract ids to symbol/name/decimals. */
  tokens: TokenMetadataService;
  events?: EventEmitter | undefined;
  /** Delivers charge events to registered webhooks. */
  webhooks?: WebhookDispatcher | undefined;
  /** SEP-10 sign-in; merchant-only routes accept its JWTs. */
  auth?: Sep10Auth | undefined;
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
    router.use(
      `/${network.name}`,
      buildRoutes(
        network.db,
        network.tokens,
        network.summaryCache,
        network.defaultToken,
        network.events,
        network.webhooks,
        network.auth,
      ),
    );
  }
  router.use(
    buildRoutes(
      defaultNetwork.db,
      defaultNetwork.tokens,
      defaultNetwork.summaryCache,
      defaultNetwork.defaultToken,
      defaultNetwork.events,
      defaultNetwork.webhooks,
      defaultNetwork.auth,
    ),
  );
  return router;
}

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
 * `lib/tokens.ts`); the plan and mandate routers join those fields onto their
 * amounts and `tokensRouter` serves them directly.
 */
export function buildRoutes(
  db: DatabaseSync,
  tokens: TokenMetadataService,
  summaryCache: MerchantSummaryCache = defaultMerchantSummaryCache,
  defaultToken?: string,
  events?: EventEmitter,
  webhooks?: WebhookDispatcher,
  auth?: Sep10Auth,
): Router {
  const r = Router();
  r.use((_req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=5");
    next();
  });
  r.use(rawEventsRouter(db));
  r.use(plansRouter(db, tokens));
  r.use(protocolRouter(db));
  r.use(mandatesRouter(db, tokens));
  r.use(merchantsRouter(db, summaryCache, defaultToken));
  r.use(subscribersRouter(db));
  r.use(statsRouter(db));
  r.use(tokensRouter(tokens));
  if (events) r.use(streamRouter(events, db));
  if (auth) r.use(authRouter(auth));
  if (webhooks) r.use(webhooksRouter(db, webhooks, auth));
  r.use(vaultRouter(db));
  return r;
}

export * from "./types.ts";
