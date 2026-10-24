import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { DatabaseSync } from "node:sqlite";
import type { Config, NetworkConfig } from "./config.ts";
import type { IndexerStatus } from "./indexer.ts";
import { buildAdminRoutes, type AdminHooks, type AdminToken } from "./routes/admin.ts";
import { buildApiRouter, MerchantSummaryCache } from "./routes/index.ts";
import { buildOpenApiDocument, DOCS_HTML, DOCS_INIT_SCRIPT } from "./routes/openapi.ts";
import { asReader, TokenMetadataService } from "./lib/tokens.ts";
import { sendApiError } from "./routes/errors.ts";
import type { HealthResponse } from "./routes/types.ts";
import type { RpcStatus } from "./lib/stellar.ts";
import type { WebhookDispatcher } from "./lib/webhooks.ts";
import type { Sep10Auth } from "./routes/auth.ts";
import { logger } from "./lib/logger.ts";
import { metrics, publishBusinessMetrics, publishIndexerMetrics } from "./lib/metrics.ts";
import { withSpan } from "./lib/telemetry.ts";
import { getVersionInfo } from "./lib/version.ts";

/**
 * ReDoc's standalone browser bundle, read once when the app module loads.
 *
 * It ships in the `redoc` package that `npm ci` installs, so `/api/docs`
 * serves the documentation from this process instead of a third-party CDN.
 * Reading it here keeps the request handler free of filesystem work.
 */
const require = createRequire(import.meta.url);
const REDOC_BUNDLE = readFileSync(require.resolve("redoc/bundles/redoc.standalone.js"), "utf8");

/**
 * The shape of a failure that is safe to put in a log line.
 *
 * Express 5 funnels every rejected handler and every middleware failure —
 * including the body parser's — through the boundary below, and those error
 * objects carry the caller's payload: `body-parser` hangs the raw request body
 * off `err.body`, and pino serializes an error's own enumerable properties.
 * `KEEPER_SECRET` and anything else posted to the API must not reach a log
 * aggregator, so a fresh error carries only the original type, its message and
 * stack, plus the HTTP status when the failure already has one.
 */
export function loggableError(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const withStatus = e as Error & { status?: unknown; statusCode?: unknown };
  const status =
    typeof withStatus.statusCode === "number"
      ? withStatus.statusCode
      : typeof withStatus.status === "number"
        ? withStatus.status
        : undefined;
  const safe: Error & { status?: number } = new Error(e.message);
  // A fresh error, so nothing the caller left on the original — `body-parser`'s
  // `err.body` above all — is enumerable for pino to copy into the log line.
  // The prototype is carried over, which is what pino reports as `err.type`.
  Object.setPrototypeOf(safe, Object.getPrototypeOf(e));
  if (e.stack !== undefined) safe.stack = e.stack;
  if (status !== undefined) safe.status = status;
  return safe;
}

/**
 * The API's only error boundary.
 *
 * Express 5 awaits a handler's return value and forwards a rejected promise to
 * the error middleware, so an `async` route no longer needs a manual
 * `try`/`catch` to avoid a dangling request or an unhandled rejection: any
 * failure — thrown synchronously or from a rejected promise — lands here and
 * becomes a 500.
 *
 * Neither half of the contract leaks: the body is a fixed shape because
 * `err.message` can carry a bound SQL value or an RPC URL, and the log line is
 * `loggableError(err)` for the same reason.
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // A handler that fails after the response has started cannot be turned into
  // a 500; hand the error back so Express ends the request instead of this
  // handler throwing ERR_HTTP_HEADERS_SENT from inside itself.
  if (res.headersSent) {
    next(err);
    return;
  }
  logger.error({ err: loggableError(err) }, "unhandled request error");
  // Fixed copy from the code's default message: `err.message` can carry a bound
  // SQL value or an RPC URL, so it never reaches the response body.
  sendApiError(res, _req, 500, "internal_error");
}

/**
 * The canonical, versioned root of the read API.
 *
 * Every route is served here, and the same router is mounted at `/api` below
 * so an existing client that was written before versioning keeps working. A
 * breaking change can then be made in `/api/v2` without touching `/api/v1`,
 * and `/api` keeps naming v1 until it is retired under the deprecation policy
 * in API_CHANGELOG.md.
 */
const API_V1 = "/api/v1";
/** The unversioned root, an alias of `API_V1`. */
const API_ALIAS = "/api";

