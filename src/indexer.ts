import { EventEmitter } from "node:events";
import { rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import type { Config, NetworkConfig } from "./config.ts";
import type { Storage } from "./lib/store/types.ts";
import { asStorage } from "./lib/store/index.ts";
import { openDatabase } from "./lib/db.ts";
import { updateActivePlanSubscriber, type ActivePlanSubscriber } from "./lib/plan-subscribers.ts";

export type IndexerConfig = Config | NetworkConfig;
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
import { childLogger } from "./lib/logger.ts";
import { withSpan } from "./lib/telemetry.ts";

const logger = childLogger("indexer");
import { metrics, publishBusinessMetrics, publishIndexerMetrics } from "./lib/metrics.ts";
import { defaultMerchantSummaryCache, MerchantSummaryCache } from "./routes/index.ts";

export { parseCloseTime };

async function insertRows(
  storage: Storage,
  table: string,
  columns: readonly string[],
  rows: Record<string, unknown>[],
): Promise<void> {
  const placeholders = columns.map(() => "?").join(", ");
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
  for (const row of rows) {
    await storage.run(sql, columns.map((column) => row[column]));
  }
}

/**
 * Split a fetched batch into its ledgers, keeping the RPC's ledger order. The
 * indexer writes each ledger's rows together (#247), so this is the unit the
 * projection is applied in.
 */
function groupByLedger(events: readonly rpc.Api.EventResponse[]): rpc.Api.EventResponse[][] {
  const ledgers: rpc.Api.EventResponse[][] = [];
  let current: rpc.Api.EventResponse[] | null = null;
  for (const event of events) {
    if (current === null || current[0]!.ledger !== event.ledger) {
      current = [];
      ledgers.push(current);
    }
    current.push(event);
  }
  return ledgers;
}

/** RPC caps a single getEvents window; stay well inside it. */
const LEDGER_WINDOW_MAX = 8_000;
/** Ledgers per batch when `INDEXER_BATCH_SIZE` is not set. */
const DEFAULT_BATCH_SIZE = LEDGER_WINDOW_MAX;
const PAGE_LIMIT = 200;
/**
 * Raw events retained per statement (#247). One multi-row insert per ledger
 * replaces one round trip per event; the chunk stays far below PostgreSQL's
 * 65,535-parameter ceiling (8 columns a row).
 */
const RETAIN_CHUNK = 200;
/** Ledgers between two `indexer progress` log lines when none is configured. */
const DEFAULT_PROGRESS_LEDGERS = 10_000;

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
   * Last ledger the raw event stream (the `events` table) reaches. The
   * projection's cursor may trail this when raw events have been retained
   * but not yet projected, so the two can be compared.
   */
  eventsLedger?: number;
  /**
   * Ledgers the projection trails the raw event stream by.
   */
  eventsLag?: number;
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
  private directApplyTail: Promise<void> = Promise.resolve();
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
    eventsLedger: 0,
    eventsLag: 0,
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
  /** Re-read the raw event stream's tip from the events table. */
  private async refreshEventsLedger(): Promise<void> {
    try {
      const row = await this.db.get<{ m: number | string | null }>("SELECT MAX(ledger) AS m FROM events");
      const m = Number(row?.m ?? 0);
      this.status.eventsLedger = m;
      this.status.eventsLag = Math.max(0, m - (this.status.cursor ?? 0));
    } catch {
      // keep previous values
    }
  }

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
    archive?: Archive,
  ) {
    this.db = asStorage(db);
    this.server = server;
    this.config = config;
    this.merchantCache = merchantCache;
    this.archive = archive;
    // Publish the starting state, so a scrape sees the series from the first
    // moment and not only once the first pass has run.
    this.ready = this.publishMetrics(0);
    // Nothing else awaits it at construction; mark the rejection handled so it
    // cannot surface as an unhandled rejection. Callers that care (the metrics
    // test, anything that scrapes before the first pass) await `ready`.
    void this.ready.catch(() => undefined);
  }

  /** Resolves when the constructor's first metrics publish has completed. */
  readonly ready: Promise<void>;

  /** The archive used to backfill a gap, if ARCHIVE_URL was configured. */
  private readonly archive: Archive | undefined;

  /**
   * Where the current progress interval started: the cursor, the wall-clock
   * time, and the events applied and mismatched since then. Null until the
   * first pass that reads ledgers.
   */
  private progress: { ledger: number; at: number; applied: number; mismatched: number } | null = null;

  /**
   * Ledgers one batch reads and applies before the cursor moves (#241). Read
   * from the environment config or, for a network configured on its own, from
   * the network. Clamped to the RPC's getEvents window: asking for more than
   * it serves would make every pass fail.
   */
  private get batchSize(): number {
    const setting =
      "INDEXER_BATCH_SIZE" in this.config
        ? this.config.INDEXER_BATCH_SIZE
        : this.config.batchSize;
    return Math.max(1, Math.min(LEDGER_WINDOW_MAX, setting ?? DEFAULT_BATCH_SIZE));
  }

  /** Ledgers between two `indexer progress` log lines; 0 turns them off. */
  private get progressLedgers(): number {
    const setting =
      "INDEXER_PROGRESS_LEDGERS" in this.config
        ? this.config.INDEXER_PROGRESS_LEDGERS
        : this.config.progressLedgers;
    return setting ?? DEFAULT_PROGRESS_LEDGERS;
  }

  /**
   * Log `indexer progress` once the cursor has moved `progressLedgers` past
   * the start of the current interval, then start a new interval at the
   * cursor. One line per interval, however many passes it took, so a long
   * catch-up reports at a steady cadence and a caught-up indexer (a few
   * ledgers per pass) stays quiet. Structured fields only: the network, the
   * cursor and the latest ledger, how far behind it is, the ledgers and
   * events covered since the last line, and the rate.
   */
  private reportProgress(
    start: number,
    startedAt: number,
    cursor: number,
    latest: number,
    applied: number,
    mismatched: number,
  ): void {
    const every = this.progressLedgers;
    if (every <= 0) return;
    const now = Date.now();
    // A cursor that moved backwards (a reindex rewound it) starts afresh. A
    // new interval starts when this pass did, so its rate covers the pass.
    if (this.progress === null || start < this.progress.ledger) {
      this.progress = { ledger: start, at: startedAt, applied: 0, mismatched: 0 };
    }
    this.progress.applied += applied;
    this.progress.mismatched += mismatched;
    const ledgers = cursor - this.progress.ledger;
    if (ledgers < every) return;
    const seconds = Math.max(0.001, (now - this.progress.at) / 1000);
    logger.info(
      {
        network: this.networkLabel,
        cursor,
        latest,
        behind: Math.max(0, latest - cursor),
        ledgers,
        events: this.progress.applied,
        mismatched: this.progress.mismatched,
        ledgersPerSecond: Math.round(ledgers / seconds),
      },
      "indexer progress",
    );
    this.progress = { ledger: cursor, at: now, applied: 0, mismatched: 0 };
  }

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
  private async publishMetrics(applied: number): Promise<void> {
    const network = this.networkLabel;
    publishIndexerMetrics(this.status, network);
    // The business gauges come from the projection this pass just wrote (or
    // left untouched), so they are re-read here: after each pass the series
    // describe the current mandate base, merchant base and MRR. The read is
    // one indexed statement and logs-and-continues on failure, so it cannot
    // crash the loop.
    await publishBusinessMetrics(this.db, network);
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
        await this.retain(raw);
        const decoded = decodeEvent(raw);
        if (!decoded) continue;
        if ((await this.apply(decoded)) !== "mismatched") applied += 1;
      }
      if (pastEnd || (page.events ?? []).length === 0 || !page.cursor) break;
      cursor = page.cursor;
    }
    // Only advance after the whole gap is applied, so a retry replays it
    // safely: every apply path is idempotent.
    await this.db.run(
      `INSERT INTO cursor (id, last_ledger) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger`,
      [end],
    );
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
   * Index ledgers [cursor, min(cursor + batchSize * concurrency, latest)).
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
   * Index ledgers [cursor, min(cursor + batchSize * concurrency, latest)).
   *
   * Up to `INDEXER_FETCH_CONCURRENCY` batches are fetched in parallel, but
   * their events are applied in ledger order and the cursor only advances after
   * a batch has been applied. If a fetch fails, batches already applied keep
   * their cursor and the next pass resumes at the failed one. A crash mid-range
   * replays that range on restart; every apply path is idempotent so that is
   * safe.
   */
  async tick(): Promise<TickResult> {
    return withSpan("indexer.tick", () => this.tickInner());
  }

  private async tickInner(): Promise<TickResult> {
    // Held back by an operator (`POST /admin/indexer/pause`): read nothing and
    // write nothing, so the saved cursor and projection are untouched and the
    // loop resumes exactly where it left off on resume.
    if (this.status.paused) {
      await this.refreshEventsLedger();
      await this.publishMetrics(0);
      return { applied: 0, mismatched: 0, cursor: this.status.cursor, latest: this.status.latest };
    }
    const startedAt = Date.now();
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
      await this.refreshEventsLedger();
      await this.publishMetrics(0);
      return { applied: 0, mismatched: 0, cursor: start, latest };
    }

    // endLedger is exclusive. Including `latest` would read a ledger that is
    // still being ingested and could miss part of it.
    const batchSize = this.batchSize;
    const end = Math.min(start + batchSize, latest);
    if (end <= start) {
      this.status.cursor = start;
      this.updateFreshness(latestCloseTime, null, start, latest);
      await this.refreshEventsLedger();
      await this.publishMetrics(0);
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
    for (let s = start; s < latest && windows.length < concurrency; s += batchSize) {
      windows.push({ start: s, end: Math.min(s + batchSize, latest) });
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
      // Every write for this batch — the raw events, every projection row and
      // the cursor — lands in one transaction, so the pass pays one commit and
      // a failure anywhere rolls the whole batch back (#247). Ledger by ledger
      // inside it, so a ledger's rows are written together and its raw events
      // are retained in one statement instead of one round trip each.
      const windowResult = await this.db.transaction(async (storage) => {
        let windowApplied = 0;
        let windowMismatched = 0;
        const notifications: DecodedEvent[] = [];
        for (const ledgerEvents of groupByLedger(result.value)) {
          await this.retainAll(ledgerEvents, storage);
          for (const raw of ledgerEvents) {
            const ct = parseCloseTime((raw as { ledgerClosedAt?: unknown }).ledgerClosedAt);
            if (ct !== null) lastSeenCloseTime = ct;
            const decoded = decodeEvent(raw);
            if (!decoded) continue;
            if ((await this.apply(decoded, storage, notifications)) !== "mismatched") windowApplied += 1;
            else windowMismatched += 1;
          }
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
    await this.refreshEventsLedger();
    // Windows applied before a failed fetch are real progress, so they count.
    this.reportProgress(start, startedAt, cursor, latest, applied, mismatched);
    await this.publishMetrics(applied);
    if (failure !== undefined) throw failure;
    return { applied, mismatched, cursor, latest };
  }


  /** Preserve every event before decoding, including unknown contract events. */
  private async retain(raw: rpc.Api.EventResponse, storage: Storage = this.db): Promise<void> {
    await this.retainAll([raw], storage);
  }

  /**
   * Retain one ledger's raw events in as few statements as possible: one
   * multi-row `INSERT OR IGNORE` per chunk instead of one statement per event
   * (#247). The row is unchanged — same event id, same XDR payload — and
   * `INSERT OR IGNORE` keeps a replay idempotent, whichever chunk a repeated
   * event lands in.
   */
  private async retainAll(
    events: readonly rpc.Api.EventResponse[],
    storage: Storage = this.db,
  ): Promise<void> {
    for (let i = 0; i < events.length; i += RETAIN_CHUNK) {
      const chunk = events.slice(i, i + RETAIN_CHUNK);
      const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const parameters = chunk.flatMap((raw) => {
        const topics = raw.topic.map((topic) => topic.toXDR("base64"));
        return [
          raw.id ?? `${raw.ledger}:${raw.txHash}:${topics.join(":")}:${raw.value.toXDR("base64")}`,
          raw.contractId?.toString() ?? "",
          raw.ledger,
          raw.txHash,
          raw.id ?? "",
          JSON.stringify(topics),
          raw.value.toXDR("base64"),
          parseCloseTime((raw as { ledgerClosedAt?: unknown }).ledgerClosedAt),
        ];
      });
      await storage.run(
        `INSERT OR IGNORE INTO events
           (event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time)
         VALUES ${values}`,
        parameters,
      );
    }
  }

  /** Rebuild event-derived projections locally, without querying RPC. */
  async rebuildProjections(): Promise<number> {
    const rows = await this.db.all<{
      contract_id: string;
      ledger: number;
      tx_hash: string;
      topics: string;
      data: string;
      close_time: number | null;
    }>(
      "SELECT contract_id, ledger, tx_hash, topics, data, close_time FROM events ORDER BY ledger, event_id",
    );
    return this.db.transaction(async (storage) => {
      for (const table of [
        "plans",
        "plan_subscriber_counts",
        "plan_active_subscribers",
        "mandates",
        "charges",
        "vault_events",
        "fee_history",
        "mandate_events",
        "mandate_timeline",
        "contract_upgrades",
        "merchant_profiles",
      ]) {
        await storage.run(`DELETE FROM ${table}`);
      }
      let applied = 0;
      for (const row of rows) {
        const raw = {
          contractId: row.contract_id,
          ledger: row.ledger,
          txHash: row.tx_hash,
          topic: (JSON.parse(row.topics) as string[]).map((topic) => xdr.ScVal.fromXDR(topic, "base64")),
          value: xdr.ScVal.fromXDR(row.data, "base64"),
          ledgerClosedAt: row.close_time === null ? undefined : new Date(row.close_time * 1000).toISOString(),
        } as unknown as rpc.Api.EventResponse;
        const decoded = decodeEvent(raw);
        if (decoded && (await this.apply(decoded, storage)) === "applied") applied += 1;
      }
      return applied;
    });
  }

  /**
   * Rebuild one merchant's projection from retained raw events without
   * changing other merchants or operational tables.
   */
  async rebuildMerchantProjections(merchant: string): Promise<number> {
    if (!StrKey.isValidEd25519PublicKey(merchant)) {
      throw new Error("merchant must be a valid Stellar account address");
    }

    const rawEvents = await this.db.all<{
      event_id: string;
      contract_id: string;
      ledger: number;
      tx_hash: string;
      event_index: string;
      topics: string;
      data: string;
      close_time: number | null;
    }>(
      `SELECT event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time
       FROM events ORDER BY ledger, event_id`,
    );
    const scratchDb = openDatabase(":memory:");
    const scratchStorage = asStorage(scratchDb);

    try {
      await scratchStorage.transaction(async (storage) => {
        for (const event of rawEvents) {
          await storage.run(
            `INSERT INTO events
               (event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              event.event_id,
              event.contract_id,
              event.ledger,
              event.tx_hash,
              event.event_index,
              event.topics,
              event.data,
              event.close_time,
            ],
          );
        }
      });

      const scratchIndexer = new Indexer(
        scratchDb,
        this.server,
        this.config,
        new MerchantSummaryCache(),
      );
      const applied = await scratchIndexer.rebuildProjections();
      await this.replaceMerchantProjection(scratchIndexer.db, merchant);
      await this.merchantCache.invalidate(merchant);
      return applied;
    } finally {
      scratchDb.close();
    }
  }

  private async replaceMerchantProjection(source: Storage, merchant: string): Promise<void> {
    const plans = await source.all<Record<string, unknown>>(
      "SELECT id, merchant, name, token, amount, period, active, ledger FROM plans WHERE merchant = ?",
      [merchant],
    );
    const mandates = await source.all<Record<string, unknown>>(
      `SELECT id, subscriber, merchant, plan_id, amount, period, next_charge, last_charge,
              charges_made, max_charges, fee_bps, status, ended_by, ledger
       FROM mandates WHERE merchant = ?`,
      [merchant],
    );
    const charges = await source.all<Record<string, unknown>>(
      `SELECT tx_hash, mandate_id, subscriber, merchant, amount, fee, charges_made,
              next_charge, ledger, created_at
       FROM charges WHERE merchant = ?`,
      [merchant],
    );
    const mandateEvents = await source.all<Record<string, unknown>>(
      "SELECT mandate_id, slot, merchant, kind, at, ledger FROM mandate_events WHERE merchant = ?",
      [merchant],
    );
    const profile = await source.all<Record<string, unknown>>(
      "SELECT merchant, name, url, ledger FROM merchant_profiles WHERE merchant = ?",
      [merchant],
    );

    const planIds = plans.map((row) => row.id);
    const planMemberships: Record<string, unknown>[] = [];
    const planCounts: Record<string, unknown>[] = [];
    for (const planId of planIds) {
      planMemberships.push(
        ...(await source.all<Record<string, unknown>>(
          "SELECT plan_id, subscriber, mandate_count FROM plan_active_subscribers WHERE plan_id = ?",
          [planId],
        )),
      );
      planCounts.push(
        ...(await source.all<Record<string, unknown>>(
          "SELECT plan_id, active_subscribers FROM plan_subscriber_counts WHERE plan_id = ?",
          [planId],
        )),
      );
    }

    const mandateIds = mandates.map((row) => row.id);
    const mandateTimeline: Record<string, unknown>[] = [];
    for (const mandateId of mandateIds) {
      mandateTimeline.push(
        ...(await source.all<Record<string, unknown>>(
          "SELECT mandate_id, tx_hash, kind, ledger, at, details FROM mandate_timeline WHERE mandate_id = ?",
          [mandateId],
        )),
      );
    }

    const columns = {
      plans: ["id", "merchant", "name", "token", "amount", "period", "active", "ledger"],
      mandates: [
        "id", "subscriber", "merchant", "plan_id", "amount", "period", "next_charge",
        "last_charge", "charges_made", "max_charges", "fee_bps", "status", "ended_by", "ledger",
      ],
      plan_active_subscribers: ["plan_id", "subscriber", "mandate_count"],
      plan_subscriber_counts: ["plan_id", "active_subscribers"],
      charges: [
        "tx_hash", "mandate_id", "subscriber", "merchant", "amount", "fee",
        "charges_made", "next_charge", "ledger", "created_at",
      ],
      mandate_events: ["mandate_id", "slot", "merchant", "kind", "at", "ledger"],
      mandate_timeline: ["mandate_id", "tx_hash", "kind", "ledger", "at", "details"],
      merchant_profiles: ["merchant", "name", "url", "ledger"],
    } satisfies Record<string, string[]>;

    await this.db.transaction(async (storage) => {
      const previousPlans = await storage.all<{ id: unknown }>(
        "SELECT id FROM plans WHERE merchant = ?",
        [merchant],
      );
      const previousMandates = await storage.all<{ id: unknown }>(
        "SELECT id FROM mandates WHERE merchant = ?",
        [merchant],
      );
      const planIdsToReplace = new Set([...previousPlans.map((row) => row.id), ...planIds]);
      const mandateIdsToReplace = new Set([...previousMandates.map((row) => row.id), ...mandateIds]);

      for (const planId of planIdsToReplace) {
        await storage.run("DELETE FROM plan_active_subscribers WHERE plan_id = ?", [planId]);
        await storage.run("DELETE FROM plan_subscriber_counts WHERE plan_id = ?", [planId]);
      }
      for (const mandateId of mandateIdsToReplace) {
        await storage.run("DELETE FROM mandate_timeline WHERE mandate_id = ?", [mandateId]);
      }
      await storage.run("DELETE FROM plans WHERE merchant = ?", [merchant]);
      await storage.run("DELETE FROM mandates WHERE merchant = ?", [merchant]);
      await storage.run("DELETE FROM charges WHERE merchant = ?", [merchant]);
      await storage.run("DELETE FROM mandate_events WHERE merchant = ?", [merchant]);
      await storage.run("DELETE FROM merchant_profiles WHERE merchant = ?", [merchant]);

      await insertRows(storage, "plans", columns.plans, plans);
      await insertRows(storage, "mandates", columns.mandates, mandates);
      await insertRows(storage, "plan_active_subscribers", columns.plan_active_subscribers, planMemberships);
      await insertRows(storage, "plan_subscriber_counts", columns.plan_subscriber_counts, planCounts);
      await insertRows(storage, "charges", columns.charges, charges);
      await insertRows(storage, "mandate_events", columns.mandate_events, mandateEvents);
      await insertRows(storage, "mandate_timeline", columns.mandate_timeline, mandateTimeline);
      await insertRows(storage, "merchant_profiles", columns.merchant_profiles, profile);
    });
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
    if (storage !== this.db) return this.applyNow(e, storage, notifications);

    const previous = this.directApplyTail;
    let release!: () => void;
    this.directApplyTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.applyNow(e, storage, notifications);
    } finally {
      release();
    }
  }

  private async applyNow(
    e: DecodedEvent,
    storage: Storage,
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
        await this.recordTimeline(e, storage);
        return "applied";
      case "profile_updated":
        await this.onProfileUpdated(e, storage);
        return "applied";
      case "charged":
        await this.onCharged(e, storage);
        this.notify(e, notifications);
        await this.recordTimeline(e, storage);
        return "applied";
      case "cancelled":
        {
          const merchant = await this.onStatus(e, "Cancelled", "subscriber", storage);
          await this.recordChurn(e, "cancelled", merchant, storage);
          this.notify(e, notifications);
          await this.recordTimeline(e, storage);
          return "applied";
        }
      case "mandate_ended": {
        const merchant = await this.onStatus(e, "Cancelled", "merchant", storage) ?? str(e.topics[1]);
        await this.recordChurn(e, "ended", merchant, storage);
        await this.recordTimeline(e, storage);
        this.notify(e, notifications);
        return "applied";
      }
      case "mandate_completed": {
        const merchant = await this.onStatus(e, "Completed", null, storage);
        await this.recordChurn(e, "completed", merchant, storage);
        this.notify(e, notifications);
        await this.recordTimeline(e, storage);
        return "applied";
      }
      case "pause_changed":
        await this.onPauseChanged(e, storage);
        await this.recordTimeline(e, storage);
        return "applied";
      case "fee_changed":
        await this.onFeeChanged(e, storage);
        return "applied";
      case "deposit":
      case "withdraw":
      case "debit":
        await this.onVaultEvent(e, storage);
        return "applied";
      case "upgraded": {
        // Emitted by a contract's admin-gated upgrade with the new wasm hash.
        const raw = e.data.new_wasm_hash;
        const hash =
          raw instanceof Uint8Array ? Buffer.from(raw).toString("hex") : typeof raw === "string" ? raw : "";
        if (!hash) return "unknown";
        await this.recordContractUpgrade(e.contractId, e.txHash, e.ledger, e.closeTime ?? null, hash, storage);
        return "applied";
      }
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
    await this.merchantCache.invalidate(str(merchant));
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

  /**
   * Append each on-chain lifecycle event without altering the existing churn
   * aggregation table. A tx can emit different kinds for the same mandate;
   * (mandate_id, tx_hash, kind) makes crash replays idempotent.
   */
  private async recordTimeline(e: DecodedEvent, storage: Storage): Promise<void> {
    const mandateId = num(e.topics[0]);
    const details: Record<string, string | boolean> = {};
    if (e.name === "pause_changed") {
      details.paused = e.data.paused === true;
    } else if (e.name === "charged") {
      details.amount = big(e.data.amount);
      details.fee = big(e.data.fee);
      details.chargesMade = String(e.data.charges_made);
    }
    await storage.run(
      "INSERT OR IGNORE INTO mandate_timeline (mandate_id, tx_hash, kind, ledger, at, details) VALUES (?, ?, ?, ?, ?, ?)",
      [mandateId, e.txHash, e.name, e.ledger, e.closeTime ?? null, JSON.stringify(details)],
    );
  }

  private async onPlanStatus(e: DecodedEvent, storage: Storage): Promise<void> {
    const [, planId] = e.topics;
    await storage.run("UPDATE plans SET active = ? WHERE id = ?", [e.data.active ? 1 : 0, num(planId)]);
  }

  /** Update a merchant's profile without letting a replay roll it backwards. */
  private async onProfileUpdated(e: DecodedEvent, storage: Storage): Promise<void> {
    const [merchant] = e.topics;
    await storage.run(
      `INSERT INTO merchant_profiles (merchant, name, url, ledger)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(merchant) DO UPDATE SET
         name = excluded.name, url = excluded.url, ledger = excluded.ledger
       WHERE excluded.ledger >= merchant_profiles.ledger`,
      [str(merchant), str(e.data.name), str(e.data.url), e.ledger],
    );
  }

  private async onSubscribed(e: DecodedEvent, storage: Storage): Promise<void> {
    const [mandateId, subscriber, merchant] = e.topics;
    const id = num(mandateId);
    const previous = await storage.get<ActivePlanSubscriber>(
      "SELECT plan_id, subscriber, status FROM mandates WHERE id = ?",
      [id],
    );
    await this.merchantCache.invalidate(str(merchant));
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
        id,
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
    await updateActivePlanSubscriber(storage, previous, {
      plan_id: previous?.plan_id ?? num(e.data.plan_id),
      subscriber: str(subscriber),
      status: previous?.status ?? "Active",
    });
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
    await this.merchantCache.invalidate(str(merchant));

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
    const row = await storage.get<ActivePlanSubscriber & { merchant: string }>(
      "SELECT merchant, plan_id, subscriber, status FROM mandates WHERE id = ?",
      [mid],
    );
    if (row) await this.merchantCache.invalidate(row.merchant);
    const changed = row && await storage.get<{ id: number }>(
      "UPDATE mandates SET status = ?, ended_by = ? WHERE id = ? AND status = ? RETURNING id",
      [status, endedBy, mid, row.status],
    );
    if (row && changed) await updateActivePlanSubscriber(storage, row, { ...row, status });
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
    const row = await storage.get<ActivePlanSubscriber & { merchant: string }>(
      "SELECT merchant, plan_id, subscriber, status FROM mandates WHERE id = ?",
      [mid],
    );
    if (row) await this.merchantCache.invalidate(row.merchant);
    const desiredStatus = e.data.paused ? "Paused" : "Active";
    const changed = row && (row.status === "Active" || row.status === "Paused") && await storage.get<{ id: number }>(
      `UPDATE mandates SET status = ?
          WHERE id = ? AND status = ? RETURNING id`,
      [desiredStatus, mid, row.status],
    );
    if (row && changed) {
      await updateActivePlanSubscriber(storage, row, {
        ...row,
        status: desiredStatus,
      });
    }
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

  /**
   * Record a contract upgrade when detected through contract events.
   * This tracks when a contract's code is upgraded with metadata about the change.
   */
  private async recordContractUpgrade(
    contractId: string,
    txHash: string,
    ledger: number,
    closeTime: number | null,
    newHash: string,
    storage: Storage,
    oldHash?: string,
  ): Promise<void> {
    if (!closeTime) return;
    await storage.run(
      `INSERT OR IGNORE INTO contract_upgrades
         (contract_id, tx_hash, ledger, close_time, new_hash, old_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contractId, txHash, ledger, closeTime, newHash, oldHash ?? null],
    );
  }
}
