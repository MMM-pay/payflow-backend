import type { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { Router } from "express";
import { getMandateMerchant } from "../lib/queries.ts";
import { num, type DecodedEvent } from "../lib/stellar.ts";
import { sendApiError } from "./errors.ts";

const HEARTBEAT_MS = 25_000;
const MAX_STREAMS = 100;
const STREAM_EVENTS = new Set(["charged", "subscribed", "cancelled", "mandate_ended"]);

function addressesOf(event: DecodedEvent, db: DatabaseSync): {
  subscriber: string | undefined;
  merchant: string | undefined;
} {
  if (event.name === "subscribed" || event.name === "charged") {
    return { subscriber: String(event.topics[1]), merchant: String(event.topics[2]) };
  }
  if (event.name === "mandate_ended") {
    return {
      subscriber: event.data.subscriber === undefined ? undefined : String(event.data.subscriber),
      merchant: String(event.topics[1]),
    };
  }
  return {
    subscriber: String(event.topics[1]),
    merchant: getMandateMerchant(db, num(event.topics[0])),
  };
}

/** Stream projected subscription events without polling the database. */
export function streamRouter(
  events: EventEmitter,
  db: DatabaseSync,
  maxStreams = MAX_STREAMS,
): Router {
  const router = Router();
  events.setMaxListeners(Math.max(events.getMaxListeners(), maxStreams + 1));
  let activeStreams = 0;

  router.get("/stream", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (activeStreams >= maxStreams) {
      res.setHeader("Retry-After", "5");
      sendApiError(res, req, 503, "stream_limit");
      return;
    }

    const merchantFilter = typeof req.query.merchant === "string" ? req.query.merchant : undefined;
    const subscriberFilter =
      typeof req.query.subscriber === "string" ? req.query.subscriber : undefined;

    activeStreams += 1;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(": connected\n\n");

    const onApplied = (event: DecodedEvent): void => {
      try {
        if (!STREAM_EVENTS.has(event.name)) return;
        const addresses = addressesOf(event, db);
        if (merchantFilter && merchantFilter !== addresses.merchant) return;
        if (subscriberFilter && subscriberFilter !== addresses.subscriber) return;
        const data = JSON.stringify(event, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        );
        res.write(`id: ${event.txHash}\nevent: ${event.name}\ndata: ${data}\n\n`);
      } catch {
        cleanup();
      }
    };
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);
    heartbeat.unref();
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      events.off("applied", onApplied);
      activeStreams -= 1;
    };
    events.on("applied", onApplied);
    res.on("close", cleanup);
  });

  return router;
}