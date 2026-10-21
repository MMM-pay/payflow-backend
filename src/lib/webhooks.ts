import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { asStorage } from "./store/index.ts";
import type { Storage } from "./store/types.ts";
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
  db: Storage | DatabaseSync;
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
 * receives events.
 */
export class WebhookDispatcher {
  private readonly db: Storage;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly events: EventEmitter;

  constructor(options: WebhookDispatcherOptions) {
    this.db = asStorage(options.db);
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
  async register(merchant: string, url: string, secret?: string): Promise<WebhookRegistration> {
    const value = secret ?? randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const row = await this.db.get<{ id: number }>(
      `INSERT INTO webhooks (merchant, url, secret, active, failed, failures, created_at)
       VALUES (?, ?, ?, 1, 0, 0, ?) RETURNING id`,
      [merchant, url, value, now],
    );
    if (!row) throw new Error("webhook registration insert returned no id");
    return {
      id: row.id,
      merchant,
      url,
      secret: value,
      active: true,
    };
  }

  /** The active, non-failed webhooks for a merchant, newest first. */
  listWebhooks(merchant: string): Promise<Webhook[]> {
    return this.db.all<Webhook>(
      `SELECT id, merchant, url, secret, active, failed, failures, last_attempt, last_status
         FROM webhooks
        WHERE merchant = ? AND active = 1 AND failed = 0
        ORDER BY id DESC`,
      [merchant],
    );
  }

  /** Deliveries due for retry right now, oldest retry first. */
  async dueDeliveries(now: number = Math.floor(Date.now() / 1000)): Promise<Array<{
    delivery: DeliveryRow;
    webhook: WebhookRow;
  }>> {
    const rows = await this.db.all<{
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
    }>(
        `SELECT d.id, d.webhook_id, d.event_id, d.idempotency_key, d.attempt, d.status,
                d.http_status, d.response_body, d.error, d.payload, d.retry_at, d.created_at,
                w.merchant, w.url, w.secret
           FROM webhook_deliveries d
           JOIN webhooks w ON w.id = d.webhook_id
          WHERE d.status = 'pending' AND d.retry_at <= ? AND w.active = 1 AND w.failed = 0
          ORDER BY d.retry_at
          LIMIT ?`,
      [now, RETRY_BATCH],
    );
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
  deliveries(webhookId: number): Promise<Array<{
    id: number;
    attempt: number;
    status: string;
    http_status: number | null;
    error: string | null;
    retry_at: number;
  }>> {
    return this.db.all(
        `SELECT id, attempt, status, http_status, error, retry_at
           FROM webhook_deliveries
          WHERE webhook_id = ?
          ORDER BY id DESC`,
      [webhookId],
    );
  }

  /** The count of undelivered deliveries for a webhook. */
  async pendingCount(webhookId: number): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ? AND status = 'pending'",
      [webhookId],
    );
    if (!row) throw new Error("webhook pending count query returned no result");
    return row.n;
  }

  /**
   * React to an applied event: every active webhook for the charge's
   * merchant gets a pending delivery and a first delivery attempt.
   */
  async onApplied(e: DecodedEvent): Promise<void> {
    if (e.name !== "charged") return;
    const [mandateId, , merchant] = e.topics;
    const webhooks = await this.listWebhooks(str(merchant));
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
      const row = await this.db.get<{ id: number }>(
        `INSERT INTO webhook_deliveries
           (webhook_id, event_id, idempotency_key, attempt, status, retry_at, payload, created_at)
         VALUES (?, ?, ?, 1, 'pending', ?, ?, ?) RETURNING id`,
        [
          webhook.id,
          eventId,
          idempotencyKey,
          now,
          payload,
          now,
        ],
      );
      if (!row) throw new Error("webhook delivery insert returned no id");
      const delivery: DeliveryRow = {
        id: row.id,
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

  /** Attempt one delivery; failed HTTP requests are retried with backoff,
   *  while persistence errors propagate to the caller. */
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
      await this.db.run(
        `UPDATE webhook_deliveries SET status = 'delivered', http_status = ?, response_body = ?, error = NULL WHERE id = ?`,
        [httpStatus, responseBody, delivery.id],
      );
      return;
    }

    const nextAttempt = delivery.attempt + 1;
    if (nextAttempt > MAX_ATTEMPTS) {
      await this.db.run(
        `UPDATE webhook_deliveries SET status = 'failed', http_status = ?, response_body = ?, error = ? WHERE id = ?`,
        [httpStatus, responseBody, error ?? "delivery failed", delivery.id],
      );
      await this.db.run(
        `UPDATE webhooks SET failed = 1, failures = failures + 1, last_attempt = ?, last_status = ? WHERE id = ?`,
        [now, httpStatus, webhook.id],
      );
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

    await this.db.run(
      `UPDATE webhook_deliveries
         SET attempt = ?, retry_at = ?, status = 'pending', error = ?, http_status = ?, response_body = ?
       WHERE id = ?`,
      [
        nextAttempt,
        now + backoffSeconds(nextAttempt),
        error,
        httpStatus,
        responseBody,
        delivery.id,
      ],
    );
    await this.db.run(
      `UPDATE webhooks SET last_attempt = ?, last_status = ?, failures = failures + 1 WHERE id = ?`,
      [now, httpStatus, webhook.id],
    );
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
    for (const { delivery } of await this.dueDeliveries(now)) {
      attempted += 1;
      await this.attempt(delivery, await this.webhookOf(delivery.webhook_id));
      const row = await this.db.get<{ status: string }>(
        "SELECT status FROM webhook_deliveries WHERE id = ?",
        [delivery.id],
      );
      if (row?.status === "delivered") delivered += 1;
      else if (row?.status === "failed") failed += 1;
    }
    return { attempted, delivered, failed };
  }

  private async webhookOf(webhookId: number): Promise<WebhookRow> {
    const row = await this.db.get<WebhookRow>(
      `SELECT id, merchant, url, secret, active, failed, failures, last_attempt, last_status
         FROM webhooks WHERE id = ?`,
      [webhookId],
    );
    if (!row) throw new Error(`webhook ${webhookId} was not found for delivery`);
    return row;
  }
}
