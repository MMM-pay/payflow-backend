import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { sendApiError } from "./errors.ts";
import { listRawContractEvents } from "../lib/queries.ts";

const PAGE_SIZE = 50;
const SCAN_SIZE = 200;
const MAX_FILTER_LENGTH = 256;

function parseAfter(value: string): [number, string] | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
      !Number.isSafeInteger(decoded[0]) || decoded[0] < 0 ||
      typeof decoded[1] !== "string" || decoded[1].length > 512) return null;
    return [decoded[0], decoded[1]];
  } catch {
    return null;
  }
}

/**
 * The raw table belongs to issue #34. Its topics contain original XDR base64,
 * not a separately indexed name column. Filter on topic 0 in bounded batches
 * instead of changing that storage contract or silently skipping matches.
 * (ledger, event_id) is a stable unique ordering even for events in one tx.
 */
export function rawEventsRouter(db: DatabaseSync): Router {
  const router = Router();
  router.get("/events", (req, res) => {
    const contract = req.query.contract;
    const name = req.query.name;
    const after = req.query.after;
    if (
      Object.keys(req.query).some((key) => !["contract", "name", "after"].includes(key)) ||
      (contract !== undefined && (typeof contract !== "string" || contract.length > MAX_FILTER_LENGTH)) ||
      (name !== undefined && (typeof name !== "string" || name.length > MAX_FILTER_LENGTH)) ||
      (after !== undefined && (typeof after !== "string" || after.length > 1024))
    ) {
      sendApiError(res, req, 400, "invalid_request");
      return;
    }
    const start = after === undefined ? [0, ""] as [number, string] : parseAfter(after as string);
    if (!start) {
      sendApiError(res, req, 400, "invalid_request");
      return;
    }

    const items: Array<{
      contract: string; ledger: number; txHash: string; index: string;
      name: string | null; topics: string[]; data: string; closeTime: number | null;
    }> = [];
    let ledger = start[0];
    let id = start[1];
    let exhausted = false;
    while (items.length <= PAGE_SIZE && !exhausted) {
      const rows = listRawContractEvents(db, ledger, id, contract as string | undefined, SCAN_SIZE);
      if (rows.length < SCAN_SIZE) exhausted = true;
      for (const row of rows) {
        ledger = row.ledger;
        id = row.event_id;
        const topics = JSON.parse(row.topics) as string[];
        let eventName: string | null = null;
        try {
          const first = topics[0];
          if (first !== undefined) {
            const decoded: unknown = scValToNative(xdr.ScVal.fromXDR(first, "base64"));
            if (typeof decoded === "string") eventName = decoded;
          }
        } catch {
          // Malformed/unknown topics remain available in the unfiltered feed.
        }
        if (name !== undefined && eventName !== name) continue;
        items.push({
          contract: row.contract_id,
          ledger: row.ledger,
          txHash: row.tx_hash,
          index: row.event_index,
          name: eventName,
          topics,
          data: row.data,
          closeTime: row.close_time,
        });
        if (items.length > PAGE_SIZE) break;
      }
    }
    const hasMore = items.length > PAGE_SIZE;
    if (hasMore) items.pop();
    // Cursor points to the last returned item, not the last scanned row.
    // This avoids skipping matches when the filtered scan spans multiple batches.
    const last = items.at(-1);
    // Find the event's stable ID from its ledger/index. Issue #34 stores
    // event_index = event_id for RPC events.
    const next = last && (hasMore || !exhausted)
      ? Buffer.from(JSON.stringify([last.ledger, last.index])).toString("base64url")
      : null;
    res.json({ events: items, next });
  });
  return router;
}
