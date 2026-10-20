import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { rpc } from "@stellar/stellar-sdk";
import type { Config, NetworkConfig } from "./config.ts";

export type IndexerConfig = Config | NetworkConfig;
import { readCursor, writeCursor } from "./lib/db.ts";
import {
  big,
  decodeEvent,
  num,
  parseCloseTime,
  specProblems,
  str,
  type Archive,
  type DecodedEvent,
} from "./lib/stellar.ts";
import { logger } from "./lib/logger.ts";
import { metrics, publishIndexerMetrics } from "./lib/metrics.ts";
import { defaultMerchantSummaryCache, type MerchantSummaryCache } from "./routes/index.ts";

export { parseCloseTime };

/** RPC caps a single getEvents window; stay well inside it. */
const LEDGER_WINDOW = 8_000;
const PAGE_LIMIT = 200;

/** The RPC calls the indexer makes. Narrow so tests can supply a fake. */
export type IndexerRpc = Pick<rpc.Server, "getLatestLedger" | "getHealth" | "getEvents">;

/** A full-history archive able to re-serve a ledger range the RPC no longer
 * keeps. Only `getEvents` is needed (see `lib/stellar.ts`). */
export type { Archive };

/** What `apply` did with an event, so a pass can account for every one. */
export type ApplyOutcome = "applied" | "mismatched" | "unknown";

export interface TickResult {
  /** Events applied in this pass. */
  applied: number;
  /** Events that failed contract-spec validation; reported, not projected. */
  mismatched: number;
  /** Next ledger to read; everything before it has been indexed. */
  cursor: number;
  /** Latest ledger the RPC node reported. */
  latest: number;
}

/** Progress, exposed on /health so a stalled indexer is visible. */
export interface IndexerStatus {
  cursor: number;
  latest: number;
  lastRunAt: number | null;
  lastError: string | null;
  /**
   * Events seen since process start that did not match the contract spec.
   * A growing count means the contracts changed shape and the projection is
   * silently missing data — check the warn logs for which events.
   */
  mismatchedEvents?: number;
  /**
   * Close time of the last indexed ledger (unix timestamp in seconds).
   */
  lastLedgerCloseTime?: number | null;
  /**
   * Data freshness in seconds (seconds elapsed since the last indexed ledger closed).
   */
  freshnessSeconds?: number | null;
  /**
   * True when an operator has held the indexer loop back at runtime
   * (`POST /admin/indexer/pause`). Passes become no-ops until it is resumed;
   * the cursor is preserved so the projection picks up where it left off and
   * the API keeps serving. Reported on `/health`.
   */
  paused?: boolean;
  /**
   * Reconcile passes run since process start. Each pass re-reads a sample of
   * active mandates from the contract and repairs drift the indexer may have
   * missed.
   */
  reconciliations?: number;
  /**
   * Mandate rows the reconciler has brought back in line with the chain since
   * process start. Reported on `/health`; a growing count means the indexer
   * is silently missing on-chain state.
   */
  corrections?: number;
}

export class Indexer {
  private readonly db: DatabaseSync;
  private readonly server: IndexerRpc;
  private readonly config: IndexerConfig;
  readonly events = new EventEmitter();
  readonly merchantCache: MerchantSummaryCache;
  readonly status: IndexerStatus = {
    cursor: 0,
    latest: 0,
    lastRunAt: null,
    lastError: null,
    mismatchedEvents: 0,
    lastLedgerCloseTime: null,
    freshnessSeconds: null,
    paused: false,
  };
  /** Events since process start that failed spec validation. */
  get mismatchedEvents(): number {
    return this.status.mismatchedEvents ?? 0;
  }

  /**
   * Hold the indexer loop back at runtime without stopping the process. The
   * next `tick` becomes a no-op (no RPC, no writes, cursor preserved) until
   * {@link resume} — so the API keeps serving the current projection while an
   * operator investigates.
   */
  pause(): void {
    this.status.paused = true;
  }

  /** Let passes run again after {@link pause}. */
  resume(): void {
    this.status.paused = false;
  }

  constructor(
    db: DatabaseSync,
    server: IndexerRpc,
    config: IndexerConfig,
    merchantCache: MerchantSummaryCache = defaultMerchantSummaryCache,
    archive?: Archive,
  ) {
    this.db = db;
    this.server = server;
    this.config = config;
    this.merchantCache = merchantCache;
    this.archive = archive;
    // Publish the starting state, so a scrape sees the series from the first
    // moment and not only once the first pass has run.
    this.publishMetrics(0);
  }

