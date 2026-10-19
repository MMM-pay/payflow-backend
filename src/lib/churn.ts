/**
 * Bucket arithmetic for the merchant churn metrics.
 *
 * A churn bucket groups mandate lifecycle events by the calendar period they
 * happened in. All arithmetic is UTC and calendar-based: a bucket is anchored
 * at UTC midnight of its first day, and months are counted on the calendar
 * rather than by a fixed number of seconds, so a month is always the same
 * length in the report whatever the wall clock does.
 *
 * The same rule is expressed twice — once in TypeScript ({@link bucketStart})
 * and once as a SQL expression ({@link BUCKET_SQL}) — so the aggregation can
 * happen inside SQLite instead of pulling every event row into memory. The
 * two must agree, and `test/churn.test.ts` checks them against each other
 * over a range of instants.
 */

import type { ChurnBucketSize } from "../routes/types.ts";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * The SQL expression that maps an event's `at` (unix seconds) to the start of
 * its bucket, as unix seconds.
 *
 * These are static fragments keyed by bucket size — never built from request
 * input — and each one is the SQL twin of {@link bucketStart} for the same
 * size. The arithmetic floors (rather than truncates) so it agrees with the
 * JS for every instant, including ones before the epoch.
 */
export const BUCKET_SQL: Record<ChurnBucketSize, string> = {
  day: "CAST(FLOOR(at / 86400.0) AS INTEGER) * 86400",
  week: "345600 + CAST(FLOOR((at - 345600) / 604800.0) AS INTEGER) * 604800",
  month: "CAST(strftime('%s', strftime('%Y-%m-01', at, 'unixepoch')) AS INTEGER)",
};

/** Parse a `?bucket=` value; anything unknown falls back to `month`. */
export function churnBucketSize(raw: unknown): ChurnBucketSize {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "day" || value === "week" || value === "month") return value;
  return "month";
}

/**
 * The first instant of the bucket that `at` (unix seconds) falls in.
 *
 * Weeks start on Monday and months on the first of the month, both in UTC.
 */
export function bucketStart(size: ChurnBucketSize, at: number): Date {
  const day = new Date(Math.floor((at * 1000) / DAY_MS) * DAY_MS);
  if (size === "day") return day;
  if (size === "week") {
    // getUTCDay() is 0 for Sunday; shift so Monday is the first day.
    const offset = (day.getUTCDay() + 6) % 7;
    return new Date(day.getTime() - offset * DAY_MS);
  }
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
}

/** The label a bucket is reported under: `2025-01-15` for a day, the Monday's
 * date (`2025-01-13`) for a week, and `2025-01` for a month. */
export function bucketLabel(size: ChurnBucketSize, start: Date): string {
  const iso = start.toISOString();
  return size === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

/** The start of the bucket after the one starting at `start`. */
export function nextBucketStart(size: ChurnBucketSize, start: Date): Date {
  if (size === "day") return new Date(start.getTime() + DAY_MS);
  if (size === "week") return new Date(start.getTime() + WEEK_MS);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

/** The label of the bucket an event at `at` belongs to. */
export function bucketLabelAt(size: ChurnBucketSize, at: number): string {
  return bucketLabel(size, bucketStart(size, at));
}
