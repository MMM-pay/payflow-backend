/**
 * Prometheus metrics.
 *
 * `/health` is a snapshot: it says whether the indexer is behind right now.
 * An operator wants history as well — was the indexer behind all afternoon,
 * did the keeper settle anything in the last hour — so the service also
 * exports counters and gauges in the Prometheus text format.
 *
 * The registry is deliberately tiny and dependency-free. The exposition
 * format is a handful of lines per metric, so a small writer is cheaper than
 * a library and keeps the dependency list (and the audit surface) as it is.
 *
 * Two rules hold here, as everywhere else in the service:
 *
 * - The endpoint is opt-in (`METRICS_ENABLED=true`): the counters are always
 *   kept up to date, but nothing is served until an operator asks for it.
 * - An amount is never a number. Counters and count gauges are plain numbers,
 *   but money — the MRR gauge — is carried as the decimal string the
 *   projection computed and rendered verbatim: a JavaScript number would
 *   silently round any figure above 2^53, and Prometheus prints a gauge's
 *   value as text anyway.
 */

import type { Storage } from "./store/types.ts";
import { SECONDS_PER_MONTH } from "../routes/helpers.ts";
import { logger } from "./logger.ts";

/** Prometheus metric types this service uses. */
export type MetricType = "counter" | "gauge";

/** Labels attached to a sample, e.g. `{ network: "testnet" }`. */
export type MetricLabels = Record<string, string>;

/**
 * One exported metric.
 *
 * `key` is the name the code uses (`metrics.set("indexer_cursor", ...)`);
 * `name` is the name Prometheus sees (`payflow_indexer_cursor`). Keeping the
 * two apart means the exported names can follow the Prometheus conventions
 * (a counter ends in `_total`) without leaking into the call sites.
 */
export interface MetricDefinition {
  key: string;
  name: string;
  help: string;
  type: MetricType;
}

/**
 * The metrics this service exports.
 *
 * The names are prefixed with `payflow_` so a scrape of a shared Prometheus
 * can tell them apart from another service's.
 */
export const METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    key: "indexer_cursor",
    name: "payflow_indexer_cursor",
    help: "Ledger up to which the indexer has projected events.",
    type: "gauge",
  },
  {
    key: "indexer_latest_ledger",
    name: "payflow_indexer_latest_ledger",
    help: "Latest ledger the RPC node reported.",
    type: "gauge",
  },
  {
    key: "indexer_lag",
    name: "payflow_indexer_lag",
    help: "Ledgers the projection trails the network by.",
    type: "gauge",
  },
  {
    key: "active_mandates",
    name: "payflow_active_mandates",
    help: "Mandates whose status is active in the projection.",
    type: "gauge",
  },
  {
    key: "active_merchants",
    name: "payflow_active_merchants",
    help: "Merchants with at least one active mandate in the projection.",
    type: "gauge",
  },
  {
    key: "mrr",
    name: "payflow_mrr",
    help: "Monthly recurring revenue of the active mandates, normalised to a 30-day month, in the token's smallest unit.",
    type: "gauge",
  },
  {
    key: "events_applied",
    name: "payflow_events_applied_total",
    help: "Contract events applied to the projection since the process started.",
    type: "counter",
  },
  {
    key: "charges_settled",
    name: "payflow_charges_settled_total",
    help: "Charges the keeper settled on-chain since the process started.",
    type: "counter",
  },
  {
    key: "charges_failed",
    name: "payflow_charges_failed_total",
    help: "Charges the keeper could not settle since the process started.",
    type: "counter",
  },
  {
    key: "keeper_passes",
    name: "payflow_keeper_passes_total",
    help: "Keeper passes run since the process started.",
    type: "counter",
  },
];

/**
 * A sample's value: a plain count, or — for a gauge that carries money —
 * the amount's decimal string, kept as the projection computed it so not a
 * single digit is lost to floating-point rounding.
 */
type SampleValue = number | string;

interface Sample {
  definition: MetricDefinition;
  labels: MetricLabels;
  value: SampleValue;
}

