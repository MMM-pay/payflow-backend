import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { big, num, str } from "./stellar.ts";
import type { DecodedEvent } from "./stellar.ts";
import type {
  WebhookDelivery,
  WebhookRegistration,
  WebhookRotation,
  WebhookSummary,
  WebhookTestResult,
} from "../routes/types.ts";
import { logger } from "./logger.ts";

/** Most delivery attempts before a webhook is marked failed. */
const MAX_ATTEMPTS = 5;
/** First retry delay in seconds; doubles per attempt. */
const BACKOFF_BASE_S = 60;
/** Longest delay between attempts. */
const BACKOFF_MAX_S = 6 * 60 * 60;
/** How many due deliveries one retry pass touches. */
const RETRY_BATCH = 25;
/** Delivery attempts kept per webhook for the history endpoint. */
const HISTORY_LIMIT = 100;
/** How long a rotated secret keeps signing when no overlap is configured. */
const DEFAULT_SECRET_OVERLAP_S = 24 * 60 * 60;

function backoffSeconds(attempt: number): number {
  return Math.min(BACKOFF_BASE_S * 2 ** (attempt - 1), BACKOFF_MAX_S);
}

export interface Webhook {
  id: number;
  merchant: string;
  url: string;
  secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: number | null;
  active: number;
  failed: number;
  failures: number;
  last_attempt: number | null;
  last_status: number | null;
}

interface FetchResponse {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
}

interface DeliveryRow {
  id: number;
  webhook_id: number;
  event_id: string;
  idempotency_key: string;
  attempt: number;
  status: string;
  http_status: number | null;
  response_body: string | null;
  error: string | null;
  payload: string;
  retry_at: number;
  created_at: number;
}

interface WebhookRow {
  id: number;
  merchant: string;
  url: string;
  secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: number | null;
  active: number;
  failed: number;
  failures: number;
  last_attempt: number | null;
  last_status: number | null;
}

/** How one delivery attempt went. */
type AttemptOutcome = Omit<WebhookTestResult, "deliveryId">;

/**
 * The `Payflow-Signature` header: `sha256=<hex>` under the current secret
 * and, while a rotation's overlap lasts, a second `sha256=<hex>` under the
 * previous one, comma-separated. A receiver accepts the request when any
 * listed signature matches a secret it holds.
 */
function signatureHeader(payload: string, webhook: WebhookRow, now: number): string {
  const secrets = [webhook.secret];
  if (webhook.previous_secret !== null && (webhook.previous_secret_expires_at ?? 0) > now) {
    secrets.push(webhook.previous_secret);
  }
  return secrets
    .map((secret) => `sha256=${createHmac("sha256", Buffer.from(secret, "utf8")).update(payload).digest("hex")}`)
    .join(", ");
}

export interface WebhookDispatcherOptions {
  db: DatabaseSync;
  events?: EventEmitter | undefined;
  fetchImpl?: typeof globalThis.fetch;
  /** Seconds a rotated secret keeps signing beside the new one; 0 drops it at once. */
  secretOverlapSeconds?: number | undefined;
}

/**
 * Delivers `charged` events to merchant-registered webhooks.
 *
 * Delivery is at-least-once: every charge event creates a pending delivery
 * per active webhook, carried by an idempotency key that is reused across
 * retries so a receiver can collapse duplicate attempts. Each POST carries
 * a `Payflow-Signature: sha256=<hex>` HMAC computed with the webhook's
 * secret — two of them while a rotated secret's overlap lasts — so the
 * merchant can verify the request came from this service. Failing
 * deliveries retry with exponential backoff up to MAX_ATTEMPTS times; a
 * webhook whose delivery gives up is marked failed and no longer receives
 * events. Every attempt is logged (the newest HISTORY_LIMIT per webhook) so
 * a merchant can see what failed and when the next retry is. All writes are
 * idempotent and all reads are short, so the dispatcher never blocks the
 * indexer's synchronous SQLite.
 */
export class WebhookDispatcher {
  private readonly db: DatabaseSync;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly events: EventEmitter;
  private readonly secretOverlapSeconds: number;

