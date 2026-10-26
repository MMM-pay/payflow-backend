/**
 * Request validation.
 *
 * The API used to cast whatever it was given — `String(address)`,
 * `Number(id)` — so a typo in a query parameter looked like an empty result
 * instead of an error, and a client bug was hard to tell apart from a
 * merchant with no data. Every parameter with a known set of valid values is
 * validated here instead, and a bad one is answered with `400
 * invalid_request` and the details of what was wrong with it.
 *
 * The schemas are zod's, which the configuration already uses, so the rules
 * are declared once and read like a contract. An address is a real Stellar
 * StrKey (an account `G...` or a contract `C...`), not merely a string that
 * looks like one: a mistyped address has a broken checksum, and accepting it
 * would answer with the same empty page the typo deserves to be told about.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { Request, Response } from "express";
import { sendApiError } from "./errors.ts";

/** What is wrong with one parameter. */
export interface ValidationDetail {
  /** The parameter the problem is about, e.g. `merchant` or `id`. */
  path: string;
  /** What is wrong with it, in words the caller can act on. */
  message: string;
}

/**
 * The outcome of validating one parameter: the value, or a response that has
 * already been sent. `ok` discriminates the two, so a route can narrow on
 * it and use the value without a cast.
 */
export type Validated<T> = { ok: true; value: T } | { ok: false };

/** A Stellar account (`G...`) or contract (`C...`) address. */
export const addressSchema = z.string().refine(
  (value) => StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value),
  "must be a Stellar address (a G... account or a C... contract)",
);

/** The statuses a mandate can be in; any other value matches no mandate. */
export const mandateStatusSchema = z.enum(["Active", "Paused", "Cancelled", "Completed"]);

/**
 * A positive integer, written the way a query parameter arrives: digits
 * only, so `1.5`, `1e3` and `0x10` are refused rather than quietly read as
 * something else.
 */
const positiveInteger = z
  .string()
  .regex(/^\d+$/, "must be a positive integer")
  .transform(Number)
  .refine(
    (value) => Number.isSafeInteger(value) && value > 0,
    "must be a positive integer",
  );

/** An id in a path or a query: a plan id, a mandate id. */
export const idSchema = positiveInteger;

/**
 * A page size. A value above the cap is not refused: the route caps it, as
 * it always has, so asking for more rows is not an error.
 */
export const limitSchema = positiveInteger;

/** A number of days, as the forecast and upcoming windows take it. */
export const daysSchema = positiveInteger;

/**
 * A unix timestamp in seconds, as the revenue range takes it. Zero is the
 * epoch and a legitimate bound, so this one is not required to be positive.
 */
export const unixSecondsSchema = z
  .string()
  .regex(/^\d+$/, "must be a unix timestamp in seconds")
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value), "must be a unix timestamp in seconds");

/** A date-only ISO 8601 string, interpreted as midnight UTC. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** An ISO 8601 date-time, with an explicit `Z` or numeric offset. */
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * A date bound for a range query: unix seconds or an ISO 8601 date/date-time.
 *
 * `2026-10-01` starts or ends that UTC day depending on which end of the range
 * it bounds, so a date-only `from` and `to` cover the whole day inclusively. A
 * date-time must carry `Z` or a numeric offset, so the result never depends on
 * the server's timezone. The value is returned as unix seconds so callers
 * compare and bind one unit.
 */
export function dateBoundSchema(end: "from" | "to") {
  return z.string().transform((value, ctx) => {
    const text = value.trim();
    if (/^\d+$/.test(text)) {
      const seconds = Number(text);
      // The largest instant a JavaScript Date can represent, and small enough
      // that converting it to milliseconds stays a safe integer.
      if (Number.isSafeInteger(seconds) && seconds <= 8_640_000_000_000) return seconds;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a unix timestamp in seconds or an ISO 8601 date/date-time",
      });
      return z.NEVER;
    }

    const dateOnly = ISO_DATE.test(text);
    const iso = dateOnly
      ? `${text}T00:00:00Z`
      : ISO_DATE_TIME.test(text)
        ? text
        : null;
    const millis = iso === null ? Number.NaN : Date.parse(iso);
    if (
      iso === null ||
      !Number.isFinite(millis) ||
      (dateOnly && new Date(millis).toISOString().slice(0, 10) !== text)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a unix timestamp in seconds or an ISO 8601 date/date-time",
      });
      return z.NEVER;
    }
    const seconds = Math.floor(millis / 1000);
    return end === "to" && dateOnly ? seconds + 86_399 : seconds;
  });
}

/** A calendar bucket size: the periods the churn and revenue reports use. */
export const bucketSchema = z.enum(["day", "week", "month"]);

/**
 * An opaque cursor returned by a list endpoint. It encodes the primary key
 * of the last row on the page (`{ id }`) as base64url JSON, so clients treat
 * it as an opaque token and the server pages by primary key, never by offset.
 */
export const cursorSchema = z
  .string()
  .transform((value, ctx) => {
    let decoded: { id: unknown };
    try {
      decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a cursor returned by the API" });
      return z.NEVER;
    }
    if (
      typeof decoded?.id !== "number" ||
      !Number.isSafeInteger(decoded.id) ||
      decoded.id <= 0
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a cursor returned by the API" });
      return z.NEVER;
    }
    return decoded.id;
  });

/**
 * An absent or empty query value.
 *
 * `?merchant=` means "no filter" in every client that builds the URL, so an
 * empty value is treated as a parameter that was not given rather than as
 * one that is wrong.
 */
export function present(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  return raw;
}

/**
 * Validate one parameter and answer the request when it is wrong.
 *
 * On success the value is returned; on failure the response has already been
 * sent with `400 invalid_request` and the details of the problem, and the
 * caller returns without doing any work.
 */
export function validate<S extends z.ZodType>(
  req: Request,
  res: Response,
  path: string,
  schema: S,
  raw: unknown,
): Validated<z.output<S>> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data as z.output<S> };
  const details: ValidationDetail[] = parsed.error.issues.map((issue) => ({
    path,
    message: issue.message,
  }));
  sendApiError(res, req, 400, "invalid_request", undefined, details);
  return { ok: false };
}