/** Escape a label value for the exposition format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Escape a HELP text: a backslash and a line break are the only specials. */
function escapeHelp(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Render a sample's labels, sorted by name so the output is stable. */
function renderLabels(labels: MetricLabels): string {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return "";
  const parts = names.map((name) => `${name}="${escapeLabelValue(labels[name] ?? "")}"`);
  return `{${parts.join(",")}}`;
}

/** A metric's identity: its definition and its label set. */
function sampleKey(definition: MetricDefinition, labels: MetricLabels): string {
  const names = Object.keys(labels).sort();
  const rendered = names.map((name) => `${name}=${labels[name] ?? ""}`).join(",");
  return `${definition.name}|${rendered}`;
}

/**
 * A registry of counters and gauges.
 *
 * Counters only go up; gauges are set. There is no reset: the process's
 * lifetime is the window, and a restart is a new series in Prometheus, which
 * is what an operator wants to see anyway.
 */
export class MetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly samples = new Map<string, Sample>();

  constructor(definitions: MetricDefinition[] = METRIC_DEFINITIONS) {
    for (const definition of definitions) {
      this.definitions.set(definition.key, definition);
    }
  }

  /** The definition behind a key, or undefined when the key is unknown. */
  definition(key: string): MetricDefinition | undefined {
    return this.definitions.get(key);
  }

  /** Add to a counter. A negative delta is ignored: counters never go down. */
  increment(key: string, value = 1, labels: MetricLabels = {}): void {
    const definition = this.definitions.get(key);
    if (!definition) return;
    if (value <= 0) return;
    const id = sampleKey(definition, labels);
    const existing = this.samples.get(id);
    if (existing) {
      // Counters are always plain numbers; a string amount only ever appears
      // on a gauge set through setAmount, which increment is never used for.
      if (typeof existing.value === "number") existing.value += value;
      return;
    }
    this.samples.set(id, { definition, labels: { ...labels }, value });
  }

  /** Set a gauge to a value. */
  set(key: string, value: number, labels: MetricLabels = {}): void {
    const definition = this.definitions.get(key);
    if (!definition) return;
    const id = sampleKey(definition, labels);
    this.samples.set(id, { definition, labels: { ...labels }, value });
  }

  /**
   * Set a gauge that carries an amount of money.
   *
   * The amount arrives as the decimal string (or bigint) the projection
   * computed and is stored verbatim — it never becomes a JavaScript number,
   * which would round anything above 2^53. This is the deliberate departure
   * from {@link set} noted in the file's header: Prometheus prints a gauge's
   * value as text, so the exact digits survive all the way to the scrape.
   */
  setAmount(key: string, value: string | bigint, labels: MetricLabels = {}): void {
    const definition = this.definitions.get(key);
    if (!definition) return;
    const id = sampleKey(definition, labels);
    this.samples.set(id, { definition, labels: { ...labels }, value: value.toString() });
  }

  /** The current value of one sample, for tests and for the API's own use. */
  value(key: string, labels: MetricLabels = {}): number | string | undefined {
    const definition = this.definitions.get(key);
    if (!definition) return undefined;
    return this.samples.get(sampleKey(definition, labels))?.value;
  }

  /** Forget every sample; the next render starts from zero. */
  reset(): void {
    this.samples.clear();
  }

  /**
   * The registry in the Prometheus text exposition format (version 0.0.4).
   *
   * Every metric is announced with its HELP and TYPE lines, even when it has
   * no sample yet: a metric family without samples is valid, and it means a
   * scrape shows the whole set of names the service exports — so an alert on
   * a counter that has never been incremented does not look like a metric
   * that does not exist.
   *
   * Metrics are written in declaration order and samples in label order, so
   * two scrapes of an unchanged service produce byte-identical output.
   */
  render(): string {
    const lines: string[] = [];
    for (const definition of this.definitions.values()) {
      const samples = [...this.samples.values()]
        .filter((sample) => sample.definition.name === definition.name)
        .sort((a, b) => sampleKey(a.definition, a.labels).localeCompare(sampleKey(b.definition, b.labels)));
      lines.push(`# HELP ${definition.name} ${escapeHelp(definition.help)}`);
      lines.push(`# TYPE ${definition.name} ${definition.type}`);
      for (const sample of samples) {
        lines.push(`${definition.name}${renderLabels(sample.labels)} ${sample.value}`);
      }
    }
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  }
}