  /** The archive used to backfill a gap, if ARCHIVE_URL was configured. */
  private readonly archive: Archive | undefined;

  /** Advance past a gap the RPC cannot serve; accepts silent under-reporting. */
  private get allowGaps(): boolean {
    return "ALLOW_GAPS" in this.config ? this.config.ALLOW_GAPS === true : this.config.allowGaps === true;
  }

  private contractIds(): string[] {
    if ("planRegistryId" in this.config) {
      return [
        this.config.planRegistryId,
        this.config.vaultId,
        this.config.subscriptionId,
      ];
    }
    return [
      this.config.PLAN_REGISTRY_ID,
      this.config.VAULT_ID,
      this.config.SUBSCRIPTION_ID,
    ];
  }

  /**
   * The network this indexer reads, as it appears on the metrics' `network`
   * label. A configuration built from the environment names it too, so the
   * label is the same either way.
   */
  private get networkLabel(): string {
    if ("name" in this.config) return this.config.name;
    return this.config.STELLAR_NETWORK ?? "default";
  }

  /**
   * Publish the indexer's progress to the metrics registry.
   *
   * The gauges are the ones an operator alerts on: how far the projection has
   * got, how far the network has got, and the difference between them. The
   * counter counts the events the projection has absorbed.
   *
   * A pass that fails still publishes: the cursor it reached is the truth the
   * operator needs, and the lag it leaves behind is exactly what the alert is
   * for.
   */
  private publishMetrics(applied: number): void {
    const network = this.networkLabel;
    publishIndexerMetrics(this.status, network);
    if (applied > 0) metrics.increment("events_applied", applied, { network });
  }

  /**
   * Where this pass starts: the saved cursor; with none, the configured start
   * ledger (normally the one the contracts were deployed at); with neither,
   * the oldest ledger the RPC node still serves. The result is clamped to the
   * node's retention window, since RPC rejects ranges that begin before it.
   */
  /**
   * Where this pass starts: the saved cursor; with none, the configured start
   * ledger (normally the one the contracts were deployed at); with neither,
   * the oldest ledger the RPC node still serves. The result is clamped to the
   * node's retention window, since RPC rejects ranges that begin before it.
   *
   * When the saved cursor falls behind the oldest ledger the RPC still
   * serves, every ledger in [cursor, oldest) is unreachable through this
   * node — a gap. It is reported as a structured warning naming the exact
   * missing range, and the cursor is not advanced past it unless an archive
   * backfills it or ALLOW_GAPS=true accepts the loss: serving numbers that
   * quietly understate revenue is worse than reporting the gap loudly.
   */
  private async firstLedger(saved: number): Promise<number> {
    const health = await this.server.getHealth();
    const oldest = health.oldestLedger;
    const startSetting = "startLedger" in this.config ? this.config.startLedger : this.config.INDEXER_START_LEDGER;
    const wanted = saved > 0 ? saved : startSetting;
    if (wanted > 0 && wanted >= oldest) return wanted;
    if (wanted > 0) {
      logger.warn(
        { gapFrom: wanted, gapTo: oldest, oldestLedger: oldest },
        "gap between the indexed cursor and the oldest ledger the RPC serves",
      );
      if (this.archive) {
        const applied = await this.backfillGap(wanted, oldest);
        logger.info(
          { gapFrom: wanted, gapTo: oldest, events: applied },
          "backfilled gap from archive",
        );
        return oldest;
      }
      if (!this.allowGaps) {
        const err = new Error(
          `will not advance indexer cursor past missing ledgers [${wanted}, ${oldest}); set ALLOW_GAPS=true or configure ARCHIVE_URL`,
        );
        logger.error({ gapFrom: wanted, gapTo: oldest }, err.message);
        throw err;
      }
      logger.warn(
        { gapFrom: wanted, gapTo: oldest },
        "ALLOW_GAPS=true: advancing past missing ledgers; events before the oldest RPC ledger are lost",
      );
    }
    return oldest;
  }

