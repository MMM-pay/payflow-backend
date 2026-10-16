import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Account, FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import type { Config } from "../config.ts";
import { logger } from "./logger.ts";
import { traceRpc } from "./telemetry.ts";
import eventSpecFile from "./event_spec.json" with { type: "json" };

/** The RPC calls the indexer and keeper make. Narrow so tests can fake them. */
export type RpcLike = Pick<
  rpc.Server,
  | "getLatestLedger"
  | "getHealth"
  | "getEvents"
  | "getAccount"
  | "prepareTransaction"
  | "sendTransaction"
  | "getTransaction"
>;

/** Where failover currently stands; reported by /health. */
export interface RpcStatus {
  /** URL of the endpoint calls currently go to. */
  readonly active: string;
  /** Every configured endpoint, in configured order. */
  readonly endpoints: readonly string[];
}

/** Obtains a server handle for a URL; injectable so tests can fake endpoints. */
export type Dial = (url: string) => RpcLike;

/**
 * Hung endpoints must become errors, not promises that never settle, or
 * failover has nothing to react to; the SDK default is no timeout at all.
 */
const RPC_TIMEOUT_MS = 15_000;

function defaultDial(url: string): RpcLike {
  return traceRpc(
    new rpc.Server(url, {
      allowHttp: url.startsWith("http://"),
      timeout: RPC_TIMEOUT_MS,
    }),
  );
}

/**
 * A list of RPC endpoints fronted as one.
 *
 * Calls go to the active endpoint. When a call throws — an outage, a timeout —
 * the next endpoint is tried and, on success, becomes the active one, so a
 * pass that hits a dead provider still makes progress. `getHealth` probes
 * every endpoint and the freshest ledger wins, so a node that is reachable
 * but lagging does not hold the indexer back either.
 */
export class FailoverRpc implements RpcStatus {
  readonly endpoints: readonly string[];
  private readonly servers: RpcLike[];
  private index = 0;

  constructor(urls: readonly string[], dial: Dial = defaultDial) {
    this.endpoints = [...urls];
    this.servers = this.endpoints.map((url) => dial(url));
  }

  get active(): string {
    return this.endpoints[this.index] ?? "";
  }

  /**
   * Call `op` on the active endpoint, then each of the others in turn, until
   * one answers. Every endpoint is tried at most once, so one pass cannot
   * stall retrying a provider that is down; if all fail, the last error is
   * rethrown for the caller's loop to log and retry on the next pass.
   */
  private async run<T>(op: string, call: (server: RpcLike) => Promise<T>): Promise<T> {
    const count = this.servers.length;
    let lastError: unknown;
    for (let attempt = 0; attempt < count; attempt += 1) {
      const i = (this.index + attempt) % count;
      const server = this.servers[i];
      if (server === undefined) continue;
      try {
        const result = await call(server);
        if (i !== this.index) {
          logger.warn(
            { op, from: this.endpoints[this.index], to: this.endpoints[i] },
            "rpc endpoint switched",
          );
          this.index = i;
        }
        return result;
      } catch (err) {
        lastError = err;
        logger.warn({ op, endpoint: this.endpoints[i], err }, "rpc endpoint call failed");
      }
    }
    throw lastError;
  }

  /**
   * Probe every endpoint concurrently and adopt the one whose ledger is
   * furthest ahead; a failing probe is ignored. The probe starts at the
   * current endpoint, so a healthy cluster (or one where the endpoints tie)
   * keeps its active endpoint instead of flapping. If none answer, the first
   * error is rethrown.
   */
  async getHealth(): Promise<rpc.Api.GetHealthResponse> {
    const count = this.servers.length;
    const probes = await Promise.allSettled(this.servers.map((server) => server.getHealth()));
    let best: rpc.Api.GetHealthResponse | undefined;
    let bestIndex = this.index;
    for (let offset = 0; offset < count; offset += 1) {
      const i = (this.index + offset) % count;
      const probe = probes[i];
      if (probe?.status !== "fulfilled") continue;
      if (best === undefined || probe.value.latestLedger > best.latestLedger) {
        best = probe.value;
        bestIndex = i;
      }
    }
    if (best === undefined) {
      const failed = probes.filter((p): p is PromiseRejectedResult => p.status === "rejected");
      throw failed[0]?.reason ?? new Error("all rpc endpoints failed");
    }
    if (bestIndex !== this.index) {
      logger.warn(
        {
          from: this.endpoints[this.index],
          to: this.endpoints[bestIndex],
          latest: best.latestLedger,
        },
        "rpc endpoint is lagging; switched",
      );
      this.index = bestIndex;
    }
    return best;
  }

  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    return this.run("getLatestLedger", (server) => server.getLatestLedger());
  }

  async getEvents(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    return this.run("getEvents", (server) => server.getEvents(request));
  }

  async getAccount(address: string): Promise<Account> {
    return this.run("getAccount", (server) => server.getAccount(address));
  }

  async prepareTransaction(
    tx: Transaction | FeeBumpTransaction,
    useUpgradedAuth?: boolean,
  ): Promise<Transaction> {
    return this.run("prepareTransaction", (server) =>
      server.prepareTransaction(tx, useUpgradedAuth),
    );
  }

  async sendTransaction(
    transaction: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.SendTransactionResponse> {
    return this.run("sendTransaction", (server) => server.sendTransaction(transaction));
  }

  async getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    return this.run("getTransaction", (server) => server.getTransaction(hash));
  }
}

