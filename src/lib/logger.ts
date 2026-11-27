import pino from "pino";

// Never let a key reach a log aggregator, at the top level or one level down
// (config objects, error objects with an attached config).
export const redact = {
  paths: [
    "*.KEEPER_SECRET",
    "KEEPER_SECRET",
    "*.SEP10_SIGNING_KEY",
    "SEP10_SIGNING_KEY",
    "*.SEP10_JWT_SECRET",
    "SEP10_JWT_SECRET",
    "*.secret",
    "secret",
    "req.headers.authorization",
    "req.headers.cookie",
    'res.headers["set-cookie"]',
  ],
  censor: "[Redacted]",
};

/**
 * A Stellar account (`G...`, 56 characters) or muxed account (`M...`, 69
 * characters). Subscriber and merchant identifiers are accounts; contract ids
 * (`C...`) belong to the protocol, not to a person, and are left alone.
 */
const ACCOUNT = /\b(?:G[A-Z2-7]{55}|M[A-Z2-7]{68})\b/g;

/**
 * An account shortened to its first and last four characters (`GABC...WXYZ`):
 * enough to tell two accounts apart in a log line, not enough to identify
 * the person behind one. Anything that is not an account is returned as is.
 */
export function maskAccount(value: string): string {
  return value.replace(ACCOUNT, (account) => `${account.slice(0, 4)}...${account.slice(-4)}`);
}

/**
 * A client IP address cut to its network: an IPv4 address to its /24
 * (`203.0.113.0`) and an IPv6 address to its /48 (`2001:db8:1::`). Coarse
 * enough not to identify a client, fine enough to spot a noisy network.
 */
export function maskIp(value: string): string {
  const ip = value.trim();
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0`;
  if (ip.includes(":")) {
    const groups = ip.split("::")[0]!.split(":").filter(Boolean);
    return `${groups.slice(0, 3).join(":")}::`;
  }
  return "[Redacted]";
}

/** Headers that name a client's IP address, sent by proxies in front of the API. */
const IP_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip", "forwarded"];

interface SerializedRequest {
  url?: string;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  remoteAddress?: string;
  [key: string]: unknown;
}

const maskValues = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, typeof value === "string" ? maskAccount(value) : value]),
  );

/**
 * The request as an access log line may show it: account identifiers in the
 * path, query and params are masked, the client IP (the socket's and any a
 * proxy forwarded) is cut to its network. pino's standard serializer hands
 * over a fresh object per request, so it is edited in place; its `headers`
 * is the live request's, so that is copied before it is changed.
 */
export function requestForLog(req: SerializedRequest): SerializedRequest {
  if (req.url !== undefined) req.url = maskAccount(req.url);
  if (req.query !== undefined) req.query = maskValues(req.query);
  if (req.params !== undefined) req.params = maskValues(req.params);
  if (req.remoteAddress !== undefined) req.remoteAddress = maskIp(req.remoteAddress);
  if (req.headers !== undefined) {
    const headers = { ...req.headers };
    for (const name of IP_HEADERS) {
      const value = headers[name];
      if (typeof value !== "string") continue;
      headers[name] = name === "forwarded" ? "[Redacted]" : value.split(",").map(maskIp).join(", ");
    }
    if (typeof headers.referer === "string") headers.referer = maskAccount(headers.referer);
    req.headers = headers;
  }
  return req;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "payflow-backend" },
  redact,
});

export type Logger = typeof logger;

/** Create a child logger that includes `component` on every log line. */
export function childLogger(component: string): Logger {
  return logger.child({ component }) as Logger;
}
