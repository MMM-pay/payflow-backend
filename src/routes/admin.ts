import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { logger } from "../lib/logger.ts";
import { sendApiError, type ApiErrorCode } from "./errors.ts";
import { hasRequestBody, limitSchema, queryOnly, validate } from "./validate.ts";

/**
 * Operations the process can perform on demand. A hook is absent when the
 * service was started without the capability — the keeper endpoints when
 * `KEEPER_ENABLED=false`, for example — and answer 503 rather than pretending.
 *
 * `pauseIndexer`/`resumeIndexer` hold the indexer loop back without taking the
 * API down, so an operator can inspect a bad event on a running instance.
 */
export interface AdminHooks {
  reindex?: () => Promise<unknown>;
  keeperPass?: () => Promise<unknown>;
  keeperBackoff?: () => unknown;
  keeperHistory?: () => unknown;
  /** List the due mandates and intended charges without submitting (#250). */
  keeperDryRun?: () => Promise<unknown>;
  pauseIndexer?: () => unknown;
  resumeIndexer?: () => unknown;
  pruneData?: (daysToKeep?: number) => Promise<unknown>;
  getAuditLogs?: (limit: number) => unknown;
  getPastDueMandates?: () => unknown;
  vacuumDb?: () => Promise<unknown>;
  /**
   * Returns the current raw-event retention policy: how many days events are
   * kept, when the last automatic prune ran, and how many raw events exist.
   */
  getRetentionPolicy?: () => Promise<unknown>;
}

/** Scoped operation that a token is allowed to perform. */
export type AdminScope = "reindex" | "keeper" | "indexer" | "*";

/** Admin token with optional expiry and scoping. */
export interface AdminToken {
  token: string;
  /** Operations the token may perform; all when omitted. */
  scopes?: AdminScope[];
  /** Unix seconds after which the token is refused. */
  expiresAt?: number;
}

/**
 * Fixed-size digest of a token. Comparing digests with `timingSafeEqual` is
 * constant-time and, unlike a byte-by-byte loop over the raw strings, leaks
 * neither the token's length nor the offset of the first differing byte.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Operator routes, mounted only when `ADMIN_TOKEN` is set.
 *
 * Every request needs `Authorization: Bearer <token>`; there is no
 * per-endpoint distinction, and an unauthenticated caller learns nothing
 * beyond 401. The token itself is never logged.
 *
 * Tokens can be scoped to specific operations and have expiry times.
 * Format: `token` or `token:scope1,scope2:expiry_timestamp` where expiry is optional.
 */