  constructor(options: WebhookDispatcherOptions) {
    this.db = options.db;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.events = options.events ?? new EventEmitter();
    this.secretOverlapSeconds = options.secretOverlapSeconds ?? DEFAULT_SECRET_OVERLAP_S;
  }

  /** Subscribe to the indexer's applied events and dispatch charges. */
  bind(events: EventEmitter): void {
    events.on("applied", (e: unknown) => {
      void this.onApplied(e as DecodedEvent).catch((err) =>
        logger.error({ err }, "webhook dispatch failed"),
      );
    });
  }

  /**
   * Register a webhook for a merchant. `secret` is the HMAC key used to
   * sign deliveries; when omitted a server-generated secret is returned
   * to the caller exactly once.
   */
  register(merchant: string, url: string, secret?: string): WebhookRegistration {
    const value = secret ?? randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const info = this.db
      .prepare(
        `INSERT INTO webhooks (merchant, url, secret, active, failed, failures, created_at)
         VALUES (?, ?, ?, 1, 0, 0, ?)`,
      )
      .run(merchant, url, value, now);
    return {
      id: (info.lastInsertRowid as number) ?? 0,
      merchant,
      url,
      secret: value,
      active: true,
    };
  }

  /** The active, non-failed webhooks for a merchant, newest first. */
  listWebhooks(merchant: string): Webhook[] {
    return this.db
      .prepare(
        `SELECT id, merchant, url, secret, previous_secret, previous_secret_expires_at,
                active, failed, failures, last_attempt, last_status
           FROM webhooks
          WHERE merchant = ? AND active = 1 AND failed = 0
          ORDER BY id DESC`,
      )
      .all(merchant) as unknown as Webhook[];
  }

