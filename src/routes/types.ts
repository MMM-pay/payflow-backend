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
  /**
   * The merchant's self-declared display name (see {@link MerchantProfile});
   * null when the merchant has not set a profile. Not verified by anyone.
   */
  merchantName?: string | null;
}

/**
 * A merchant's profile, as the plan registry's `profile_updated` event last
 * set it. Self-declared: the contract stores the name and the URL without
 * verifying either, so they are a claim the merchant makes about itself.
 */
export interface MerchantProfile {
  merchant: string;
  /** Display name, at most 64 bytes on-chain. */
  name: string;
  /** Website or terms URL, at most 256 bytes on-chain. Not validated. */
  url: string;
  /** The ledger of the profile update the row reflects. */
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

/** A due mandate as the projection holds it; its plan names the token. */
export interface DueMandateRecord {
  id: number;
  subscriber: string;
  merchant: string;
  next_charge: number;
  amount: string;
  /** The plan the mandate was opened against; its token names the vault balance. */
  plan_id: number;
}

/** A mandate from the `/due` list: the chargeable subset of a mandate. */
export interface DueMandateRow {
  id: number;
  subscriber: string;
  merchant: string;
  next_charge: number;
  amount: string;
  /**
   * Whether the last known vault balance covers this charge.
   *
   * The balance is the one the indexer last saw, so it can be behind the
   * chain; the keeper reads the balance from the contract before it settles.
   * A subscriber the projection has never seen holds nothing, so its
   * mandates are reported as not funded.
   */
  funded: boolean;
}

/** A due mandate the last known vault balance cannot cover: one row of a merchant's unpaid report. */
export interface UnpaidMandateRow {
  id: number;
  subscriber: string;
  /** When the charge fell due, in unix seconds. */
  next_charge: number;
  /** The charge, in the token's smallest unit. */
  amount: string;
  /** The last indexed vault balance of the plan's token; "0" when none is indexed. */
  balance: string;
  /** What the balance is missing: amount − balance. */
  shortfall: string;
  /** How long the charge has been due: `now` − `next_charge`, in seconds. */
  overdue_seconds: number;
}

export interface MerchantUnpaidResponse {
  merchant: string;
  /** The instant the report was built, in unix seconds. */
  now: number;
  /** Longest overdue first; ties by mandate id. */
  unpaid: UnpaidMandateRow[];
}

export interface PlanPage {
  plans: PlanRow[];
  /** Opaque cursor to fetch the page after this one; null on the final page. */
  nextCursor: string | null;
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
  /**
   * Mean lifetime value per subscriber, net of the protocol fee: what one
   * subscriber has paid the merchant through this plan. Every subscriber with
   * a mandate counts. Decimal string in the token's smallest unit, rounded
   * down; "0" when the plan has no mandates.
   */
  averageLtv: string;
  /** Median lifetime value per subscriber, same units; the floored mean of the middle two when even. */
  medianLtv: string;
}

/** One keeper attempt to charge a mandate. */
export interface ChargeAttemptRow {
  id: number;
  mandateId: number;
  /** When the keeper made the attempt, in unix seconds. */
  attemptedAt: number;
  /** `skipped`: the vault could not cover the charge, so nothing was submitted. */
  result: "settled" | "failed" | "skipped";
  /** Why it did not settle: an RPC status, a transaction result code or a host error. */
  errorCode: string | null;
  txHash: string | null;
  /** For a `skipped` attempt: what the vault was missing, token's smallest unit. */
  shortfall?: string;
  /** Consecutive failed attempts after this one; 0 once a charge settles. */
  failures: number;
  /** When the keeper tries again, in unix seconds; null after a settlement. */
  retryAt: number | null;
}

export interface ChargeAttemptPage {
  /** Newest first. */
  attempts: ChargeAttemptRow[];
}

export interface MandatePage {
  mandates: MandateRow[];
  /** Opaque cursor to fetch the page after this one; null on the final page. */
  nextCursor: string | null;
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
  /** The latest code version of each contract that has been upgraded. */
  contract_versions: { contract_id: string; wasm_hash: string; ledger: number }[];
}

/** One bucket of the protocol fee report. */
export interface ProtocolFeeBucket {
  /**
   * The bucket's label: `2025-01-15` for a day, the Monday's date
   * (`2025-01-13`) for a week, and `2025-01` for a month. All in UTC.
   */
  bucket: string;
  /** Fees the protocol collected in the bucket, token's smallest unit. */
  fee: string;
  /** Charges settled in the bucket. */
  charges: number;
}

export interface ProtocolFeesResponse {
  /** The bucket size the report is grouped by. */
  bucket: RevenueBucketSize;
  /** The buckets, oldest first. */
  buckets: ProtocolFeeBucket[];
  /** The same figures summed over every bucket in the report. */
  totals: Omit<ProtocolFeeBucket, "bucket">;
}

export interface KeeperPassSummary {
  time: number;
  attempted: number;
  settled: number;
  failures: { mandateId: number; error: string }[];
  /**
   * Mandates the keeper did not try to settle because the subscriber's vault
   * could not cover the charge. Every amount is a decimal string in the
   * token's smallest unit.
   */
  skipped?: {
    mandateId: number;
    /** The amount the charge needs. */
    required: string;
    /** The balance the vault holds. */
    balance: string;
    /** What is missing. */
    shortfall: string;
  }[];
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
  /** Sum of the charge amounts collected from this subscriber, token's smallest unit. */
  totalCollected: string;
  /**
   * Lifetime value net of the protocol fee: what this subscriber has paid the
   * merchant, token's smallest unit. A charge's `amount` is already the
   * merchant's share, so this equals `totalCollected`; `ltv` is the field
   * that names it.
   */
  ltv: string;
}

export interface MerchantSubscribersResponse {
  merchant: string;
  /** Subscribers with at least one mandate, ordered by lifetime value descending. */
  subscribers: MerchantSubscriber[];
}

/** The time buckets a churn report can be grouped by. */
export type ChurnBucketSize = "day" | "week" | "month";

/** One bucket of a merchant's churn report. */
export interface ChurnBucket {
  /**
   * The bucket's label: `2025-01` for a month, `2025-01-15` for a day, and
   * the Monday's date (`2025-01-13`) for a week. All in UTC.
   */
  bucket: string;
  /** Mandates that started in the bucket. */
  started: number;
  /** Mandates the subscriber cancelled in the bucket. */
  cancelled: number;
  /** Mandates the merchant ended in the bucket. */
  ended: number;
  /** Mandates that completed their full charge count in the bucket. */
  completed: number;
  /** `started` minus the departures: the net growth of the mandate base. */
  net: number;
}

export interface MerchantChurnResponse {
  merchant: string;
  /** The bucket size the report is grouped by. */
  bucket: ChurnBucketSize;
  /** The buckets, oldest first. */
  buckets: ChurnBucket[];
  /** The same counts summed over every bucket in the report. */
  totals: Omit<ChurnBucket, "bucket">;
}

/** How much of a cohort was still active a number of buckets after it started. */
export interface CohortRetention {
  /** Buckets after the cohort's own: 1 is the start of the next bucket. */
  period: number;
  /** Mandates of the cohort with no departure before that instant. */
  active: number;
  /** `active` ÷ the cohort's size, from 0 to 1. */
  share: number;
}

/** The mandates that started in one bucket. */
export interface Cohort {
  /** The bucket's label, as in the churn report. All in UTC. */
  cohort: string;
  /** Mandates that started in the bucket. */
  size: number;
  /** One entry per bucket that has begun since, oldest first. */
  retention: CohortRetention[];
}

export interface MerchantCohortsResponse {
  merchant: string;
  /** The bucket size cohorts and periods are measured in. */
  bucket: ChurnBucketSize;
  /** Cohorts with at least one mandate, oldest first. */
  cohorts: Cohort[];
}

/**
 * The time buckets a revenue report can be grouped by. The same calendar
 * periods the churn report uses, so a chart can put both on one axis.
 */
export type RevenueBucketSize = ChurnBucketSize;

/** One bucket of a merchant's revenue report. */
export interface RevenueBucket {
  /**
   * The bucket's label: `2025-01-15` for a day, the Monday's date
   * (`2025-01-13`) for a week, and `2025-01` for a month. All in UTC.
   */
  bucket: string;
  /** Gross collected from subscribers: the charge amount plus the fee. */
  gross: string;
  /** The protocol's share of that gross. */
  fee: string;
  /** What the merchant kept: gross minus the fee. */
  net: string;
  /** Charges settled in the bucket. */
  charges: number;
}

export interface MerchantRevenueResponse {
  merchant: string;
  /** The bucket size the report is grouped by. */
  bucket: RevenueBucketSize;
  /** Start of the requested range in unix seconds; null when unbounded. */
  from: number | null;
  /** End of the requested range in unix seconds (exclusive); null when unbounded. */
  to: number | null;
  /** The buckets, oldest first. */
  buckets: RevenueBucket[];
  /** The same figures summed over every bucket in the report. */
  totals: Omit<RevenueBucket, "bucket">;
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

/** A registered webhook destination for charge events, returned to the
 *  merchant at registration (including the HMAC signing secret). */
export interface WebhookRegistration {
  id: number;
  merchant: string;
  url: string;
  /** HMAC-SHA256 key used to sign delivery requests. */
  secret: string;
  active: boolean;
}

/** A registered webhook as `GET /api/webhooks` lists it: never the secret. */
export interface WebhookSummary {
  id: number;
  merchant: string;
  url: string;
  /** The signing secret's last four characters, to tell secrets apart. */
  secretLast4: string;
  /** True once deliveries gave up after repeated failures. */
  failed: boolean;
  failures: number;
  /** Unix seconds of the last failed delivery attempt, if any. */
  lastAttempt: number | null;
  lastStatus: number | null;
  /** Unix seconds. */
  createdAt: number;
}

export interface WebhookListResponse {
  merchant: string;
  webhooks: WebhookSummary[];
}

/** `POST /api/webhooks/:id/rotate`: the new secret, returned this once. */
export interface WebhookRotation {
  id: number;
  /** HMAC-SHA256 key that signs deliveries from now on. */
  secret: string;
  /** Unix seconds until which the previous secret also signs; null when it was dropped at once. */
  previousSecretExpiresAt: number | null;
}

/** The state of a delivery after an attempt. */
export type WebhookDeliveryStatus = "delivered" | "pending" | "failed";

/** `POST /api/webhooks/:id/test`: how the ping's first attempt went. */
export interface WebhookTestResult {
  deliveryId: number;
  /** `pending` means the attempt failed and a retry is scheduled at `nextRetryAt`. */
  status: WebhookDeliveryStatus;
  /** The endpoint's HTTP status; null when no response arrived. */
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
  nextRetryAt: number | null;
}

/** One delivery attempt, as `GET /api/webhooks/:id/deliveries` lists it. */
export interface WebhookDelivery {
  id: number;
  /** The delivery the attempt belongs to; its retries share it. */
  deliveryId: number;
  /** `charge:<tx hash>` or `ping:<uuid>`. */
  eventId: string;
  attempt: number;
  status: WebhookDeliveryStatus;
  statusCode: number | null;
  error: string | null;
  /** Unix seconds of the retry this attempt scheduled; null unless `pending`. */
  nextRetryAt: number | null;
  /** Unix seconds. */
  attemptedAt: number;
}

export interface WebhookDeliveriesResponse {
  webhookId: number;
  deliveries: WebhookDelivery[];
}

/** `GET /api/auth`: a SEP-10 challenge transaction for the client to sign. */
export interface AuthChallengeResponse {
  /** Base64 XDR transaction envelope. */
  transaction: string;
  network_passphrase: string;
}

/** `POST /api/auth`: a SEP-10 JWT, sent as `Authorization: Bearer <token>`. */
export interface AuthTokenResponse {
  token: string;
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
