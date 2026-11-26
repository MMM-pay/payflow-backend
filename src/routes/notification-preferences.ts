import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Storage } from "../lib/store/types.ts";
import {
  notificationEventsSchema,
  notificationPreferencesFor,
  parseNotificationEvents,
  saveNotificationPreferences,
} from "../lib/notification-preferences.ts";
import { sessionOf, type Sep10Auth } from "./auth.ts";
import { sendApiError } from "./errors.ts";
import type { MerchantNotificationPreferences } from "./types.ts";
import { queryOnly, validate } from "./validate.ts";

const merchantSchema = z.string().refine(
  (value) => StrKey.isValidEd25519PublicKey(value),
  "must be a Stellar account address",
);
const timestampSchema = z
  .coerce.string()
  .regex(/^\d+$/, "must be a unix timestamp in seconds")
  .transform(Number)
  .refine(Number.isSafeInteger, "must be a unix timestamp in seconds");
const preferencesSchema = z.object({
  events: notificationEventsSchema,
}).strict();
const signedGetSchema = z.object({
  timestamp: timestampSchema,
  signature: z.string().min(1).max(128),
}).strict();
const signedPutSchema = preferencesSchema.extend({
  timestamp: timestampSchema,
  signature: z.string().min(1).max(128),
}).strict();
const SIGNATURE_TOLERANCE_S = 10 * 60;

function fresh(timestamp: number): boolean {
  return Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= SIGNATURE_TOLERANCE_S;
}

function signatureBytes(signature: string): Buffer | null {
  const bytes = Buffer.from(signature, "base64");
  return bytes.length === 64 ? bytes : null;
}

function authorized(
  req: Request,
  res: Response,
  merchant: string,
  message: string,
  signature: string,
  timestamp: number,
): boolean {
  // `details` belongs to `invalid_request` only (see the README's "Error
  // responses" table and the OpenAPI Error schema), so a 401 carries copy
  // but no field list.
  if (!fresh(timestamp)) {
    sendApiError(res, req, 401, "unauthorized", "The signature has expired; sign a fresh timestamp.");
    return false;
  }
  const bytes = signatureBytes(signature);
  if (bytes === null || !Keypair.fromPublicKey(merchant).verify(Buffer.from(message, "utf8"), bytes)) {
    sendApiError(res, req, 401, "unauthorized", "The signature does not prove control of the merchant address.");
    return false;
  }
  return true;
}

function sessionMatches(
  req: Request,
  res: Response,
  auth: Sep10Auth | undefined,
  merchant: string,
): { ok: false } | { ok: true; authenticated: boolean } {
  const session = sessionOf(req, res, auth);
  if (!session.ok) return { ok: false };
  if (session.value !== null && session.value !== merchant) {
    sendApiError(res, req, 401, "unauthorized", "The bearer token was issued for a different account.");
    return { ok: false };
  }
  return { ok: true, authenticated: session.value !== null };
}

function getMessage(merchant: string, timestamp: number): string {
  return `payflow-notification-preferences:get:v1:${merchant}:${timestamp}`;
}

function putMessage(merchant: string, events: string[], timestamp: number): string {
  return `payflow-notification-preferences:set:v1:${merchant}:${[...events].sort().join(",")}:${timestamp}`;
}

export function notificationPreferencesRouter(db: Storage, auth?: Sep10Auth): Router {
  const r = Router();

  r.get(
    "/merchants/:address/notification-preferences",
    queryOnly("timestamp", "signature"),
    async (req, res) => {
    const address = validate(req, res, "address", merchantSchema, req.params.address);
    if (!address.ok) return;
    const session = sessionMatches(req, res, auth, address.value);
    if (!session.ok) return;

    if (session.authenticated) {
      const query = validate(req, res, "query", z.object({}).strict(), req.query);
      if (!query.ok) return;
    } else {
      const proof = validate(req, res, "query", signedGetSchema, req.query);
      if (!proof.ok) return;
      if (!authorized(
        req,
        res,
        address.value,
        getMessage(address.value, proof.value.timestamp),
        proof.value.signature,
        proof.value.timestamp,
      )) return;
    }

    const preferences = await notificationPreferencesFor(db, address.value);
    const body: MerchantNotificationPreferences = {
      merchant: address.value,
      ...preferences,
    };
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
    },
  );

  r.put("/merchants/:address/notification-preferences", queryOnly(), async (req, res) => {
    const address = validate(req, res, "address", merchantSchema, req.params.address);
    if (!address.ok) return;
    const session = sessionMatches(req, res, auth, address.value);
    if (!session.ok) return;

    let events: ReturnType<typeof parseNotificationEvents>;
    if (session.authenticated) {
      const parsed = validate(req, res, "body", preferencesSchema, req.body);
      if (!parsed.ok) return;
      events = parseNotificationEvents(parsed.value.events);
    } else {
      const parsed = validate(req, res, "body", signedPutSchema, req.body);
      if (!parsed.ok) return;
      events = parseNotificationEvents(parsed.value.events);
      if (!authorized(
        req,
        res,
        address.value,
        putMessage(address.value, events, parsed.value.timestamp),
        parsed.value.signature,
        parsed.value.timestamp,
      )) return;
    }

    const updatedAt = await saveNotificationPreferences(db, address.value, events);
    const body: MerchantNotificationPreferences = {
      merchant: address.value,
      events,
      updatedAt,
    };
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
  });

  return r;
}
