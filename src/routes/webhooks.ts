import { Router, type Request, type Response } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { WebhookDispatcher } from "../lib/webhooks.ts";
import type { WebhookDeliveriesResponse, WebhookListResponse } from "./types.ts";
import { sessionOf, type Sep10Auth } from "./auth.ts";
import { sendApiError } from "./errors.ts";
import { addressSchema, validate } from "./validate.ts";

/** A registration proves control of the merchant's Stellar address: the
 *  merchant signs `payflow-webhook:v1:<merchant>:<url>:<timestamp>` with
 *  the address's secret key and sends the base64-encoded ed25519
 *  signature. Only public keys are touched; the secret never reaches the
 *  API. */
const SIGNED_MESSAGE_PREFIX = "payflow-webhook:v1";
/** Listing signs `payflow-webhook-list:v1:<merchant>:<timestamp>`; a
 *  distinct prefix, so a captured registration or deletion signature can
 *  never be replayed as a listing, or the other way round. */
const LIST_MESSAGE_PREFIX = "payflow-webhook-list:v1";
/** Deletion signs `payflow-webhook-delete:v1:<merchant>:<id>:<timestamp>`. */
const DELETE_MESSAGE_PREFIX = "payflow-webhook-delete:v1";
/** Rotation signs `payflow-webhook-rotate:v1:<merchant>:<id>:<timestamp>`. */
const ROTATE_MESSAGE_PREFIX = "payflow-webhook-rotate:v1";
/** A test event signs `payflow-webhook-test:v1:<merchant>:<id>:<timestamp>`. */
const TEST_MESSAGE_PREFIX = "payflow-webhook-test:v1";
/** The history signs `payflow-webhook-deliveries:v1:<merchant>:<id>:<timestamp>`. */
const DELIVERIES_MESSAGE_PREFIX = "payflow-webhook-deliveries:v1";
/** Registration signatures older than this are refused (replay window). */
const SIGNATURE_TOLERANCE_S = 10 * 60;

/** Unix seconds; accepts a string or a JSON number so callers may send
 *  either representation. */
const timestampSchema = z
  .coerce.string()
  .regex(/^\d+$/, "must be a unix timestamp in seconds")
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value), "must be a unix timestamp in seconds");

/** What a registration asks for, whichever way the caller proves who it is. */
const registrationSchema = z.object({
  url: z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          return ["http:", "https:"].includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      "must be an http(s) URL",
    ),
  /** HMAC key used to sign deliveries; generated when absent. */
  secret: z.string().min(1).max(1_000).optional(),
});

const registerSchema = registrationSchema.extend({
  merchant: addressSchema,
  /** Base64-encoded ed25519 signature of the signed message. */
  signature: z.string().min(1),
  /** Replay window of ten minutes. */
  timestamp: timestampSchema,
});

/** A registration under a SEP-10 token: the merchant is the token's account. */
const sessionRegisterSchema = registrationSchema.extend({ merchant: addressSchema.optional() });

/** The proof a merchant sends to list or delete its webhooks. */
const proofSchema = z.object({
  merchant: addressSchema,
  signature: z.string().min(1),
  timestamp: timestampSchema,
});

/** Under a SEP-10 token a `merchant`, when given, must be the token's account. */
const sessionSchema = z.object({ merchant: addressSchema.optional() });

const idSchema = z.coerce.number().int().positive();

/** Whether `timestamp` is inside the replay window around the server's clock. */
function fresh(timestamp: number): boolean {
  return Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= SIGNATURE_TOLERANCE_S;
}

/** The decoded 64-byte ed25519 signature, or null when it is not one. */
function signatureBytesOf(signature: string): Buffer | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(signature, "base64");
  } catch {
    return null;
  }
  return bytes.length === 64 ? bytes : null;
}

/** Whether `signature` is the merchant's ed25519 signature over `message`. */
function verifies(merchant: string, message: string, signature: Buffer): boolean {
  try {
    return Keypair.fromPublicKey(merchant).verify(Buffer.from(message, "utf8"), signature);
  } catch {
    return false;
  }
}

/**
 * Check a list/delete proof. A wrong, malformed or expired signature is a
 * `401 unauthorized`: the request is well-formed but does not prove
 * control of the merchant address right now. Sends the error and returns
 * false when the proof fails.
 */
