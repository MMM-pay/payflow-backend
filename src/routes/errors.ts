import type { Request, Response } from "express";

/**
 * Stable, machine-readable error codes.
 *
 * Every non-2xx response carries one of these in `error.code`, so clients can
 * branch on a closed set instead of matching free text. Codes never change
 * meaning; adding a variant here (not a rename) is the additive way to grow the
 * set. They are documented in the README's "Error responses" table.
 */
export type ApiErrorCode =
  | "not_found"
  | "plan_not_found"
  | "mandate_not_found"
  | "invalid_ids"
  | "too_many_ids"
  | "unauthorized"
  | "reindex_unavailable"
  | "keeper_unavailable"
  | "indexer_unavailable"
  | "reindex_failed"
  | "keeper_pass_failed"
  | "internal_error";

/**
 * The single error envelope every API path returns:
 *
 * ```json
 * { "error": { "code": "plan_not_found", "message": "...", "requestId": "..." } }
 * ```
 *
 * `code` is stable (see {@link ApiErrorCode}); `message` is a human-readable
 * explanation safe to show to an end user; `requestId` echoes the `X-Request-Id`
 * header so a report can be tied to the server log line.
 *
 * Migration note: this replaces the previous `{ "error": "<code>" }` string
 * body. Consumers that read the error must now read `error.code`.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string | null;
  };
}

/**
 * A safe default message per code. Used when a call site does not supply a more
 * specific one, and — critically — for `internal_error`, whose body must never
 * carry the exception's own message (it can hold a bound SQL value or an RPC
 * URL). Keeping the defaults here means no handler has to invent copy.
 */
const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  not_found: "The requested resource was not found.",
  plan_not_found: "No plan exists with that id.",
  mandate_not_found: "No mandate exists with that id.",
  invalid_ids: "The `ids` parameter must be a comma-separated list of positive integers.",
  too_many_ids: "The `ids` parameter accepts at most 100 mandate ids.",
  unauthorized: "A valid bearer token is required for this endpoint.",
  reindex_unavailable: "Reindexing is not available on this instance.",
  keeper_unavailable: "The keeper is not available on this instance.",
  indexer_unavailable: "Runtime indexer control is not available on this instance.",
  reindex_failed: "The reindex action failed.",
  keeper_pass_failed: "The keeper pass failed.",
  internal_error: "An internal error occurred.",
};

/**
 * The request id pino-http assigned to this request (and that the app echoed in
 * the `X-Request-Id` response header). Null when no id was minted, e.g. if the
 * logging middleware did not run.
 */
export function requestIdOf(req: Request): string | null {
  const id = (req as { id?: unknown }).id;
  if (typeof id === "string" && id.length > 0) return id;
  const header = req.res?.getHeader?.("X-Request-Id");
  return typeof header === "string" && header.length > 0 ? header : null;
}

/** Build the structured error body for a code, with an optional message override. */
export function apiErrorBody(
  code: ApiErrorCode,
  requestId: string | null,
  message?: string,
): ApiErrorBody {
  return {
    error: {
      code,
      message: message && message.length > 0 ? message : DEFAULT_MESSAGES[code],
      requestId,
    },
  };
}

/**
 * Send a structured error response. Every error path in the API funnels through
 * here so the shape, the code set, and the `requestId` stay consistent.
 */
export function sendApiError(
  res: Response,
  req: Request,
  status: number,
  code: ApiErrorCode,
  message?: string,
): void {
  res.status(status).json(apiErrorBody(code, requestIdOf(req), message));
}