/** `/api/auth`, `/api/v1/auth` and `/api/<network>/auth`, with or without a query string. */
const SEP10_PATH = /^\/api\/(?:v1\/)?(?:[a-z][a-z0-9-]*\/)?auth(?:\?|$)/;

/** Ledgers the indexer may trail the network by before it is considered behind. */
const MAX_LAG = 120;

/** Ledgers the projection trails the network by; null until the first pass. */
function lagOf(indexer: IndexerStatus | undefined): number | null {
  return indexer && indexer.latest > 0 ? Math.max(0, indexer.latest - indexer.cursor) : null;
}

export interface NetworkRuntime {
  config: NetworkConfig;
  db: DatabaseSync;
  events?: EventEmitter | undefined;
  indexer?: IndexerStatus | undefined;
  summaryCache?: MerchantSummaryCache | undefined;
  rpc?: RpcStatus | undefined;
  /** Delivers charge events to registered webhooks. */
  webhooks?: WebhookDispatcher | undefined;
  /** SEP-10 sign-in (`/api/auth`); absent when it is not configured. */
  auth?: Sep10Auth | undefined;
  /** Token metadata source; without one the network's native asset still
   * resolves and every other token reports unavailable (never the network). */
  tokens?: TokenMetadataService | undefined;
}

function healthOf(runtime: NetworkRuntime): HealthResponse {
  const indexer = runtime.indexer;
  const lag = lagOf(indexer);
  const freshnessSeconds = indexer
    ? (indexer.freshnessSeconds ??
       (indexer.lastLedgerCloseTime != null
         ? Math.max(0, Math.floor(Date.now() / 1000) - indexer.lastLedgerCloseTime)
         : null))
    : null;
  const rpc = runtime.rpc;
  return {
    status: lag === null ? "starting" : lag <= MAX_LAG ? "ok" : "catching_up",
    network: runtime.config.name,
    indexer: indexer
      ? {
          cursor: indexer.cursor,
          latestLedger: indexer.latest,
          lag,
          paused: indexer.paused ?? false,
          freshnessSeconds,
          lastRunAt: indexer.lastRunAt ? new Date(indexer.lastRunAt).toISOString() : null,
          lastError: indexer.lastError,
          mismatchedEvents: indexer.mismatchedEvents ?? 0,
          reconciliations: indexer.reconciliations ?? 0,
          corrections: indexer.corrections ?? 0,
        }
      : null,
    rpc: rpc && "active" in rpc && Array.isArray(rpc.endpoints) ? { active: rpc.active, endpoints: rpc.endpoints } : null,
    contracts: {
      planRegistry: runtime.config.planRegistryId,
      vault: runtime.config.vaultId,
      subscription: runtime.config.subscriptionId,
    },
  };
}

