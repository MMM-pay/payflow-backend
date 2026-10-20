import { Router } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { WebhookDispatcher } from "../lib/webhooks.ts";
import { sendApiError } from "./errors.ts";
import { addressSchema, validate } from "./validate.ts";

/** A registration proves control of the merchant's Stellar address: the
 *  merchant signs `payflow-webhook:v1:<merchant>:<url>:<timestamp>` with
 *  the address's secret key and sends the base64-encoded ed25519
 *  signature. Only public keys are touched; the secret never reaches the
 *  API. */
const SIGNED_MESSAGE_PREFIX = "payflow-webhook:v1";
/** Registration signatures older than this are refused (replay window). */
const SIGNATURE_TOLERANCE_S = 10 * 60;

const registerSchema = z.object({
  merchant: addressSchema,
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
  /** Base64-encoded ed25519 signature of the signed message. */
  signature: z.string().min(1),
  /** Unix seconds; replay window of ten minutes. Accepts a string or a JSON
   *  number so callers may send either representation. */
  timestamp: z
    .coerce.string()
    .regex(/^\d+$/, "must be a unix timestamp in seconds")
    .transform(Number)
    .refine((value) => Number.isSafeInteger(value), "must be a unix timestamp in seconds"),
});

/** `POST /api/webhooks`: register a URL to receive signed charge events. */
export function webhooksRouter(db: DatabaseSync, dispatcher: WebhookDispatcher): Router {
  const r = Router();

  r.post("/webhooks", async (req, res) => {
    const parsed = validate(req, res, "body", registerSchema, req.body);
    if (!parsed.ok) return;
    const { merchant, url, secret, signature, timestamp } = parsed.value;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_S) {
      sendApiError(res, req, 400, "invalid_request", undefined, [
        { path: "timestamp", message: "must be within ten minutes of the server's clock" },
      ]);
      return;
    }

    const message = `${SIGNED_MESSAGE_PREFIX}:${merchant}:${url}:${timestamp}`;
    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(signature, "base64");
    } catch {
      sendApiError(res, req, 400, "invalid_request", undefined, [
        { path: "signature", message: "must be base64-encoded" },
      ]);
      return;
    }
    if (signatureBytes.length !== 64) {
      sendApiError(res, req, 400, "invalid_request", undefined, [
        { path: "signature", message: "must be a 64-byte ed25519 signature" },
      ]);
      return;
    }

    const valid =
      signatureBytes.length === 64 &&
      (() => {
        try {
          return Keypair.fromPublicKey(merchant).verify(Buffer.from(message, "utf8"), signatureBytes);
        } catch {
          return false;
        }
      })();
    if (!valid) {
      sendApiError(res, req, 400, "invalid_request", undefined, [
        { path: "signature", message: "signature does not prove control of the merchant address" },
      ]);
      return;
    }

    const registration = dispatcher.register(merchant, url, secret);
    res.json({ ...registration, active: true });
  });

  return r;
}