export function makeRpc(config: Config, dial: Dial = defaultDial): FailoverRpc {
  return new FailoverRpc(config.SOROBAN_RPC_URL, dial);
}

/** A contract event flattened into plain JS values. */
export interface DecodedEvent {
  /** snake_case name emitted as topic 0 by the `#[contractevent]` macro. */
  name: string;
  contractId: string;
  ledger: number;
  txHash: string;
  /** Topic values after topic 0, in declaration order. */
  topics: unknown[];
  /** Non-topic fields. The macro emits these as a map by default. */
  data: Record<string, unknown>;
}

/** Field types used by `event_spec.json`, mirroring the Soroban spec. */
export type SpecFieldType =
  | "address"
  | "string"
  | "boolean"
  | "u32"
  | "u64"
  | "i128"
  | "timepoint";

export interface SpecField {
  name: string;
  type: SpecFieldType;
  /** Trailing fields may be absent; contract additions mark old fields optional. */
  optional?: boolean;
}

export interface EventSpec {
  name: string;
  contract: string;
  topics: SpecField[];
  data: SpecField[];
}

/**
 * The committed contract event spec. Event shapes live here instead of being
 * implied by hand-written field reads, so a renamed or retyped contract field
 * is reported rather than silently projected as zero.
 */
export const EVENT_SPECS: Map<string, EventSpec> = new Map(
  (eventSpecFile as { events: EventSpec[] }).events.map((spec) => [spec.name, spec]),
);

/** Does a decoded value fit the spec's field type? Money is never a float. */
function valueMatchesType(value: unknown, type: SpecFieldType): boolean {
  switch (type) {
    case "address":
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "u32":
    case "u64":
    case "i128":
    case "timepoint": {
      if (typeof value === "bigint") {
        return type === "i128" || value >= 0n;
      }
      if (typeof value === "number") {
        return Number.isInteger(value) && (type === "i128" || value >= 0);
      }
      // Numeric strings are how i128 values may arrive from other decoders.
      if (typeof value === "string" && /^[+-]?\d+$/.test(value)) {
        return type === "i128" || !value.startsWith("-");
      }
      return false;
    }
  }
}

/** One decoded event is `null` (absent) when the field was not emitted. */
type FieldValue = { present: true; value: unknown } | { present: false };

function checkFields(kind: "topic" | "data", fields: SpecField[], read: (field: SpecField, index: number) => FieldValue): string[] {
  const problems: string[] = [];
  fields.forEach((field, index) => {
    const slot = read(field, index);
    if (!slot.present) {
      if (!field.optional) {
        problems.push(`${kind} '${field.name}' (${field.type}) is missing`);
      }
      return;
    }
    if (!valueMatchesType(slot.value, field.type)) {
      const shown =
        slot.value === null
          ? "null"
          : Array.isArray(slot.value)
            ? "array"
            : typeof slot.value;
      problems.push(`${kind} '${field.name}' expected ${field.type}, got ${shown}`);
    }
  });
  return problems;
}

/**
 * Validate a decoded event against the contract spec.
 *
 * Returns `null` when the event name is not covered by the spec (a foreign or
 * brand-new event: the indexer ignores those separately), an empty array when
 * the event matches, or one human-readable problem per mismatch — missing
 * fields (a rename looks like this), wrong types, extra fields and extra
 * topics.
 */
export function specProblems(e: DecodedEvent): string[] | null {
  const spec = EVENT_SPECS.get(e.name);
  if (!spec) return null;

  const problems: string[] = [];
  problems.push(
    ...checkFields("topic", spec.topics, (_field, index) =>
      index < e.topics.length ? { present: true, value: e.topics[index] } : { present: false },
    ),
  );
  if (e.topics.length > spec.topics.length) {
    problems.push(
      `unexpected topic at index ${spec.topics.length}; the spec defines ${spec.topics.length}`,
    );
  }

  for (const name of Object.keys(e.data)) {
    if (!spec.data.some((f) => f.name === name)) {
      problems.push(`data field '${name}' is not in the contract spec`);
    }
  }
  problems.push(
    ...checkFields("data", spec.data, (field) =>
      field.name in e.data ? { present: true, value: e.data[field.name] } : { present: false },
    ),
  );
  return problems;
}

/**
 * Decode a raw RPC event.
 *
 * The `#[contractevent]` macro puts the snake_case struct name in topic 0,
 * each `#[topic]` field in the topics that follow, and every remaining field
 * in a map in the data section. Anything that does not match that shape is
 * skipped rather than throwing, so one malformed event cannot stall the
 * indexer.
 */
export function decodeEvent(raw: rpc.Api.EventResponse): DecodedEvent | null {
  try {
    const topics = raw.topic.map((t: xdr.ScVal) => scValToNative(t));
    const [name, ...rest] = topics;
    if (typeof name !== "string") return null;

    const value = scValToNative(raw.value);
    const data =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { value };

    return {
      name,
      contractId: raw.contractId?.toString() ?? "",
      ledger: raw.ledger,
      txHash: raw.txHash,
      topics: rest,
      data,
    };
  } catch {
    return null;
  }
}

/** i128 values arrive as bigint; store them as strings to avoid precision loss. */
export function big(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Math.trunc(value).toString();
  if (typeof value === "string") return value;
  return "0";
}

export function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