  /**
   * Re-apply every contract event in [start, end) from the full-history
   * archive, then advance the cursor to `end`. Writes are idempotent, so a
   * backfill interrupted mid-range is replayed from the saved cursor on the
   * next pass instead of duplicating anything.
   */
  private async backfillGap(start: number, end: number): Promise<number> {
    if (!this.archive) return 0;
    const filters: rpc.Api.EventFilter[] = [{ type: "contract", contractIds: this.contractIds() }];
    let applied = 0;
    let cursor: string | undefined;
    let pastEnd = false;
    for (;;) {
      const request: rpc.Api.GetEventsRequest = cursor
        ? { cursor, filters, limit: PAGE_LIMIT }
        : { startLedger: start, endLedger: end, filters, limit: PAGE_LIMIT };
      const page = await this.archive.getEvents(request);
      for (const raw of page.events ?? []) {
        if (raw.ledger >= end) {
          pastEnd = true;
          break;
        }
        const decoded = decodeEvent(raw);
        if (!decoded) continue;
        if (this.apply(decoded) !== "mismatched") applied += 1;
      }
      if (pastEnd || (page.events ?? []).length === 0 || !page.cursor) break;
      cursor = page.cursor;
    }
    // Only advance after the whole gap is applied, so a retry replays it
    // safely: every apply path is idempotent.
    writeCursor(this.db, end);
    this.status.cursor = end;
    return applied;
  }

  /**
   * Fetch every page of one ledger window. Cursor pages cannot carry
   * `endLedger`, so events at or past `end` are dropped here; a short page does
   * not prove the range is exhausted, only an empty page or the range end does.
   */
  private async fetchWindow(
    start: number,
    end: number,
    filters: rpc.Api.EventFilter[],
  ): Promise<rpc.Api.EventResponse[]> {
    const events: rpc.Api.EventResponse[] = [];
    let page = await this.server.getEvents({
      startLedger: start,
      endLedger: end,
      filters,
      limit: PAGE_LIMIT,
    });

    for (;;) {
      let pastEnd = false;
      for (const raw of page.events ?? []) {
        if (raw.ledger >= end) {
          pastEnd = true;
          break;
        }
        events.push(raw);
      }
      if (pastEnd || (page.events ?? []).length === 0 || !page.cursor) break;
      page = await this.server.getEvents({ cursor: page.cursor, filters, limit: PAGE_LIMIT });
    }
    return events;
  }

  /**
   * Index ledgers [cursor, min(cursor + LEDGER_WINDOW * concurrency, latest)).
   *
   * Up to `INDEXER_FETCH_CONCURRENCY` windows are fetched in parallel, but
   * their events are applied in ledger order and the cursor only advances after
   * a window has been applied. If a fetch fails, windows already applied keep
   * their cursor and the next pass resumes at the failed one. A crash mid-range
   * replays that range on restart; every apply path is idempotent so that is
   * safe.
   */
  private updateFreshness(
    latestCloseTime: number | null,
    eventCloseTime: number | null,
    cursor: number,
    latest: number,
  ): void {
    if (cursor >= latest && latestCloseTime !== null) {
      this.status.lastLedgerCloseTime = latestCloseTime;
    } else if (eventCloseTime !== null) {
      this.status.lastLedgerCloseTime = eventCloseTime;
    } else if (latestCloseTime !== null) {
      this.status.lastLedgerCloseTime = Math.max(0, latestCloseTime - (latest - cursor) * 5);
    }

    if (this.status.lastLedgerCloseTime != null) {
      this.status.freshnessSeconds = Math.max(
        0,
        Math.floor(Date.now() / 1000) - this.status.lastLedgerCloseTime,
      );
    }
  }