function authorized(
  req: Request,
  res: Response,
  merchant: string,
  message: string,
  signature: string,
  timestamp: number,
): boolean {
  if (!fresh(timestamp)) {
    sendApiError(res, req, 401, "unauthorized", "The signature has expired; sign a fresh timestamp.", [
      { path: "timestamp", message: "must be within ten minutes of the server's clock" },
    ]);
    return false;
  }
  const bytes = signatureBytesOf(signature);
  if (bytes === null || !verifies(merchant, message, bytes)) {
    sendApiError(res, req, 401, "unauthorized", "The signature does not prove control of the merchant address.", [
      { path: "signature", message: "signature does not prove control of the merchant address" },
    ]);
    return false;
  }
  return true;
}

/** Answer a SEP-10 session whose account is not the merchant the request names. */
function sendWrongAccount(req: Request, res: Response): void {
  sendApiError(res, req, 401, "unauthorized", "The bearer token was issued for a different account.", [
    { path: "merchant", message: "must be the account the bearer token was issued to" },
  ]);
}

/**
 * The merchant a management request is made for, proven by a SEP-10 bearer
 * token or, without one, by a signature over `messageOf(merchant,
 * timestamp)` read from `raw` (the body or the query). Sends the error and
 * returns null when neither proves it.
 */
function merchantOf(
  req: Request,
  res: Response,
  auth: Sep10Auth | undefined,
  location: "body" | "query",
  raw: unknown,
  messageOf: (merchant: string, timestamp: number) => string,
): string | null {
  const session = sessionOf(req, res, auth);
  if (!session.ok) return null;
  if (session.value !== null) {
    const claimed = validate(req, res, location, sessionSchema, raw ?? {});
    if (!claimed.ok) return null;
    if (claimed.value.merchant !== undefined && claimed.value.merchant !== session.value) {
      sendWrongAccount(req, res);
      return null;
    }
    return session.value;
  }
  const parsed = validate(req, res, location, proofSchema, raw);
  if (!parsed.ok) return null;
  const { merchant, signature, timestamp } = parsed.value;
  return authorized(req, res, merchant, messageOf(merchant, timestamp), signature, timestamp) ? merchant : null;
}

/**
 * `POST /api/webhooks`: register a URL to receive signed charge events.
 * `GET /api/webhooks?merchant=`: list a merchant's webhooks.
 * `DELETE /api/webhooks/:id`: remove one of them.
 * `POST /api/webhooks/:id/rotate`: replace its signing secret.
 * `POST /api/webhooks/:id/test`: send it a signed `ping`.
 * `GET /api/webhooks/:id/deliveries`: its recent delivery attempts.
 *
 * Every route also accepts a SEP-10 JWT (`Authorization: Bearer`, see
 * `auth.ts`) in place of its signed message.
 */