export function createApp(
  runtimes: NetworkRuntime[],
  config: Config,
  admin?: AdminHooks,
): Express;
export function createApp(
  db: DatabaseSync,
  config: Config,
  indexer?: IndexerStatus,
  arg3?: MerchantSummaryCache | RpcStatus | AdminHooks | TokenMetadataService,
  arg4?: RpcStatus | AdminHooks | TokenMetadataService,
  arg5?: AdminHooks | TokenMetadataService,
): Express;
export function createApp(
  dbOrRuntimes: DatabaseSync | NetworkRuntime[],
  config: Config,
  arg2?: IndexerStatus | AdminHooks,
  arg3?: MerchantSummaryCache | RpcStatus | AdminHooks | TokenMetadataService,
  arg4?: RpcStatus | AdminHooks | TokenMetadataService,
  arg5?: AdminHooks | TokenMetadataService,
): Express {
  let runtimes: NetworkRuntime[];
  let admin: AdminHooks | undefined;
  let tokens: TokenMetadataService | undefined;
  const isMulti = Array.isArray(dbOrRuntimes);

  if (isMulti) {
    runtimes = dbOrRuntimes;
    if (typeof arg2 === "object" && arg2 !== null && ("reindex" in arg2 || "keeperPass" in arg2 || "keeperHistory" in arg2)) {
      admin = arg2 as AdminHooks;
    }
  } else {
    const db = dbOrRuntimes;
    const indexer = arg2 as IndexerStatus | undefined;
    let merchantCache: MerchantSummaryCache | undefined;
    let rpc: RpcStatus | undefined;

    // The collaborators are optional and positional, so each one is
    // identified by its type instead of by the slot it was passed in.
    for (const arg of [arg3, arg4, arg5]) {
      if (!arg) continue;
      if (arg instanceof MerchantSummaryCache) {
        merchantCache = arg;
      } else if (arg instanceof TokenMetadataService) {
        tokens = arg;
      } else if ("active" in arg && Array.isArray((arg as RpcStatus).endpoints)) {
        rpc = arg as RpcStatus;
      } else if (typeof arg === "object") {
        admin = arg as AdminHooks;
      }
    }

    runtimes = [
      {
        config: {
          name: config.STELLAR_NETWORK ?? "testnet",
          rpcUrl: config.SOROBAN_RPC_URL ?? "",
          networkPassphrase: config.NETWORK_PASSPHRASE ?? "",
          planRegistryId: config.PLAN_REGISTRY_ID ?? "",
          vaultId: config.VAULT_ID ?? "",
          subscriptionId: config.SUBSCRIPTION_ID ?? "",
          defaultToken: config.TOKEN_ID,
          startLedger: config.INDEXER_START_LEDGER ?? 0,
          databasePath: config.DATABASE_PATH ?? ":memory:",
        },
        db,
        indexer,
        summaryCache: merchantCache,
        rpc,
        tokens,
      },
    ];
  }

  const defaultRuntime = runtimes[0];
  if (!defaultRuntime) {
    throw new Error("at least one network runtime is required");
  }

  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet());

  // ReDoc runs its search index in a web worker created from a Blob URL.
  // Every other directive stays helmet's default: the bundle and the
  // bootstrap are same-origin modules (`script-src 'self'`), and ReDoc's
  // injected styles are covered by the default `style-src 'unsafe-inline'`.
  // This is the only addition the documentation page needs.
  app.use(
    "/api/docs",
    helmet.contentSecurityPolicy({
      directives: { "worker-src": ["'self'", "blob:"] },
    }),
  );

  app.use(
    pinoHttp({
      logger,
      // Accept a caller's id (bounded, so it cannot flood logs) or mint one.
      genReqId: (req, res) => {
        const given = req.headers["x-request-id"];
        const id = typeof given === "string" && /^[\w.-]{1,128}$/.test(given) ? given : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
    }),
  );
  app.use((req, res, next) => {
    void withSpan(`${req.method} request`, () => {
      return new Promise<void>((resolve) => {
        res.once("close", resolve);
        next();
      });
    });
  });
  const corsOrigin = config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(",");
  app.use(
    cors((req, callback) => {
      callback(null, {
        // SEP-10 requires `Access-Control-Allow-Origin: *` on its endpoints,
        // errors included, so any wallet can sign in from a browser.
        origin: SEP10_PATH.test(req.url ?? "") ? "*" : corsOrigin,
        // Browsers hide non-safelisted response headers from scripts unless exposed.
        exposedHeaders: ["X-Request-Id"],
      });
    }),
  );
  app.use(express.json({ limit: "64kb" }));

  app.get(["/health", "/ready"], (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use(
    "/api",
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    },
    rateLimit({
      windowMs: config.API_RATE_LIMIT_WINDOW_MS ?? 60_000,
      limit: config.API_RATE_LIMIT_MAX ?? 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (req, res) => sendApiError(res, req, 429, "rate_limited"),
    }),
  );

  // The API's own description: an OpenAPI 3.1 document covering every route
  // this instance serves. It is built once and cached, so a scrape costs
  // nothing beyond the JSON response.
  const openApiDocument = buildOpenApiDocument({
    networks: runtimes.map((rt) => rt.config.name),
  });
  app.get([`${API_V1}/openapi.json`, `${API_ALIAS}/openapi.json`], (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(openApiDocument);
  });

  // A readable rendering of the document above. The page, the bootstrap and
  // ReDoc's bundle are all served here: no request leaves this host, so the
  // documentation works offline and without opening the CSP to a CDN.
  app.get("/api/docs", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(DOCS_HTML);
  });
  app.get("/api/docs/docs.js", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("text/javascript").send(DOCS_INIT_SCRIPT);
  });
  app.get("/api/docs/redoc.standalone.js", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("text/javascript").send(REDOC_BUNDLE);
  });

  // Prometheus metrics. Opt-in: without METRICS_ENABLED the path does not
  // exist and answers 404 like any other unknown route.
  if (config.METRICS_ENABLED) {
    app.get("/metrics", (_req, res) => {
      // The gauges describe the projection as it stands, not as it stood
      // after the last pass, so they are refreshed before the render. The
      // business gauges are re-read the same way — one short indexed query
      // per network — which also serves a deployment whose API answers
      // without an attached indexer.
      for (const rt of runtimes) {
        if (rt.indexer) publishIndexerMetrics(rt.indexer, rt.config.name);
        publishBusinessMetrics(rt.db, rt.config.name);
      }
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(metrics.render());
    });
  }

  // Always 200 so a slow backfill does not get the service restarted; the
  // body says whether the projection is current.
  app.get("/health", (_req, res) => {
    const defaultHealth = healthOf(defaultRuntime);
    const body: HealthResponse = {
      ...defaultHealth,
      ...(isMulti || runtimes.length > 1
        ? {
            networks: Object.fromEntries(
              runtimes.map((rt) => [rt.config.name, healthOf(rt)]),
            ),
          }
        : {}),
    };
    res.json(body);
  });

  // Readiness for orchestrators: 503 until the projection trails the network
  // by no more than the same threshold /health uses, so traffic is not sent
  // to an instance that is still backfilling. An unknown lag (no indexer has
  // run yet, or none is attached) is treated as not ready, since the
  // freshness of the projection cannot be established.
  app.get("/ready", (_req, res) => {
    const lag = lagOf(defaultRuntime.indexer);
    const ready = lag !== null && lag <= MAX_LAG;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : lag === null ? "starting" : "catching_up",
      lag,
    });
  });

  // Version and build information endpoint.
  app.get("/version", (_req, res) => {
    res.json({
      ...getVersionInfo(),
      network: config.STELLAR_NETWORK,
      contracts: {
        planRegistry: config.PLAN_REGISTRY_ID,
        vault: config.VAULT_ID,
        subscription: config.SUBSCRIPTION_ID,
      },
    });
  });

  // Operator endpoints are opt-in. Without ADMIN_TOKEN — or without hooks —
  // /admin falls through to the 404 below like any unknown path.
  // ADMIN_TOKEN is a full-access token used exactly as written (a colon in it
  // is just part of the secret); scoped and expiring tokens come from
  // ADMIN_TOKENS.
  const adminTokens: AdminToken[] = [
    ...(config.ADMIN_TOKEN ? [{ token: config.ADMIN_TOKEN }] : []),
    ...((config.ADMIN_TOKENS ?? []) as AdminToken[]),
  ];
  if (adminTokens.length > 0 && admin) {
    app.use("/admin", buildAdminRoutes(adminTokens, admin));
  }

  if (config.KEEPER_ENABLED && admin?.keeperHistory) {
    app.get([`${API_V1}/keeper`, `${API_ALIAS}/keeper`], (_req, res) => {
      res.json({ passes: admin.keeperHistory?.() ?? [] });
    });
  }

  // A network without a wired token metadata source falls back to a reader
  // that reports every non-native token as unavailable, so a service started
  // without an RPC url never reaches the network from a request handler.
  // Native XLM still resolves from the passphrase alone.
  const tokenServiceOf = (rt: NetworkRuntime): TokenMetadataService =>
    rt.tokens ??
    new TokenMetadataService(asReader(undefined), {
      networkPassphrase: rt.config.networkPassphrase,
    });

  // One router, mounted twice: `/api/v1/...` is the canonical surface and
  // `/api/...` is the same router under the unversioned alias. The versioned
  // mount comes first so `/api` never has to answer a versioned path itself.
  const apiRouter = buildApiRouter(
    runtimes.map((rt) => ({
      name: rt.config.name,
      db: rt.db,
      events: rt.events,
      summaryCache: rt.summaryCache,
      defaultToken: rt.config.defaultToken ?? config.TOKEN_ID,
      tokens: tokenServiceOf(rt),
      webhooks: rt.webhooks,
      auth: rt.auth,
    })),
  );
  app.use(API_V1, apiRouter);
  app.use(API_ALIAS, apiRouter);

  // Anything no route answered: an unknown path, or a method the API does not
  // expose on a known one.
  app.use((req, res) => {
    sendApiError(res, req, 404, "not_found");
  });

  // Four arguments, so Express treats this as the error middleware and routes
  // every forwarded failure — including a rejected async handler — to it.
  app.use(errorHandler);

  return app;
}
