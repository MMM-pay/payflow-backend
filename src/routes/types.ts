/**
 * Shapes of every REST response, defined once and shared three ways: the
 * route handlers annotate their bodies with these (so the API cannot drift
 * from them without failing typecheck), `src/routes/index.ts` re-exports
 * them, and the typed client in `src/client/index.ts` returns them. The
 * frontend consumes them through the client instead of re-declaring types.
 *
 * Amounts are decimal strings in the token's smallest unit (stroops for
 * XLM); they are never JS numbers.
 */

/**
 * What a token contract id means. `decimals` says how to scale an amount, and
 * `symbol` is what to label it with; without them an amount of a 6-decimal
 * token is displayed as if it were stroops.
 *
 * Native XLM is reported as XLM/7 without reading the chain, because the
 * network's own asset contract returns `native` as its symbol.
 */
export interface TokenMetadata {
  /** Contract id of the token, as stored in the projection. */
  token: string;
  symbol: string;
  name: string;
  /** Digits after the decimal point; 7 for XLM's stroops. */
  decimals: number;
}

/**
 * Token metadata joined onto a row's amounts. `null` means the token contract
 * could not be read (RPC unreachable, or the token is not an SAC); the amount
 * stays a string in the token's smallest unit either way, so a consumer must
 * not scale it when these are null.
 */
export interface TokenFields {
  tokenSymbol?: string | null;
  decimals?: number | null;
}

export interface PlanRow extends TokenFields {
  id: number;
  merchant: string;
  name: string;
  token: string;
  /** String amount, token's smallest unit. */
  amount: string;
  period: number;
  active: number;
  ledger: number;
}

export interface MandateRow extends TokenFields {
  id: number;
  subscriber: string;
  merchant: string;
  plan_id: number;
  /** String amount, token's smallest unit. */
  amount: string;
  period: number;
  next_charge: number;
  last_charge: number;
  charges_made: number;
  max_charges: number;
  fee_bps: number;
  status: string;
  ended_by: string | null;
  ledger: number;
}

export interface ChargeRow {
  tx_hash: string;
  mandate_id: number;
  subscriber: string;
  merchant: string;
  /** String amount, token's smallest unit. */
  amount: string;
  /** String protocol fee in the same unit. */
  fee: string;
  charges_made: number;
  next_charge: number;
  ledger: number;
  created_at: number;
}

/** A mandate from the `/due` list: the chargeable subset of a mandate. */
export interface DueMandateRow {
  id: number;
  subscriber: string;
  merchant: string;
  next_charge: number;
  amount: string;
}

export interface PlanPage {
  plans: PlanRow[];
}

/** Per-plan statistics for comparing plans at a glance. */
export interface PlanStatsResponse {
  planId: number;
  /** Mandates with status `Active`. */
  activeMandates: number;
  /** All mandates for this plan, any status. */
  totalMandates: number;
  /** Mandates with status `Cancelled`. */
  cancellations: number;
  /** String sum of settled charge amounts, token's smallest unit. */
  totalCollected: string;
  /** Settled charges across all mandates of this plan. */
  totalCharges: number;
  /** Mean settled charges per mandate (plain division; 0 when no mandates). */
  averageChargesPerMandate: number;
}

export interface MandatePage {
  mandates: MandateRow[];
}

export interface ChargePage {
  charges: ChargeRow[];
}

export interface VaultBalance {
  token: string;
  /** Latest on-chain balance in the token's smallest unit. */
  balance: string;
  ledger: number;
}

export interface VaultEventRow {
  tx_hash: string;
  kind: string;
  user: string;
  token: string;
  counterparty: string | null;
  /** Event amount in the token's smallest unit. */
  amount: string;
  /** Post-event balance in the token's smallest unit. */
  balance: string;
  ledger: number;
}

export interface VaultBalancePage {
  address: string;
  balances: VaultBalance[];
}

export interface VaultEventPage {
  address: string;
  events: VaultEventRow[];
}

export interface ProtocolFeeChange {
  tx_hash: string;
  old_fee_bps: number;
  new_fee_bps: number;
  ledger: number;
}

