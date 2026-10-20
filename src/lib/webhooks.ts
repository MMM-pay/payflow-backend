import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { big, num, str } from "./stellar.ts";
import type { DecodedEvent } from "./stellar.ts";
import type { WebhookRegistration } from "../routes/types.ts";
import { logger } from "./logger.ts";

/** Most delivery attempts before a webhook is marked failed. */
const MAX_ATTEMPTS = 5;
/** First retry delay in seconds; doubles per attempt. */
const BACKOFF_BASE_S = 60;
/** Longest delay between attempts. */
const BACKOFF_MAX_S = 6 * 60 * 60;
/** How many due deliveries one retry pass touches. */
const RETRY_BATCH = 25;

function backoffSeconds(attempt: number): number {
  return Math.min(BACKOFF_BASE_S * 2 ** (attempt - 1), BACKOFF_MAX_S);
}

export interface Webhook {
  id: number;
  merchant: string;
  url: string;
  secret: string;
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
  active: number;
  failed: number;
  failures: number;
  last_attempt: number | null;
  last_status: number | null;
}

export interface WebhookDispatcherOptions {
  db: DatabaseSync;
  events?: EventEmitter | undefined;
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Delivers `charged` events to merchant-registered webhooks.
 *
 * Delivery is at-least-once: every charge event creates a pending delivery
 * per active webhook, carried by an idempotency key that is reused across
 * retries so a receiver can collapse duplicate attempts. Each POST carries
 * a `Payflow-Signature: sha256=<hex>` HMAC computed with the webhook's
 * secret, so the merchant can verify the request came from this service.
 * Failing deliveries retry with exponential backoff up to MAX_ATTEMPTS
 * times; a webhook whose delivery gives up is marked failed and no longer
 * receives events. All writes are idempotent and all reads are short, so
 * the dispatcher never blocks the indexer's synchronous SQLite.
 */
export class WebhookDispatcher {
  private readonly db: DatabaseSync;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly events: EventEmitter;

  constructor(options: WebhookDispatcherOptions) {
    this.db = options.db;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.events = options.events ?? new EventEmitter();
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
        `SELECT id, merchant, url, secret, active, failed, failures, last_attempt, last_status
           FROM webhooks
          WHERE merchant = ? AND active = 1 AND failed = 0
          ORDER BY id DESC`,
      )
      .all(merchant) as unknown as Webhook[];
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
                w.merchant, w.url, w.secret
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

    const now = Math.floor(Date.now() / 1000);
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
      const info = this.db
        .prepare(
          `INSERT INTO webhook_deliveries
             (webhook_id, event_id, idempotency_key, attempt, status, retry_at, payload, created_at)
           VALUES (?, ?, ?, 1, 'pending', ?, ?, ?)`,
        )
        .run(
          webhook.id,
          eventId,
          idempotencyKey,
          now,
          payload,
          now,
        );
      const delivery: DeliveryRow = {
        id: (info.lastInsertRowid as number) ?? 0,
        webhook_id: webhook.id,
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
      await this.attempt(delivery, webhook);
    }
  }

  /** Attempt one delivery once: success marks it delivered, failure
   *  reschedules it with backoff, and five failed attempts mark the
   *  webhook failed. Never throws. */
  private async attempt(delivery: DeliveryRow, webhook: WebhookRow): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", Buffer.from(webhook.secret, "utf8"))
      .update(delivery.payload)
      .digest("hex");
    let httpStatus: number | null = null;
    let responseBody = "";
    let error: string | null = null;
    let ok = false;
    try {
      const init: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": delivery.idempotency_key,
          "Payflow-Signature": `sha256=${signature}`,
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

    if (ok) {
      this.db
        .prepare(
          `UPDATE webhook_deliveries SET status = 'delivered', http_status = ?, response_body = ?, error = NULL WHERE id = ?`,
        )
        .run(httpStatus, responseBody, delivery.id);
      return;
    }

    const nextAttempt = delivery.attempt + 1;
    if (nextAttempt > MAX_ATTEMPTS) {
      this.db
        .prepare(
          `UPDATE webhook_deliveries SET status = 'failed', http_status = ?, response_body = ?, error = ? WHERE id = ?`,
        )
        .run(httpStatus, responseBody, error ?? "delivery failed", delivery.id);
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
      return;
    }

    this.db
      .prepare(
        `UPDATE webhook_deliveries
           SET attempt = ?, retry_at = ?, status = 'pending', error = ?, http_status = ?, response_body = ?
         WHERE id = ?`,
      )
      .run(
        nextAttempt,
        now + backoffSeconds(nextAttempt),
        error,
        httpStatus,
        responseBody,
        delivery.id,
      );
    this.db
      .prepare(
        `UPDATE webhooks SET last_attempt = ?, last_status = ?, failures = failures + 1 WHERE id = ?`,
      )
      .run(now, httpStatus, webhook.id);
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
      await this.attempt(delivery, this.webhookOf(delivery.webhook_id));
      const row = this.db
        .prepare("SELECT status FROM webhook_deliveries WHERE id = ?")
        .get(delivery.id) as { status: string } | undefined;
      if (row?.status === "delivered") delivered += 1;
      else if (row?.status === "failed") failed += 1;
    }
    return { attempted, delivered, failed };
  }

  private webhookOf(webhookId: number): WebhookRow {
    return this.db
      .prepare(
        `SELECT id, merchant, url, secret, active, failed, failures, last_attempt, last_status
           FROM webhooks WHERE id = ?`,
      )
      .get(webhookId) as unknown as WebhookRow;
  }
}