  /**
   * Index ledgers [cursor, min(cursor + LEDGER_WINDOW * concurrency, latest)).
   *
   * Up to `INDEXER_FETCH_CONCURRENCY` windows are fetched in parallel, but
   * their events are applied in ledger order and the cursor only advances after
   * a window has been applied. If a fetch fails, windows already applied keep
   * their cursor and the next pass resumes at the failed one. A crash mid-range
   * replays that range on restart; every apply path is idempotent so that is
   * safe.
   */
  async tick(): Promise<TickResult> {
    // Held back by an operator (`POST /admin/indexer/pause`): read nothing and
    // write nothing, so the saved cursor and projection are untouched and the
    // loop resumes exactly where it left off on resume.
    if (this.status.paused) {
      this.publishMetrics(0);
      return { applied: 0, mismatched: 0, cursor: this.status.cursor, latest: this.status.latest };
    }
    const latestRes = await this.server.getLatestLedger();
    const latest = latestRes.sequence;
    const latestCloseTime = parseCloseTime((latestRes as { closeTime?: unknown }).closeTime);
    const start = await this.firstLedger(readCursor(this.db, 0));

    this.status.latest = latest;
    if (start > latest) {
      this.status.cursor = start;
      this.updateFreshness(latestCloseTime, null, start, latest);
      this.publishMetrics(0);
      return { applied: 0, mismatched: 0, cursor: start, latest };
    }

    // endLedger is exclusive. Including `latest` would read a ledger that is
    // still being ingested and could miss part of it.
    const end = Math.min(start + LEDGER_WINDOW, latest);
    if (end <= start) {
      this.status.cursor = start;
      this.updateFreshness(latestCloseTime, null, start, latest);
      this.publishMetrics(0);
      return { applied: 0, mismatched: 0, cursor: start, latest };
    }

    const filters: rpc.Api.EventFilter[] = [
      { type: "contract", contractIds: this.contractIds() },
    ];
    const concurrencySetting =
      "INDEXER_FETCH_CONCURRENCY" in this.config
        ? this.config.INDEXER_FETCH_CONCURRENCY
        : undefined;
    const concurrency = Math.max(1, concurrencySetting ?? 1);
    const windows: Array<{ start: number; end: number }> = [];
    for (let s = start; s < latest && windows.length < concurrency; s += LEDGER_WINDOW) {
      windows.push({ start: s, end: Math.min(s + LEDGER_WINDOW, latest) });
    }

    const fetched = await Promise.allSettled(
      windows.map((w) => this.fetchWindow(w.start, w.end, filters)),
    );
    let applied = 0;
    let mismatched = 0;
    let cursor = start;
    let failure: unknown;
    let lastSeenCloseTime: number | null = null;

    for (let i = 0; i < windows.length; i += 1) {
      const result = fetched[i]!;
      if (result.status === "rejected") {
        failure = result.reason;
        break;
      }
      for (const raw of result.value) {
        const ct = parseCloseTime((raw as { ledgerClosedAt?: unknown }).ledgerClosedAt);
        if (ct !== null) lastSeenCloseTime = ct;
        const decoded = decodeEvent(raw);
        if (!decoded) continue;
        if (this.apply(decoded) !== "mismatched") applied += 1;
        else mismatched += 1;
      }
      // Only advance after this window is applied, so a later failure resumes
      // here instead of replaying what already landed.
      cursor = windows[i]!.end;
      writeCursor(this.db, cursor);
    }

    this.status.cursor = cursor;
    this.updateFreshness(latestCloseTime, lastSeenCloseTime, cursor, latest);
    this.publishMetrics(applied);
    if (failure !== undefined) throw failure;
    return { applied, mismatched, cursor, latest };
  }