export function buildAdminRoutes(token: string | AdminToken[], hooks: AdminHooks): Router {
  const tokens: AdminToken[] = Array.isArray(token)
    ? token
    : [{ token }];
  const tokenDigests = tokens.map((configured) => ({
    configured,
    digest: digest(configured.token),
  }));

  const r = Router();

  function hasScope(t: AdminToken, scope: AdminScope): boolean {
    if (!t.scopes || t.scopes.includes("*")) return true;
    return t.scopes.includes(scope);
  }

  function isExpired(t: AdminToken): boolean {
    return t.expiresAt !== undefined && t.expiresAt * 1000 <= Date.now();
  }

  r.use((req, res, next) => {
    const header = req.get("authorization") ?? "";
    const supplied = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    if (!supplied || supplied.length > 4_096) {
      logger.warn({ method: req.method, path: req.path }, "admin request rejected");
      res.status(401).set("WWW-Authenticate", "Bearer");
      sendApiError(res, req, 401, "unauthorized");
      return;
    }

    const suppliedDigest = digest(supplied);
    let token: AdminToken | undefined;
    for (const candidate of tokenDigests) {
      const matches = timingSafeEqual(candidate.digest, suppliedDigest);
      if (matches && token === undefined) token = candidate.configured;
    }
    if (!token) {
      logger.warn({ method: req.method, path: req.path }, "admin request rejected");
      res.status(401).set("WWW-Authenticate", "Bearer");
      sendApiError(res, req, 401, "unauthorized");
      return;
    }

    if (isExpired(token)) {
      logger.warn({ method: req.method, path: req.path }, "admin token expired");
      res.status(401).set("WWW-Authenticate", "Bearer");
      sendApiError(res, req, 401, "unauthorized");
      return;
    }

    (req as Request & { adminToken?: AdminToken }).adminToken = token;
    next();
  });

  r.use((req, res, next) => {
    if (hasRequestBody(req)) {
      sendApiError(res, req, 400, "invalid_request", undefined, [
        { path: "body", message: "is not accepted for this route" },
      ]);
      return;
    }
    next();
  });

  async function respond(
    req: Request,
    res: Response,
    code: ApiErrorCode,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      res.json({ status: "ok", result: (await run()) ?? null });
    } catch (err) {
      logger.error({ err, code }, "admin action failed");
      // The raw message is surfaced here (unlike the public error boundary)
      // because these endpoints are operator-only and authenticated; the
      // secret-scrubbing rule is about logs, not the admin response.
      sendApiError(res, req, 500, code, err instanceof Error ? err.message : String(err));
    }
  }

  r.post("/reindex", queryOnly(), async (req, res) => {
    const reqWithToken = req as Request & { adminToken?: AdminToken };
    if (reqWithToken.adminToken && !hasScope(reqWithToken.adminToken, "reindex")) {
      sendApiError(res, req, 403, "unauthorized", "Insufficient permissions for this operation");
      return;
    }
    const run = hooks.reindex;
    if (!run) {
      sendApiError(res, req, 503, "reindex_unavailable", undefined, undefined, 30);
      return;
    }
    await respond(req, res, "reindex_failed", run);
  });

  r.post("/keeper/run", queryOnly(), async (req, res) => {
    const reqWithToken = req as Request & { adminToken?: AdminToken };
    if (reqWithToken.adminToken && !hasScope(reqWithToken.adminToken, "keeper")) {
      sendApiError(res, req, 403, "unauthorized", "Insufficient permissions for this operation");
      return;
    }
    const run = hooks.keeperPass;
    if (!run) {
      sendApiError(res, req, 503, "keeper_unavailable", undefined, undefined, 30);
      return;
    }
    await respond(req, res, "keeper_pass_failed", run);
  });

  r.get("/keeper/dry-run", queryOnly(), async (req, res) => {
    const reqWithToken = req as Request & { adminToken?: AdminToken };
    if (reqWithToken.adminToken && !hasScope(reqWithToken.adminToken, "keeper")) {
      sendApiError(res, req, 403, "unauthorized", "Insufficient permissions for this operation");
      return;
    }
    const run = hooks.keeperDryRun;
    if (!run) {
      sendApiError(res, req, 503, "keeper_unavailable", undefined, undefined, 30);
      return;
    }
    try {
      res.json({ status: "ok", dry_run: (await run()) ?? null });
    } catch (err) {
      logger.error({ err }, "keeper dry run failed");
      sendApiError(res, req, 500, "keeper_pass_failed", err instanceof Error ? err.message : String(err));
    }
  });

  r.get("/keeper/backoff", queryOnly(), (req, res) => {
    const reqWithToken = req as Request & { adminToken?: AdminToken };
    if (reqWithToken.adminToken && !hasScope(reqWithToken.adminToken, "keeper")) {
      sendApiError(res, req, 403, "unauthorized", "Insufficient permissions for this operation");
      return;
    }
    const read = hooks.keeperBackoff;
    if (!read) {
      sendApiError(res, req, 503, "keeper_unavailable", undefined, undefined, 30);
      return;
    }
    res.json({ status: "ok", backoff: read() ?? [] });
  });

  // Runtime indexer control. Pause holds the scheduled passes back; the API
  // keeps serving the projection as it stands. The body reports the new state
  // so an operator can confirm the switch took.
  r.post("/indexer/pause", queryOnly(), async (req, res) => {
    const reqWithToken = req as Request & { adminToken?: AdminToken };
    if (reqWithToken.adminToken && !hasScope(reqWithToken.adminToken, "indexer")) {
      sendApiError(res, req, 403, "unauthorized", "Insufficient permissions for this operation");
      return;
    }
    const pause = hooks.pauseIndexer;
    if (!pause) {
      sendApiError(res, req, 503, "indexer_unavailable", undefined, undefined, 30);
      return;
    }
    res.json({ status: "ok", paused: true, result: (await pause()) ?? null });
  });

  r.post("/indexer/resume", queryOnly(), async (req, res) => {
    const reqWithToken = req as Request & { adminToken?: AdminToken };
    if (reqWithToken.adminToken && !hasScope(reqWithToken.adminToken, "indexer")) {
      sendApiError(res, req, 403, "unauthorized", "Insufficient permissions for this operation");
      return;
    }
    const resume = hooks.resumeIndexer;
    if (!resume) {
      sendApiError(res, req, 503, "indexer_unavailable", undefined, undefined, 30);
      return;
    }
    res.json({ status: "ok", paused: false, result: (await resume()) ?? null });
  });

  r.post("/data/prune", queryOnly("days"), async (req, res) => {
    const prune = hooks.pruneData;
    if (!prune) {
      sendApiError(res, req, 503, "prune_unavailable", undefined, undefined, 30);
      return;
    }
    const parsedDays = validate(
      req,
      res,
      "days",
      z.string().regex(/^\d+$/, "must be a non-negative integer")
        .transform(Number)
        .refine(Number.isSafeInteger, "must be a non-negative integer")
        .optional(),
      req.query.days,
    );
    if (!parsedDays.ok) return;
    const daysToKeep = parsedDays.value;
    await respond(req, res, "prune_failed", () => prune(daysToKeep));
  });

  r.get("/data/retention", async (req, res) => {
    const read = hooks.getRetentionPolicy;
    if (!read) {
      sendApiError(res, req, 503, "retention_unavailable", undefined, undefined, 30);
      return;
    }
    await respond(req, res, "retention_failed", read);
  });

  r.get("/audit-logs", async (req, res) => {
    const read = hooks.getAuditLogs;
    if (!read) {
      sendApiError(res, req, 503, "audit_unavailable", undefined, undefined, 30);
      return;
    }
    const parsedLimit = validate(req, res, "limit", limitSchema.optional(), req.query.limit);
    if (!parsedLimit.ok) return;
    const limit = Math.min(1000, parsedLimit.value ?? 100);
    res.json({ status: "ok", logs: (await read(limit)) ?? [] });
  });

  r.get("/past-due", queryOnly(), async (req, res) => {
    const read = hooks.getPastDueMandates;
    if (!read) {
      sendApiError(res, req, 503, "indexer_unavailable", undefined, undefined, 30);
      return;
    }
    res.json({ status: "ok", past_due: (await read()) ?? [] });
  });

  r.post("/db/vacuum", async (req, res) => {
    const run = hooks.vacuumDb;
    if (!run) {
      sendApiError(res, req, 503, "vacuum_unavailable", undefined, undefined, 30);
      return;
    }
    await respond(req, res, "vacuum_failed", run);
  });

  return r;
}