export function webhooksRouter(db: DatabaseSync, dispatcher: WebhookDispatcher, auth?: Sep10Auth): Router {
  const r = Router();

  r.post("/webhooks", async (req, res) => {
    const session = sessionOf(req, res, auth);
    if (!session.ok) return;
    if (session.value !== null) {
      const parsed = validate(req, res, "body", sessionRegisterSchema, req.body ?? {});
      if (!parsed.ok) return;
      const { merchant, url, secret } = parsed.value;
      if (merchant !== undefined && merchant !== session.value) {
        sendWrongAccount(req, res);
        return;
      }
      res.json({ ...dispatcher.register(session.value, url, secret), active: true });
      return;
    }

    const parsed = validate(req, res, "body", registerSchema, req.body);
    if (!parsed.ok) return;
    const { merchant, url, secret, signature, timestamp } = parsed.value;

    if (!fresh(timestamp)) {
      sendApiError(res, req, 400, "invalid_request", undefined, [
        { path: "timestamp", message: "must be within ten minutes of the server's clock" },
      ]);
      return;
    }

    const message = `${SIGNED_MESSAGE_PREFIX}:${merchant}:${url}:${timestamp}`;
    const signatureBytes = signatureBytesOf(signature);
    if (signatureBytes === null) {
      sendApiError(res, req, 400, "invalid_request", undefined, [
        { path: "signature", message: "must be a base64-encoded 64-byte ed25519 signature" },
      ]);
      return;
    }
    if (!verifies(merchant, message, signatureBytes)) {
      sendApiError(res, req, 400, "invalid_request", undefined, [
        { path: "signature", message: "signature does not prove control of the merchant address" },
      ]);
      return;
    }

    const registration = dispatcher.register(merchant, url, secret);
    res.json({ ...registration, active: true });
  });

  /**
   * The merchant's webhooks, newest first, including ones that gave up
   * after failed deliveries (`failed: true`). Secrets are never returned:
   * only their last four characters, so a merchant can tell them apart.
   * The proof travels in the query string: `merchant`, `timestamp` and
   * `signature` over `payflow-webhook-list:v1:<merchant>:<timestamp>`.
   */
  r.get("/webhooks", (req, res) => {
    const merchant = merchantOf(req, res, auth, "query", req.query, (m, t) => `${LIST_MESSAGE_PREFIX}:${m}:${t}`);
    if (merchant === null) return;

    const body: WebhookListResponse = {
      merchant,
      webhooks: dispatcher.listForMerchant(merchant),
    };
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
  });

  /**
   * Delete one of the merchant's webhooks: it receives no further
   * deliveries, including retries already scheduled. The proof is sent as
   * a JSON body (or, for clients that cannot send a DELETE body, the query
   * string): `merchant`, `timestamp` and `signature` over
   * `payflow-webhook-delete:v1:<merchant>:<id>:<timestamp>`. A webhook
   * that does not exist, is already deleted or belongs to another merchant
   * is a 404, so the endpoint does not reveal other merchants' ids.
   */
  r.delete("/webhooks/:id", (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;
    const hasBody =
      typeof req.body === "object" && req.body !== null && Object.keys(req.body as object).length > 0;
    const merchant = merchantOf(
      req,
      res,
      auth,
      hasBody ? "body" : "query",
      hasBody ? req.body : req.query,
      (m, t) => `${DELETE_MESSAGE_PREFIX}:${m}:${id.value}:${t}`,
    );
    if (merchant === null) return;

    if (!dispatcher.deactivate(merchant, id.value)) {
      sendApiError(res, req, 404, "not_found", "No webhook with that id is registered for this merchant.");
      return;
    }
    res.status(204).end();
  });

  /**
   * Replace the webhook's signing secret. The new secret is in this response
   * only; the old one keeps signing beside it (a second `sha256=` in
   * `Payflow-Signature`) until `previousSecretExpiresAt`. The proof is a
   * JSON body signed over `payflow-webhook-rotate:v1:<merchant>:<id>:<timestamp>`.
   */
  r.post("/webhooks/:id/rotate", (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;
    const merchant = merchantOf(req, res, auth, "body", req.body, (m, t) => `${ROTATE_MESSAGE_PREFIX}:${m}:${id.value}:${t}`);
    if (merchant === null) return;

    const rotation = dispatcher.rotateSecret(merchant, id.value);
    if (rotation === null) {
      sendApiError(res, req, 404, "not_found", "No webhook with that id is registered for this merchant.");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(rotation);
  });

  /**
   * Send the webhook a `ping` event, signed and retried exactly like a
   * charge, and answer with how the first attempt went (status code,
   * latency). The proof is a JSON body signed over
   * `payflow-webhook-test:v1:<merchant>:<id>:<timestamp>`.
   */
  r.post("/webhooks/:id/test", async (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;
    const merchant = merchantOf(req, res, auth, "body", req.body, (m, t) => `${TEST_MESSAGE_PREFIX}:${m}:${id.value}:${t}`);
    if (merchant === null) return;

    const result = await dispatcher.ping(merchant, id.value);
    if (result === null) {
      sendApiError(res, req, 404, "not_found", "No webhook with that id is receiving deliveries for this merchant.");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  });

  /**
   * The webhook's last 100 delivery attempts, newest first: event, attempt
   * number, status, HTTP status, error and next retry. A deleted webhook
   * keeps its history. The proof travels in the query string, signed over
   * `payflow-webhook-deliveries:v1:<merchant>:<id>:<timestamp>`.
   */
  r.get("/webhooks/:id/deliveries", (req, res) => {
    const id = validate(req, res, "id", idSchema, req.params.id);
    if (!id.ok) return;
    const merchant = merchantOf(req, res, auth, "query", req.query, (m, t) => `${DELIVERIES_MESSAGE_PREFIX}:${m}:${id.value}:${t}`);
    if (merchant === null) return;

    const deliveries = dispatcher.history(merchant, id.value);
    if (deliveries === null) {
      sendApiError(res, req, 404, "not_found", "No webhook with that id is registered for this merchant.");
      return;
    }
    const body: WebhookDeliveriesResponse = { webhookId: id.value, deliveries };
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
  });

  return r;
}