/**
 * The registry the service publishes.
 *
 * A module-level singleton, like the logger and the merchant summary cache:
 * the indexer, the keeper and the HTTP layer all need the same numbers, and
 * threading a registry through every constructor would only add ceremony.
 */
export const metrics = new MetricsRegistry();

/** What the gauges about the indexer are read from. */
export interface IndexerProgress {
  /** The ledger up to which events have been projected. */
  cursor: number;
  /** The latest ledger the RPC node reported. */
  latest: number;
}

/**
 * Publish an indexer's progress.
 *
 * The indexer calls this after every pass, and the metrics endpoint calls it
 * again before it renders: the gauges then always describe the projection as
 * it stands, not as it stood after the last pass.
 */
export function publishIndexerMetrics(progress: IndexerProgress, network: string): void {
  const labels = { network };
  metrics.set("indexer_cursor", progress.cursor, labels);
  metrics.set("indexer_latest_ledger", progress.latest, labels);
  metrics.set("indexer_lag", Math.max(0, progress.latest - progress.cursor), labels);
}

/** What the business gauges are read from: one pass over the projection. */
export interface BusinessMetrics {
  /** Mandates whose status is `Active`. */
  activeMandates: number;
  /** Distinct merchants holding at least one active mandate. */
  activeMerchants: number;
  /**
   * Monthly recurring revenue: every active mandate with a positive period
   * normalised to a 30-day month. An amount is money, so it is the decimal
   * string of an exact sum — never a JavaScript number.
   */
  mrr: string;
}

/**
 * Read the projection's business numbers in one short, indexed statement.
 *
 * One scan of the active mandates serves all three gauges — the
 * `mandates_due(status, next_charge)` index answers the status filter, and
 * there is no join, no sort and no per-merchant grouping, because
 * `node:sqlite` is synchronous and runs on the API's event loop.
 *
 * The MRR uses the same arithmetic `/api/merchants/:address/summary`
 * reports — `amount × 2592000 / period` per active mandate with a positive
 * period, truncated per mandate — so a dashboard and the API agree. It is
 * summed here in bigint rather than in SQL: SQLite's `SUM` silently
 * promotes the result to a double as soon as `amount × 2592000` leaves int64
 * range (any mandate over ~35,500 units of the token), which would round the
 * very figures this gauge exists to chart. Money stays a string, end to end.
 */
export async function readBusinessMetrics(db: Storage): Promise<BusinessMetrics> {
  const rows = await db.all<{ merchant: string; amount: string; period: number }>(
    "SELECT merchant, amount, period FROM mandates WHERE status = 'Active'",
  );

  const month = BigInt(SECONDS_PER_MONTH);
  const merchants = new Set<string>();
  let mrr = 0n;
  for (const row of rows) {
    merchants.add(row.merchant);
    if (row.period <= 0) continue;
    // `String(...)` keeps the decimal digits exact for BigInt; a mandate
    // billed every 0 seconds contributes nothing, like the API's summary.
    mrr += (BigInt(String(row.amount)) * month) / BigInt(row.period);
  }
  return {
    activeMandates: rows.length,
    activeMerchants: merchants.size,
    mrr: mrr.toString(),
  };
}

/**
 * Publish the projection's business gauges for one network.
 *
 * The indexer calls this after every pass, so the series follow the
 * projection as it grows; the metrics endpoint calls it again before it
 * renders, so a scrape sees the projection as it stands (and a deployment
 * whose API serves without an indexer still reports its own database).
 *
 * The gauges are labelled by `network` only — never by merchant, plan or
 * token — so the series count stays bounded however the business grows.
 *
 * A projection that cannot be read (a locked or corrupt database) is logged
 * and left for the next refresh: one bad scrape of business numbers must not
 * take the indexer loop down with it.
 */
export async function publishBusinessMetrics(db: Storage, network: string): Promise<void> {
  try {
    const business = await readBusinessMetrics(db);
    const labels = { network };
    metrics.set("active_mandates", business.activeMandates, labels);
    metrics.set("active_merchants", business.activeMerchants, labels);
    metrics.setAmount("mrr", business.mrr, labels);
  } catch (err) {
    logger.warn({ err, network }, "could not refresh the business metrics");
  }
}