  /**
   * A merchant's registered (not deleted) webhooks for the API, newest
   * first. Includes webhooks that gave up after failed deliveries, so the
   * merchant can see and remove them. The secret is reduced to its last
   * four characters and never leaves this method whole.
   */
  listForMerchant(merchant: string): WebhookSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, url, secret, failed, failures, last_attempt, last_status, created_at
           FROM webhooks
          WHERE merchant = ? AND active = 1
          ORDER BY id DESC`,
      )
      .all(merchant) as unknown as Array<{
      id: number;
      url: string;
      secret: string;
      failed: number;
      failures: number;
      last_attempt: number | null;
      last_status: number | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      merchant,
      url: row.url,
      secretLast4: row.secret.slice(-4),
      failed: row.failed === 1,
      failures: row.failures,
      lastAttempt: row.last_attempt,
      lastStatus: row.last_status,
      createdAt: row.created_at,
    }));
  }

  /**
   * Delete a merchant's webhook: it is deactivated, so it receives no new
   * events, and its pending deliveries are dropped, so scheduled retries
   * stop too. The row stays for the delivery history. Returns false when
   * no active webhook with that id belongs to the merchant.
   */
  deactivate(merchant: string, id: number): boolean {
    const info = this.db
      .prepare("UPDATE webhooks SET active = 0 WHERE id = ? AND merchant = ? AND active = 1")
      .run(id, merchant);
    if (Number(info.changes) === 0) return false;
    this.db
      .prepare(
        `UPDATE webhook_deliveries SET status = 'failed', error = 'webhook deleted'
          WHERE webhook_id = ? AND status = 'pending'`,
      )
      .run(id);
    return true;
  }

  /**
   * Give a merchant's webhook a new signing secret, returned to the caller
   * once. The replaced secret keeps signing beside it for the configured
   * overlap, so the receiver can switch without missing a delivery; a
   * second rotation within the overlap retires the oldest secret at once.
   * Null when no active webhook with that id belongs to the merchant.
   */
  rotateSecret(merchant: string, id: number): WebhookRotation | null {
    const secret = randomUUID();
    const previousSecretExpiresAt =
      this.secretOverlapSeconds > 0 ? Math.floor(Date.now() / 1000) + this.secretOverlapSeconds : null;
    // SET expressions read the row as it was, so `previous_secret` takes the
    // secret being replaced.
    const info = this.db
      .prepare(
        `UPDATE webhooks
            SET previous_secret = CASE WHEN ? IS NULL THEN NULL ELSE secret END,
                previous_secret_expires_at = ?,
                secret = ?
          WHERE id = ? AND merchant = ? AND active = 1`,
      )
      .run(previousSecretExpiresAt, previousSecretExpiresAt, secret, id, merchant);
    if (Number(info.changes) === 0) return null;
    return { id, secret, previousSecretExpiresAt };
  }

  /**
   * Send a merchant's webhook a `ping` through the normal path: a delivery
   * row, the same headers and signatures as a charge, and on failure the
   * same backoff retries. Resolves with the first attempt's outcome, or null
   * when no webhook with that id is receiving deliveries for the merchant.
   */
  async ping(merchant: string, id: number): Promise<WebhookTestResult | null> {
    const webhook = this.db
      .prepare(
        `SELECT id, merchant, url, secret, previous_secret, previous_secret_expires_at,
                active, failed, failures, last_attempt, last_status
           FROM webhooks
          WHERE id = ? AND merchant = ? AND active = 1 AND failed = 0`,
      )
      .get(id, merchant) as unknown as WebhookRow | undefined;
    if (!webhook) return null;
    const payload = JSON.stringify({ event: "ping", webhook_id: id, merchant });
    const delivery = this.enqueue(webhook.id, `ping:${randomUUID()}`, randomUUID(), payload);
    return { deliveryId: delivery.id, ...(await this.attempt(delivery, webhook)) };
  }

  /**
   * A merchant's webhook's newest delivery attempts (at most HISTORY_LIMIT),
   * newest first, or null when no webhook with that id belongs to the
   * merchant. A deleted webhook keeps its history.
   */
  history(merchant: string, id: number): WebhookDelivery[] | null {
    if (!this.db.prepare("SELECT 1 FROM webhooks WHERE id = ? AND merchant = ?").get(id, merchant)) {
      return null;
    }
    const rows = this.db
      .prepare(
        `SELECT id, delivery_id, event_id, attempt, status, http_status, error, next_retry_at, attempted_at
           FROM webhook_attempts
          WHERE webhook_id = ?
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(id, HISTORY_LIMIT) as unknown as Array<{
      id: number;
      delivery_id: number;
      event_id: string;
      attempt: number;
      status: WebhookDelivery["status"];
      http_status: number | null;
      error: string | null;
      next_retry_at: number | null;
      attempted_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      deliveryId: row.delivery_id,
      eventId: row.event_id,
      attempt: row.attempt,
      status: row.status,
      statusCode: row.http_status,
      error: row.error,
      nextRetryAt: row.next_retry_at,
      attemptedAt: row.attempted_at,
    }));
  }

  /** Deliveries due for retry right now, oldest retry first. */
  dueDeliveries(now: number = Math.floor(Date.now() / 1000)): Array<{
    delivery: DeliveryRow;
    webhook: WebhookRow;
  }> {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.webhook_id, d.event_id, d.idempotency_key, d.attempt, d.status,
                d.http_status, d.response_body, d.error, d.payload, d.retry_at, d.created_at,
                w.merchant, w.url, w.secret, w.previous_secret, w.previous_secret_expires_at
           FROM webhook_deliveries d
           JOIN webhooks w ON w.id = d.webhook_id
          WHERE d.status = 'pending' AND d.retry_at <= ? AND w.active = 1 AND w.failed = 0
          ORDER BY d.retry_at
          LIMIT ?`,
      )
      .all(now, RETRY_BATCH) as unknown as Array<{
        id: number;
        webhook_id: number;
        event_id: string;
        idempotency_key: string;
        attempt: number;
        status: string;
        http_status: number | null;
        response_body: string | null;
        error: string | null;
        payload: string;
        retry_at: number;
        created_at: number;
        merchant: string;
        url: string;
        secret: string;
        previous_secret: string | null;
        previous_secret_expires_at: number | null;
      }>;
    return rows.map((row) => ({
      delivery: {
        id: row.id,
        webhook_id: row.webhook_id,
        event_id: row.event_id,
        idempotency_key: row.idempotency_key,
        attempt: row.attempt,
        status: row.status,
        http_status: row.http_status,
        response_body: row.response_body,
        error: row.error,
        payload: row.payload,
        retry_at: row.retry_at,
        created_at: row.created_at,
      },
      webhook: {
        id: row.webhook_id,
        merchant: row.merchant,
        url: row.url,
        secret: row.secret,
        previous_secret: row.previous_secret,
        previous_secret_expires_at: row.previous_secret_expires_at,
        active: 1,
        failed: 0,
        failures: 0,
        last_attempt: null,
        last_status: null,
      },
    }));
  }

  /** Inspect every delivery for a webhook, newest first. */
  deliveries(webhookId: number): Array<{
    id: number;
    attempt: number;
    status: string;
    http_status: number | null;
    error: string | null;
    retry_at: number;
  }> {
    return this.db
      .prepare(
        `SELECT id, attempt, status, http_status, error, retry_at
           FROM webhook_deliveries
          WHERE webhook_id = ?
          ORDER BY id DESC`,
      )
      .all(webhookId) as unknown as Array<{
      id: number;
      attempt: number;
      status: string;
      http_status: number | null;
      error: string | null;
      retry_at: number;
    }>;
  }

  /** The count of undelivered deliveries for a webhook. */
  pendingCount(webhookId: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ? AND status = 'pending'")
        .get(webhookId) as { n: number }
    ).n;
  }

  /**
   * React to an applied event: every active webhook for the charge's
   * merchant gets a pending delivery and a first delivery attempt.
   */
  async onApplied(e: DecodedEvent): Promise<void> {
    if (e.name !== "charged") return;
    const [mandateId, , merchant] = e.topics;
    const webhooks = this.listWebhooks(str(merchant));
    if (webhooks.length === 0) return;

    const eventId = `charge:${e.txHash}`;
    const idempotencyKey = randomUUID();
    const payload = JSON.stringify({
      event: e.name,
      mandate_id: num(mandateId),
      subscriber: str(e.topics[1]),
      merchant: str(merchant),
      amount: big(e.data.amount),
      fee: big(e.data.fee),
      ledger: e.ledger,
    } as Record<string, unknown>);

    for (const webhook of webhooks) {
      await this.attempt(this.enqueue(webhook.id, eventId, idempotencyKey, payload), webhook);
    }
  }

  /** Store a pending delivery due now, before its first attempt. */
  private enqueue(webhookId: number, eventId: string, idempotencyKey: string, payload: string): DeliveryRow {
    const now = Math.floor(Date.now() / 1000);
    const info = this.db
      .prepare(
        `INSERT INTO webhook_deliveries
           (webhook_id, event_id, idempotency_key, attempt, status, retry_at, payload, created_at)
         VALUES (?, ?, ?, 1, 'pending', ?, ?, ?)`,
      )
      .run(webhookId, eventId, idempotencyKey, now, payload, now);
    return {
      id: (info.lastInsertRowid as number) ?? 0,
      webhook_id: webhookId,
      event_id: eventId,
      idempotency_key: idempotencyKey,
      attempt: 1,
      status: "pending",
      http_status: null,
      response_body: null,
      error: null,
      payload,
      retry_at: now,
      created_at: now,
    };
  }

  /** Attempt one delivery once: success marks it delivered, failure
   *  reschedules it with backoff, and five failed attempts mark the
   *  webhook failed. The attempt is logged to the history either way.
   *  Never throws. */
  private async attempt(delivery: DeliveryRow, webhook: WebhookRow): Promise<AttemptOutcome> {
    const now = Math.floor(Date.now() / 1000);
    let httpStatus: number | null = null;
    let responseBody = "";
    let error: string | null = null;
    let ok = false;
    const started = performance.now();
    try {
      const init: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": delivery.idempotency_key,
          "Payflow-Signature": signatureHeader(delivery.payload, webhook, now),
        },
        body: delivery.payload,
        signal: AbortSignal.timeout(15_000),
      };
      const res = (await this.fetchImpl(webhook.url, init)) as unknown as FetchResponse;
      httpStatus = res.status;
      ok = res.ok;
      responseBody = await res.text();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const latencyMs = Math.round(performance.now() - started);

    let outcome: AttemptOutcome;
    const nextAttempt = delivery.attempt + 1;
    if (ok) {
      this.db
        .prepare(
          `UPDATE webhook_deliveries SET status = 'delivered', http_status = ?, response_body = ?, error = NULL WHERE id = ?`,
        )
        .run(httpStatus, responseBody, delivery.id);
      outcome = { status: "delivered", statusCode: httpStatus, latencyMs, error: null, nextRetryAt: null };
    } else if (nextAttempt > MAX_ATTEMPTS) {
      const finalError = error ?? "delivery failed";
      this.db
        .prepare(
          `UPDATE webhook_deliveries SET status = 'failed', http_status = ?, response_body = ?, error = ? WHERE id = ?`,
        )
        .run(httpStatus, responseBody, finalError, delivery.id);
      this.db
        .prepare(
          `UPDATE webhooks SET failed = 1, failures = failures + 1, last_attempt = ?, last_status = ? WHERE id = ?`,
        )
        .run(now, httpStatus, webhook.id);
      logger.warn(
        {
          webhookId: webhook.id,
          merchant: webhook.merchant,
          url: webhook.url,
          attempts: nextAttempt,
          lastError: error,
        },
        "webhook marked failed after exhausting delivery retries",
      );
      outcome = { status: "failed", statusCode: httpStatus, latencyMs, error: finalError, nextRetryAt: null };
    } else {
      const nextRetryAt = now + backoffSeconds(nextAttempt);
      this.db
        .prepare(
          `UPDATE webhook_deliveries
             SET attempt = ?, retry_at = ?, status = 'pending', error = ?, http_status = ?, response_body = ?
           WHERE id = ?`,
        )
        .run(nextAttempt, nextRetryAt, error, httpStatus, responseBody, delivery.id);
      this.db
        .prepare(
          `UPDATE webhooks SET last_attempt = ?, last_status = ?, failures = failures + 1 WHERE id = ?`,
        )
        .run(now, httpStatus, webhook.id);
      outcome = { status: "pending", statusCode: httpStatus, latencyMs, error, nextRetryAt };
    }

    this.record(delivery, outcome, now);
    return outcome;
  }

  /**
   * Log an attempt and prune the webhook's history to its newest
   * HISTORY_LIMIT rows. Both statements walk the (webhook_id, id) index, so
   * the cost is O(log n) however long the webhook has existed.
   */
  private record(delivery: DeliveryRow, outcome: AttemptOutcome, now: number): void {
    this.db
      .prepare(
        `INSERT INTO webhook_attempts
           (webhook_id, delivery_id, event_id, attempt, status, http_status, error, next_retry_at, attempted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        delivery.webhook_id,
        delivery.id,
        delivery.event_id,
        delivery.attempt,
        outcome.status,
        outcome.statusCode,
        outcome.error,
        outcome.nextRetryAt,
        now,
      );
    this.db
      .prepare(
        `DELETE FROM webhook_attempts
          WHERE webhook_id = ?
            AND id <= (SELECT id FROM webhook_attempts WHERE webhook_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      )
      .run(delivery.webhook_id, delivery.webhook_id, HISTORY_LIMIT);
  }

  /** Deliver every payment due for retry, once each. Returns a pass
   *  summary. Safe to run on an interval; failed fetches are logged and
   *  retried on the next pass, never thrown. */
  async retryDue(now: number = Math.floor(Date.now() / 1000)): Promise<{
    attempted: number;
    delivered: number;
    failed: number;
  }> {
    let attempted = 0;
    let delivered = 0;
    let failed = 0;
    for (const { delivery } of this.dueDeliveries(now)) {
      attempted += 1;
      const { status } = await this.attempt(delivery, this.webhookOf(delivery.webhook_id));
      if (status === "delivered") delivered += 1;
      else if (status === "failed") failed += 1;
    }
    return { attempted, delivered, failed };
  }

  private webhookOf(webhookId: number): WebhookRow {
    return this.db
      .prepare(
        `SELECT id, merchant, url, secret, previous_secret, previous_secret_expires_at,
                active, failed, failures, last_attempt, last_status
           FROM webhooks WHERE id = ?`,
      )
      .get(webhookId) as unknown as WebhookRow;
  }
}
