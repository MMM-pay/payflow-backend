import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { MandateRow, SubscriberSummary, UpcomingCharge, UpcomingChargesResponse } from "./types.ts";

const DAY_S = 86_400;
const DEFAULT_FORECAST_DAYS = 30;
const MAX_FORECAST_DAYS = 365;
const MAX_UPCOMING_PER_MANDATE = 400;

function daysOf(raw: unknown, fallback = DEFAULT_FORECAST_DAYS): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), MAX_FORECAST_DAYS);
}

/** `GET /subscribers/:address/summary` and `GET /subscribers/:address/upcoming`. */
export function subscribersRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/subscribers/:address/summary", (req, res) => {
    const address = String(req.params.address);
    const mandates = db
      .prepare("SELECT * FROM mandates WHERE subscriber = ? ORDER BY id DESC")
      .all(address) as unknown as MandateRow[];
    const paid = db
      .prepare(
        "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges WHERE subscriber = ?",
      )
      .get(address) as { total: number };
    const body: SubscriberSummary = {
      subscriber: address,
      mandates,
      totalPaid: String(paid.total),
    };
    res.json(body);
  });

  /**
   * What this subscriber will be charged over the next `days`.
   *
   * Scheduling rule, matching the contract: a mandate is chargeable when
   * `next_charge <= now`, and a charge sets `next_charge = charge time + period`.
   * A due mandate is therefore projected at `now` — the keeper settles it as
   * soon as it can — and a future one at its `next_charge`; periods it is
   * already late for are not replayed, because the contract jumps to
   * `now + period` rather than walking the ones it skipped. Subsequent
   * occurrences step by `period` while they stay inside `[now, until)`.
   */
  r.get("/subscribers/:address/upcoming", (req, res) => {
    const subscriber = String(req.params.address);
    const days = daysOf(req.query.days);
    const now = Math.floor(Date.now() / 1000);
    const until = now + days * DAY_S;

    const mandates = db
      .prepare(
        `SELECT id, merchant, amount, period, next_charge, charges_made, max_charges
           FROM mandates WHERE subscriber = ? AND status = 'Active' AND period > 0`,
      )
      .all(subscriber) as {
      id: number;
      merchant: string;
      amount: string;
      period: number;
      next_charge: number;
      charges_made: number;
      max_charges: number;
    }[];

    const upcoming: UpcomingCharge[] = [];
    let truncated = false;

    for (const m of mandates) {
      // max_charges of 0 means open-ended; otherwise the remaining allowance
      // caps the count, the same boundary /due uses to stop offering a
      // mandate for settlement.
      const remaining = m.max_charges > 0 ? Math.max(0, m.max_charges - m.charges_made) : Infinity;
      let at = Math.max(m.next_charge, now);
      let emitted = 0;
      while (emitted < remaining && at < until) {
        if (emitted === MAX_UPCOMING_PER_MANDATE) {
          truncated = true;
          break;
        }
        upcoming.push({ mandateId: m.id, merchant: m.merchant, amount: m.amount, at });
        emitted += 1;
        at += m.period;
      }
    }

    upcoming.sort((a, b) => a.at - b.at || a.mandateId - b.mandateId);
    let total = 0n;
    for (const charge of upcoming) total += BigInt(charge.amount);

    const body: UpcomingChargesResponse = {
      subscriber,
      days,
      now,
      until,
      upcoming,
      totalUpcoming: total.toString(),
      truncated,
      assumptions: [
        "Only Active mandates are projected; paused, cancelled, and completed mandates are excluded.",
        "A mandate already due is projected at `now` (the next keeper pass settles it), then every `period`; missed periods are not replayed, matching the contract, which sets next_charge = charge time + period.",
        "Occurrences fall in [now, until); one falling due exactly at `until` is excluded.",
        "`amount` is the gross per-charge the subscriber pays, the same figure the contract pulls from the vault; `totalUpcoming` sums the listed occurrences.",
        "A mandate with max_charges > 0 is projected only up to its remaining allowance (max_charges − charges_made).",
        "At most 400 occurrences per mandate are listed; `truncated` says when that cap clipped the output.",
        "Vault funding is not modelled; an underfunded vault will not settle on schedule.",
      ],
    };
    res.json(body);
  });

  return r;
}
