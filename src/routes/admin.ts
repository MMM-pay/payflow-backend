import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Response } from "express";
import { logger } from "../lib/logger.ts";

/**
 * Operations the process can perform on demand. A hook is absent when the
 * service was started without the capability — the keeper endpoints when
 * `KEEPER_ENABLED=false`, for example — and answer 503 rather than pretending.
 */
export interface AdminHooks {
  reindex?: () => Promise<unknown>;
  keeperPass?: () => Promise<unknown>;
  keeperBackoff?: () => unknown;
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
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
      return;
    }
    next();
  });

  async function respond(
    res: Response,
    label: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      res.json({ status: "ok", result: (await run()) ?? null });
    } catch (err) {
      logger.error({ err, label }, "admin action failed");
      res.status(500).json({
        error: `${label}_failed`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  r.post("/reindex", async (_req, res) => {
    const run = hooks.reindex;
    if (!run) {
      res.status(503).json({ error: "reindex_unavailable" });
      return;
    }
    await respond(res, "reindex", run);
  });

  r.post("/keeper/run", async (_req, res) => {
    const run = hooks.keeperPass;
    if (!run) {
      res.status(503).json({ error: "keeper_unavailable" });
      return;
    }
    await respond(res, "keeper_pass", run);
  });

  r.get("/keeper/backoff", (_req, res) => {
    const read = hooks.keeperBackoff;
    if (!read) {
      res.status(503).json({ error: "keeper_unavailable" });
      return;
    }
    res.json({ status: "ok", backoff: read() ?? [] });
  });

  return r;
}
