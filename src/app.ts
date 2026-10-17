import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { pinoHttp } from "pino-http";
import type { DatabaseSync } from "node:sqlite";
import type { Config, NetworkConfig } from "./config.ts";
import type { IndexerStatus } from "./indexer.ts";
import { buildAdminRoutes, type AdminHooks } from "./routes/admin.ts";
import { buildApiRouter, MerchantSummaryCache } from "./routes/index.ts";
import type { HealthResponse } from "./routes/types.ts";
import type { RpcStatus } from "./lib/stellar.ts";
import { logger } from "./lib/logger.ts";
import { withSpan } from "./lib/telemetry.ts";

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
  res.status(500).json({ error: "internal_error" });
}

/** Ledgers the indexer may trail the network by before it is considered behind. */
const MAX_LAG = 120;

/** Ledgers the projection trails the network by; null until the first pass. */
function lagOf(indexer: IndexerStatus | undefined): number | null {
  return indexer && indexer.latest > 0 ? Math.max(0, indexer.latest - indexer.cursor) : null;
}

export interface NetworkRuntime {
  config: NetworkConfig;
  db: DatabaseSync;
  indexer?: IndexerStatus | undefined;
  summaryCache?: MerchantSummaryCache | undefined;
  rpc?: RpcStatus | undefined;
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
          freshnessSeconds,
          lastRunAt: indexer.lastRunAt ? new Date(indexer.lastRunAt).toISOString() : null,
          lastError: indexer.lastError,
          mismatchedEvents: indexer.mismatchedEvents ?? 0,
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
  arg3?: MerchantSummaryCache | RpcStatus | AdminHooks,
  arg4?: RpcStatus | AdminHooks,
  arg5?: AdminHooks,
): Express;
export function createApp(
  dbOrRuntimes: DatabaseSync | NetworkRuntime[],
  config: Config,
  arg2?: IndexerStatus | AdminHooks,
  arg3?: MerchantSummaryCache | RpcStatus | AdminHooks,
  arg4?: RpcStatus | AdminHooks,
  arg5?: AdminHooks,
): Express {
  let runtimes: NetworkRuntime[];
  let admin: AdminHooks | undefined;
  const isMulti = Array.isArray(dbOrRuntimes);

  if (isMulti) {
    runtimes = dbOrRuntimes;
    if (typeof arg2 === "object" && arg2 !== null && ("reindex" in arg2 || "keeperPass" in arg2)) {
      admin = arg2 as AdminHooks;
    }
  } else {
    const db = dbOrRuntimes;
    const indexer = arg2 as IndexerStatus | undefined;
    let merchantCache: MerchantSummaryCache | undefined;
    let rpc: RpcStatus | undefined;

    for (const arg of [arg3, arg4, arg5]) {
      if (!arg) continue;
      if (arg instanceof MerchantSummaryCache) {
        merchantCache = arg;
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
      },
    ];
  }

  const defaultRuntime = runtimes[0];
  if (!defaultRuntime) {
    throw new Error("at least one network runtime is required");
  }

  const app = express();

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
  app.use(
    cors({
      origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(","),
      // Browsers hide non-safelisted response headers from scripts unless exposed.
      exposedHeaders: ["X-Request-Id"],
    }),
  );
  app.use(express.json({ limit: "64kb" }));

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

  // Operator endpoints are opt-in. Without ADMIN_TOKEN — or without hooks —
  // /admin falls through to the 404 below like any unknown path.
  if (config.ADMIN_TOKEN && admin) {
    app.use("/admin", buildAdminRoutes(config.ADMIN_TOKEN, admin));
  }

  app.use(
    "/api",
    buildApiRouter(
      runtimes.map((rt) => ({
        name: rt.config.name,
        db: rt.db,
        summaryCache: rt.summaryCache,
        defaultToken: rt.config.defaultToken ?? config.TOKEN_ID,
      })),
    ),
  );

  // Anything no route answered: an unknown path, or a method the API does not
  // expose on a known one.
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Four arguments, so Express treats this as the error middleware and routes
  // every forwarded failure — including a rejected async handler — to it.
  app.use(errorHandler);

  return app;
}
