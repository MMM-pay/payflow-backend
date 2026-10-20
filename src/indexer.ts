import { EventEmitter } from "node:events";
import { rpc } from "@stellar/stellar-sdk";
import type { Config, NetworkConfig } from "./config.ts";

export type IndexerConfig = Config | NetworkConfig;
import type { Storage } from "./lib/store/types.ts";
import { asStorage } from "./lib/store/index.ts";
import {
  big,
  decodeEvent,
  num,
  parseCloseTime,
  specProblems,
  str,
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
  private readonly db: Storage;
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
    db: Storage | import("node:sqlite").DatabaseSync,
    server: IndexerRpc,
    config: IndexerConfig,
    merchantCache: MerchantSummaryCache = defaultMerchantSummaryCache,
  ) {
    this.db = asStorage(db);
    this.server = server;
    this.config = config;
    this.merchantCache = merchantCache;
    // Publish the starting state, so a scrape sees the series from the first
    // moment and not only once the first pass has run.
    this.publishMetrics(0);
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
  private async firstLedger(saved: number): Promise<number> {
    const health = await this.server.getHealth();
    const oldest = health.oldestLedger;
    const startSetting = "startLedger" in this.config ? this.config.startLedger : this.config.INDEXER_START_LEDGER;
    const wanted = saved > 0 ? saved : startSetting;
    if (wanted > 0 && wanted >= oldest) return wanted;
    if (wanted > 0) {
      logger.warn(
        { wanted, oldest },
        "start ledger is older than the RPC retention window; events before it are lost",
      );
    }
    return oldest;
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
    const savedCursor = await this.db.get<{ last_ledger: number }>(
      "SELECT last_ledger FROM cursor WHERE id = 1",
    );
    const start = await this.firstLedger(savedCursor?.last_ledger ?? 0);

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
      const nextCursor = windows[i]!.end;
      const windowResult = await this.db.transaction(async (storage) => {
        let windowApplied = 0;
        let windowMismatched = 0;
        const notifications: DecodedEvent[] = [];
        for (const raw of result.value) {
          const ct = parseCloseTime((raw as { ledgerClosedAt?: unknown }).ledgerClosedAt);
          if (ct !== null) lastSeenCloseTime = ct;
          const decoded = decodeEvent(raw);
          if (!decoded) continue;
          if ((await this.apply(decoded, storage, notifications)) !== "mismatched") windowApplied += 1;
          else windowMismatched += 1;
        }
        await storage.run(
          `INSERT INTO cursor (id, last_ledger) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger`,
          [nextCursor],
        );
        return { applied: windowApplied, mismatched: windowMismatched, notifications };
      });
      applied += windowResult.applied;
      mismatched += windowResult.mismatched;
      cursor = nextCursor;
      for (const notification of windowResult.notifications) {
        this.events.emit("applied", notification);
      }
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
  async apply(
    e: DecodedEvent,
    storage: Storage = this.db,
    notifications?: DecodedEvent[],
  ): Promise<ApplyOutcome> {
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
        await this.onPlanCreated(e, storage);
        return "applied";
      case "plan_status_changed":
        await this.onPlanStatus(e, storage);
        return "applied";
      case "subscribed":
        await this.onSubscribed(e, storage);
        await this.recordChurn(e, "started", str(e.topics[2]), storage);
        this.notify(e, notifications);
        return "applied";
      case "charged":
        await this.onCharged(e, storage);
        this.notify(e, notifications);
        return "applied";
      case "cancelled":
        {
          const merchant = await this.onStatus(e, "Cancelled", "subscriber", storage);
          await this.recordChurn(e, "cancelled", merchant, storage);
          this.notify(e, notifications);
          return "applied";
        }
      case "mandate_ended": {
        const merchant = await this.onStatus(e, "Cancelled", "merchant", storage) ?? str(e.topics[1]);
        await this.recordChurn(e, "ended", merchant, storage);
        this.events.emit("applied", e);
        return "applied";
      }
      case "mandate_completed": {
        const merchant = await this.onStatus(e, "Completed", null, storage);
        await this.recordChurn(e, "completed", merchant, storage);
        this.notify(e, notifications);
        return "applied";
      }
      case "pause_changed":
        await this.onPauseChanged(e, storage);
        return "applied";
      case "fee_changed":
        await this.onFeeChanged(e, storage);
        return "applied";
      case "deposit":
      case "withdraw":
      case "debit":
        await this.onVaultEvent(e, storage);
        return "applied";
      default:
        logger.debug({ name: e.name }, "unhandled event");
        return "unknown";
    }
  }

  private notify(event: DecodedEvent, notifications?: DecodedEvent[]): void {
    if (notifications) notifications.push(event);
    else this.events.emit("applied", event);
  }

  private async onPlanCreated(e: DecodedEvent, storage: Storage): Promise<void> {
    const [merchant, planId] = e.topics;
    this.merchantCache.invalidate(str(merchant));
    await storage.run(
      `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           merchant = excluded.merchant, name = excluded.name,
           token = excluded.token,
           amount = excluded.amount, period = excluded.period`,
      [
        num(planId),
        str(merchant),
        str(e.data.name),
        str(e.data.token),
        big(e.data.amount),
        num(e.data.period),
        e.ledger,
      ],
    );
  }

  private async onPlanStatus(e: DecodedEvent, storage: Storage): Promise<void> {
    const [, planId] = e.topics;
    await storage.run("UPDATE plans SET active = ? WHERE id = ?", [e.data.active ? 1 : 0, num(planId)]);
  }

  private async onSubscribed(e: DecodedEvent, storage: Storage): Promise<void> {
    const [mandateId, subscriber, merchant] = e.topics;
    this.merchantCache.invalidate(str(merchant));
    await storage.run(
      `INSERT INTO mandates
           (id, subscriber, merchant, plan_id, amount, period, next_charge,
            last_charge, charges_made, max_charges, fee_bps, status, ledger)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'Active', ?)
         ON CONFLICT(id) DO UPDATE SET
           subscriber  = excluded.subscriber,
           merchant    = excluded.merchant,
           max_charges = excluded.max_charges,
           fee_bps     = excluded.fee_bps`,
      [
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
      ],
    );
  }

  /** The ledger close time is stable across replays; wall time is only a fallback. */
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

  private async onCharged(e: DecodedEvent, storage: Storage): Promise<void> {
    const [mandateId, subscriber, merchant] = e.topics;
    const id = num(mandateId);
    this.merchantCache.invalidate(str(merchant));

    await storage.run(
      `INSERT INTO charges
           (tx_hash, mandate_id, subscriber, merchant, amount, fee,
            charges_made, next_charge, ledger, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tx_hash, mandate_id) DO NOTHING`,
      [
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
      ],
    );

    // The Charged event carries next_charge but not last_charge. The contract
    // sets next_charge = now + period, so the settlement time is recoverable
    // from the mandate's own period.
    // Guard against out-of-order delivery: never move a mandate backwards.
    await storage.run(
      `UPDATE mandates
            SET charges_made = ?,
                next_charge  = ?,
                last_charge  = MAX(0, ? - period)
          WHERE id = ? AND charges_made < ?`,
      [
        num(e.data.charges_made),
        num(e.data.next_charge),
        num(e.data.next_charge),
        id,
        num(e.data.charges_made),
      ],
    );
  }

  /** `endedBy` records which side cancelled; completion leaves it null. */
  private async onStatus(
    e: DecodedEvent,
    status: string,
    endedBy: string | null,
    storage: Storage,
  ): Promise<string | undefined> {
    const [mandateId] = e.topics;
    const mid = num(mandateId);
    const row = await storage.get<{ merchant: string }>(
      "SELECT merchant FROM mandates WHERE id = ?",
      [mid],
    );
    if (row) this.merchantCache.invalidate(row.merchant);
    await storage.run("UPDATE mandates SET status = ?, ended_by = ? WHERE id = ?", [status, endedBy, mid]);
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
  private async recordChurn(
    e: DecodedEvent,
    kind: "started" | "cancelled" | "ended" | "completed",
    merchant: string | undefined,
    storage: Storage,
  ): Promise<void> {
    // Without a merchant there is nobody to attribute the event to, and
    // without a close time there is no bucket to file it under. Either way
    // the projection itself is already written, so the event is skipped
    // rather than guessed at.
    if (!merchant) return;
    const at = e.closeTime;
    if (at === undefined || at === null) return;
    const [mandateId] = e.topics;
    await storage.run(
      `INSERT OR IGNORE INTO mandate_events (mandate_id, slot, merchant, kind, at, ledger)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        num(mandateId),
        kind === "started" ? "start" : "departure",
        merchant,
        kind,
        at,
        e.ledger,
      ],
    );
  }

  private async onPauseChanged(e: DecodedEvent, storage: Storage): Promise<void> {
    const [mandateId] = e.topics;
    const mid = num(mandateId);
    const row = await storage.get<{ merchant: string }>(
      "SELECT merchant FROM mandates WHERE id = ?",
      [mid],
    );
    if (row) this.merchantCache.invalidate(row.merchant);
    await storage.run(
      `UPDATE mandates SET status = ?
          WHERE id = ? AND status IN ('Active','Paused')`,
      [e.data.paused ? "Paused" : "Active", mid],
    );
  }

  private async onVaultEvent(e: DecodedEvent, storage: Storage): Promise<void> {
    const [user, token, counterparty] = e.topics;
    await storage.run(
      `INSERT INTO vault_events
           (tx_hash, kind, "user", token, counterparty, amount, balance, ledger)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tx_hash, kind, "user", amount) DO NOTHING`,
      [
        e.txHash,
        e.name,
        str(user),
        str(token),
        counterparty === undefined ? null : str(counterparty),
        big(e.data.amount),
        big(e.data.balance),
        e.ledger,
      ],
    );
  }

  private async onFeeChanged(e: DecodedEvent, storage: Storage): Promise<void> {
    await storage.run(
      `INSERT INTO fee_history (tx_hash, old_fee_bps, new_fee_bps, ledger)
         VALUES (?, ?, ?, ?) ON CONFLICT (tx_hash) DO NOTHING`,
      [
        e.txHash,
        num(e.data.old_fee_bps),
        num(e.data.new_fee_bps),
        e.ledger,
      ],
    );
  }
}
