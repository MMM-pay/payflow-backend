import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.ts";
import { sendApiError, type ApiErrorCode } from "./errors.ts";

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
  pauseIndexer?: () => unknown;
  resumeIndexer?: () => unknown;
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
 */
export function buildAdminRoutes(token: string, hooks: AdminHooks): Router {
  const expected = digest(token);
  const r = Router();

  r.use((req, res, next) => {
    const header = req.get("authorization") ?? "";
    const supplied = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    if (!supplied || !timingSafeEqual(digest(supplied), expected)) {
      logger.warn({ method: req.method, path: req.path }, "admin request rejected");
      res.status(401).set("WWW-Authenticate", "Bearer");
      sendApiError(res, req, 401, "unauthorized");
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

  r.post("/reindex", async (req, res) => {
    const run = hooks.reindex;
    if (!run) {
      sendApiError(res, req, 503, "reindex_unavailable");
      return;
    }
    await respond(req, res, "reindex_failed", run);
  });

  r.post("/keeper/run", async (req, res) => {
    const run = hooks.keeperPass;
    if (!run) {
      sendApiError(res, req, 503, "keeper_unavailable");
      return;
    }
    await respond(req, res, "keeper_pass_failed", run);
  });

  r.get("/keeper/backoff", (req, res) => {
    const read = hooks.keeperBackoff;
    if (!read) {
      sendApiError(res, req, 503, "keeper_unavailable");
      return;
    }
    res.json({ status: "ok", backoff: read() ?? [] });
  });

  // Runtime indexer control. Pause holds the scheduled passes back; the API
  // keeps serving the projection as it stands. The body reports the new state
  // so an operator can confirm the switch took.
  r.post("/indexer/pause", (req, res) => {
    const pause = hooks.pauseIndexer;
    if (!pause) {
      sendApiError(res, req, 503, "indexer_unavailable");
      return;
    }
    res.json({ status: "ok", paused: true, result: pause() ?? null });
  });

  r.post("/indexer/resume", (req, res) => {
    const resume = hooks.resumeIndexer;
    if (!resume) {
      sendApiError(res, req, 503, "indexer_unavailable");
      return;
    }
    res.json({ status: "ok", paused: false, result: resume() ?? null });
  });

  return r;
}