  /** Run passes until the cursor reaches the RPC's latest ledger. */
  async catchUp(maxPasses = 1_000): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxPasses; i += 1) {
      const r = await this.tick();
      total += r.applied;
      if (r.cursor >= r.latest) break;
    }
    return total;
  }

  /**
   * Route a decoded event to its projection, but only after it matches the
   * committed contract spec (`src/lib/event_spec.json`).
   *
   * An event that fails validation is logged with every problem and counted
   * in `mismatchedEvents`; it is never projected, so a renamed contract field
   * surfaces immediately instead of silently storing zeros. Events whose name
   * the spec does not cover are left to the switch below, which ignores
   * unknown names.
   */
  apply(e: DecodedEvent): ApplyOutcome {
    const problems = specProblems(e);
    if (problems !== null && problems.length > 0) {
      this.status.mismatchedEvents = this.mismatchedEvents + 1;
      logger.warn(
        {
          name: e.name,
          contractId: e.contractId,
          ledger: e.ledger,
          txHash: e.txHash,
          problems,
        },
        "event does not match the contract spec; not applied",
      );
      return "mismatched";
    }

    switch (e.name) {
      case "plan_created":
        this.onPlanCreated(e);
        return "applied";
      case "plan_status_changed":
        this.onPlanStatus(e);
        return "applied";
      case "subscribed": {
        const [, , merchant] = e.topics;
        this.onSubscribed(e);
        this.recordChurn(e, "started", str(merchant));
        this.events.emit("applied", e);
        return "applied";
      }
      case "charged":
        this.onCharged(e);
        this.events.emit("applied", e);
        return "applied";
      case "cancelled": {
        // The cancel event names the subscriber, not the merchant, so the
        // merchant comes from the mandate row the projection holds.
        const merchant = this.onStatus(e, "Cancelled", "subscriber");
        this.recordChurn(e, "cancelled", merchant);
        this.events.emit("applied", e);
        return "applied";
      }
      case "mandate_ended": {
        // The end event names the merchant in its second topic; the mandate
        // row is the fallback when the projection has not seen it yet.
        const merchant = this.onStatus(e, "Cancelled", "merchant") ?? str(e.topics[1]);
        this.recordChurn(e, "ended", merchant);
        this.events.emit("applied", e);
        return "applied";
      }
      case "mandate_completed": {
        const merchant = this.onStatus(e, "Completed");
        this.recordChurn(e, "completed", merchant);
        return "applied";
      }
      case "pause_changed":
        this.onPauseChanged(e);
        return "applied";
      case "fee_changed":
        this.onFeeChanged(e);
        return "applied";
      case "deposit":
      case "withdraw":
      case "debit":
        this.onVaultEvent(e);
        return "applied";
      default:
        logger.debug({ name: e.name }, "unhandled event");
        return "unknown";
    }
  }

  private onPlanCreated(e: DecodedEvent): void {
    const [merchant, planId] = e.topics;
    this.merchantCache.invalidate(str(merchant));
    this.db
      .prepare(
        `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           merchant = excluded.merchant, name = excluded.name,
           token = excluded.token,
           amount = excluded.amount, period = excluded.period`,
      )
      .run(
        num(planId),
        str(merchant),
        str(e.data.name),
        str(e.data.token),
        big(e.data.amount),
        num(e.data.period),
        e.ledger,
      );
  }

  private onPlanStatus(e: DecodedEvent): void {
    const [, planId] = e.topics;
    this.db
      .prepare("UPDATE plans SET active = ? WHERE id = ?")
      .run(e.data.active ? 1 : 0, num(planId));
  }

  private onSubscribed(e: DecodedEvent): void {
    const [mandateId, subscriber, merchant] = e.topics;
    this.merchantCache.invalidate(str(merchant));
    this.db
      .prepare(
        `INSERT INTO mandates
           (id, subscriber, merchant, plan_id, amount, period, next_charge,
            last_charge, charges_made, max_charges, fee_bps, status, ledger)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'Active', ?)
         ON CONFLICT(id) DO UPDATE SET
           subscriber  = excluded.subscriber,
           merchant    = excluded.merchant,
           max_charges = excluded.max_charges,
           fee_bps     = excluded.fee_bps`,
      )
      .run(
        num(mandateId),
        str(subscriber),
        str(merchant),
        num(e.data.plan_id),
        big(e.data.amount),
        num(e.data.period),
        num(e.data.next_charge),
        num(e.data.max_charges),
        num(e.data.fee_bps),
        e.ledger,
      );
  }

  /**
   * When the charge happened, in unix milliseconds.
   *
   * The ledger's close time is the chain's own clock, so the same charge
   * carries the same timestamp however often it is indexed: a backfill or a
   * restart after a deploy no longer collapses the whole history onto one
   * moment, and a report bucketed by it describes the chain rather than the
   * indexer. The row is written with `INSERT OR IGNORE`, so a replay leaves
   * the stored value untouched.
   *
   * An event that carried no close time has no chain clock to use; the
   * indexer's wall clock is the fallback, and it is logged because it is the
   * one value that is not reproducible.
   */
  private chargedAt(e: DecodedEvent): number {
    const closeTime = e.closeTime;
    if (closeTime === undefined || closeTime === null) {
      logger.warn(
        { txHash: e.txHash, ledger: e.ledger },
        "charge has no ledger close time; stamped with the indexer's clock instead",
      );
      return Date.now();
    }
    return closeTime * 1000;
  }

  private onCharged(e: DecodedEvent): void {
    const [mandateId, subscriber, merchant] = e.topics;
    const id = num(mandateId);
    this.merchantCache.invalidate(str(merchant));

    this.db
      .prepare(
        `INSERT OR IGNORE INTO charges
           (tx_hash, mandate_id, subscriber, merchant, amount, fee,
            charges_made, next_charge, ledger, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.txHash,
        id,
        str(subscriber),
        str(merchant),
        big(e.data.amount),
        big(e.data.fee),
        num(e.data.charges_made),
        num(e.data.next_charge),
        e.ledger,
        this.chargedAt(e),
      );

    // The Charged event carries next_charge but not last_charge. The contract
    // sets next_charge = now + period, so the settlement time is recoverable
    // from the mandate's own period.
    // Guard against out-of-order delivery: never move a mandate backwards.
    this.db
      .prepare(
        `UPDATE mandates
            SET charges_made = ?,
                next_charge  = ?,
                last_charge  = MAX(0, ? - period)
          WHERE id = ? AND charges_made < ?`,
      )
      .run(
        num(e.data.charges_made),
        num(e.data.next_charge),
        num(e.data.next_charge),
        id,
        num(e.data.charges_made),
      );
  }

  /**
   * `endedBy` records which side cancelled; completion leaves it null.
   *
   * Returns the mandate's merchant, which the churn log needs and which only
   * the projection knows for the events that do not name it themselves.
   */
  private onStatus(
    e: DecodedEvent,
    status: string,
    endedBy: string | null = null,
  ): string | undefined {
    const [mandateId] = e.topics;
    const mid = num(mandateId);
    const row = this.db.prepare("SELECT merchant FROM mandates WHERE id = ?").get(mid) as
      | { merchant: string }
      | undefined;
    if (row) this.merchantCache.invalidate(row.merchant);
    this.db
      .prepare("UPDATE mandates SET status = ?, ended_by = ? WHERE id = ?")
      .run(status, endedBy, mid);
    return row?.merchant;
  }

  /**
   * Record a mandate lifecycle event in the churn log.
   *
   * The row is keyed on (mandate_id, slot) and written with INSERT OR IGNORE,
   * so replaying a ledger range leaves the log unchanged. `at` is the
   * ledger's close time, so an event lands in the same bucket however many
   * times it is applied.
   *
   * `slot` is 'start' or 'departure': a mandate has one start and at most one
   * departure, so a mandate that is both started and cancelled contributes to
   * both counts but can never be counted as leaving twice.
   */
  private recordChurn(
    e: DecodedEvent,
    kind: "started" | "cancelled" | "ended" | "completed",
    merchant: string | undefined,
  ): void {
    // Without a merchant there is nobody to attribute the event to, and
    // without a close time there is no bucket to file it under. Either way
    // the projection itself is already written, so the event is skipped
    // rather than guessed at.
    if (!merchant) return;
    const at = e.closeTime;
    if (at === undefined || at === null) return;
    const [mandateId] = e.topics;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO mandate_events (mandate_id, slot, merchant, kind, at, ledger)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        num(mandateId),
        kind === "started" ? "start" : "departure",
        merchant,
        kind,
        at,
        e.ledger,
      );
  }

  private onPauseChanged(e: DecodedEvent): void {
    const [mandateId] = e.topics;
    const mid = num(mandateId);
    const row = this.db.prepare("SELECT merchant FROM mandates WHERE id = ?").get(mid) as
      | { merchant: string }
      | undefined;
    if (row) this.merchantCache.invalidate(row.merchant);
    this.db
      .prepare(
        `UPDATE mandates SET status = ?
          WHERE id = ? AND status IN ('Active','Paused')`,
      )
      .run(e.data.paused ? "Paused" : "Active", mid);
  }

  private onVaultEvent(e: DecodedEvent): void {
    const [user, token, counterparty] = e.topics;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO vault_events
           (tx_hash, kind, user, token, counterparty, amount, balance, ledger)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.txHash,
        e.name,
        str(user),
        str(token),
        counterparty === undefined ? null : str(counterparty),
        big(e.data.amount),
        big(e.data.balance),
        e.ledger,
      );
  }

  private onFeeChanged(e: DecodedEvent): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO fee_history (tx_hash, old_fee_bps, new_fee_bps, ledger)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        e.txHash,
        num(e.data.old_fee_bps),
        num(e.data.new_fee_bps),
        e.ledger,
      );
  }
}