export interface ProtocolResponse {
  /** Null until a fee_changed event has been indexed. */
  fee_bps: number | null;
  history: ProtocolFeeChange[];
}

export interface KeeperPassSummary {
  time: number;
  attempted: number;
  settled: number;
  failures: { mandateId: number; error: string }[];
  backoff: { mandateId: number; failures: number; retryAt: number; retryIn: number }[];
}

export interface KeeperHistoryResponse {
  passes: KeeperPassSummary[];
}

export interface DuePage {
  now: number;
  due: DueMandateRow[];
}

export interface TokenRevenue {
  token: string;
  totalCollected: string;
  mrr: string;
}

export interface MerchantSummary {
  merchant: string;
  activeMandates: number;
  /** String sum of charged amounts, token's smallest unit. */
  totalCollected: string;
  chargeCount: number;
  /** String MRR: active mandates normalised to a 30-day month. */
  mrr: string;
  /** String ARR: active mandates normalised to a 365-day year. */
  arr: string;
  tokens: TokenRevenue[];
}

export interface ForecastResponse {
  merchant: string;
  days: number;
  from: number;
  to: number;
  forecast: string;
  mandateCount: number;
  assumptions: string[];
}

export interface SubscriberSummary {
  subscriber: string;
  mandates: MandateRow[];
  /** String sum of amount + fee paid, token's smallest unit. */
  totalPaid: string;
}

/** One subscriber of a merchant, grouped across all of that subscriber's mandates with the merchant. */
export interface MerchantSubscriber {
  /** Subscriber address. */
  subscriber: string;
  /** Distinct mandates this subscriber holds with this merchant. */
  mandateCount: number;
  /** Charges settled from this subscriber to this merchant. */
  chargeCount: number;
  /** Lifetime value: gross amount collected from this subscriber, token's smallest unit. */
  totalCollected: string;
}

export interface MerchantSubscribersResponse {
  merchant: string;
  /** Subscribers with at least one mandate, ordered by lifetime value descending. */
  subscribers: MerchantSubscriber[];
}

export interface UpcomingCharge {
  mandateId: number;
  merchant: string;
  amount: string;
  at: number;
}

export interface UpcomingChargesResponse {
  subscriber: string;
  days: number;
  now: number;
  until: number;
  upcoming: UpcomingCharge[];
  totalUpcoming: string;
  truncated: boolean;
  assumptions: string[];
}

export interface StatsResponse {
  plans: number;
  mandates: number;
  activeMandates: number;
  charges: number;
  /** String gross charge volume in the last 24h, token's smallest unit. */
  volume24h: string;
  /** String gross charge volume all-time, token's smallest unit. */
  volumeAllTime: string;
  /** String sum of fees collected all-time, token's smallest unit. */
  totalFees: string;
  /** Count of distinct merchants with at least one active mandate. */
  activeMerchants: number;
  lastIndexedLedger: number;
}

export type HealthStatus = "starting" | "ok" | "catching_up";

export interface HealthResponse {
  status: HealthStatus;
  network: string;
  indexer: {
    cursor: number;
    latestLedger: number;
    lag: number | null;
    /** True when the indexer loop is held back at runtime (see /admin/indexer/pause). */
    paused: boolean;
    freshnessSeconds: number | null;
    lastRunAt: string | null;
    lastError: string | null;
    /** Contract events that failed spec validation since process start. */
    mismatchedEvents: number;
    /** Reconcile passes run since process start. */
    reconciliations: number;
    /** Mandate rows the reconciler has brought back in line with the chain. */
    corrections: number;
  } | null;
  rpc?: {
    active: string;
    endpoints: readonly string[];
  } | null;
  contracts: {
    planRegistry: string;
    vault: string;
    subscription: string;
  };
  networks?: Record<string, HealthResponse>;
}

/**
 * Error bodies are the structured envelope `{ error: { code, message, requestId } }`;
 * `code` is stable per endpoint (see `src/routes/errors.ts` for the closed set
 * and how to extend it). This replaces the previous `{ error: <code> }` string
 * body — consumers now read `error.code`.
 */
export type { ApiErrorBody as ApiErrorResponse, ApiErrorCode } from "./errors.ts";
