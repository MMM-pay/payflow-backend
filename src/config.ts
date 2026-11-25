import { extname } from "node:path";
import { BASE_FEE, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

/** Split a comma-separated URL list, dropping blanks and duplicates. */
function rpcUrls(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const url = part.trim();
    if (url !== "") seen.add(url);
  }
  return [...seen];
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** A host name with an optional port (`example.com`, `localhost:8080`). */
function isDomain(value: string, max: number): boolean {
  return value.length <= max && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(value);
}

const contractId = z
  .string()
  .refine((value) => StrKey.isValidContract(value), "must be a valid Stellar contract ID");
const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value))
  .refine(
    (value) => value === undefined || StrKey.isValidEd25519SecretSeed(value),
    "must be a valid Stellar secret seed",
  );
const postgresUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .url()
    .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol), "must use a postgres URL")
    .optional(),
);

/**
 * A browser origin: `scheme://host` with an optional port, and nothing else.
 *
 * The `Origin` header a browser sends is exactly that shape, so an entry with
 * a path, query, fragment or credentials could never match it. A wildcard
 * host is refused because the CORS middleware compares exact origins and
 * does not expand subdomain patterns.
 */
function parseCorsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid origin (use scheme://host[:port])`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`"${raw}" must use http or https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`"${raw}" must not contain credentials`);
  }
  if (url.hostname.includes("*")) {
    throw new Error(`"${raw}" must not contain a wildcard; list each origin`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`"${raw}" must be an origin only (no path, query or fragment)`);
  }
  return url.origin;
}

/**
 * Resolve `CORS_ORIGIN` to the browser origins allowed to call the API.
 *
 * Every entry is pinned to an exact origin (`https://app.example`), so only
 * that scheme, host and port is reflected. `*` — as the whole value, never
 * beside a list — is the explicit opt-in to allow every origin. An empty
 * value allows none: a deployment that has not listed its frontend refuses
 * cross-origin browser reads instead of exposing the API to every site.
 * SEP-10 paths are exempt and always answer `*`, as that spec requires.
 */
export function corsOrigins(raw: string | string[] | undefined): "*" | string[] {
  if (Array.isArray(raw)) {
    const listed = raw.map((value) => value.trim()).filter((value) => value !== "");
    if (listed.includes("*")) {
      if (listed.length === 1) return "*";
      throw new Error('"*" must be the only value, or list the exact origins');
    }
    return [...new Set(listed.map(parseCorsOrigin))];
  }
  const value = (raw ?? "").trim();
  if (value === "*") return "*";
  const entries = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (entries.includes("*")) {
    throw new Error('"*" must be the only value, or list the exact origins');
  }
  return [...new Set(entries.map(parseCorsOrigin))];
}

const adminTokensSchema = z.array(
  z.object({
    token: z.string().min(16, "each admin token needs at least 16 characters"),
    scopes: z.array(z.enum(["reindex", "keeper", "indexer", "*"])).nonempty().optional(),
    expiresAt: z.number().int().positive().optional(),
  }),
);

const schema = z.object({
  STELLAR_NETWORK: z.string().default("testnet"),
  /** One or more RPC endpoints; the client fails over between them. */
  SOROBAN_RPC_URL: z
    .string()
    .default("https://soroban-testnet.stellar.org")
    .transform(rpcUrls)
    .pipe(
      z
        .array(z.string().refine(isHttpUrl, "must be an http(s) URL"))
        .min(1, "must list at least one URL"),
    ),
  NETWORK_PASSPHRASE: z.string().default("Test SDF Network ; September 2015"),

  PLAN_REGISTRY_ID: contractId,
  VAULT_ID: contractId,
  SUBSCRIPTION_ID: contractId,
  TOKEN_ID: contractId.optional(),

  /** Extra networks to serve beside the default, comma-separated. */
  NETWORKS: z.string().default(""),

  KEEPER_SECRET: optionalSecret,
  /**
   * Standby key for zero-downtime rotation. When set, the keeper falls back
   * to it if `KEEPER_SECRET` becomes unusable mid-pass, and accepts it as the
   * new primary on SIGHUP without a restart.
   */
  KEEPER_SECRET_NEXT: optionalSecret,
  /**
   * Extra channel accounts, comma-separated. Each channel signs and sequences
   * its own transactions (paying its own fees), so one pass can settle in
   * parallel instead of one account at a time. `KEEPER_SECRET` stays the
   * first channel, which keeps single-key setups unchanged. Duplicates of the
   * primary/standby keys or of each other are dropped by the keeper.
   */
  KEEPER_CHANNEL_SECRETS: z
    .string()
    .default("")
    .transform((raw) => raw.split(",").map((part) => part.trim()).filter(Boolean))
    .pipe(
      z.array(
        z
          .string()
          .refine(StrKey.isValidEd25519SecretSeed, "must be a valid Stellar secret seed"),
      ),
    ),
  /** Skip a keeper channel below this total XLM reserve and fee cushion. */
  KEEPER_CHANNEL_MIN_XLM: z
    .string()
    .regex(
      /^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/,
      "must be a non-negative XLM amount with at most 7 decimal places",
    )
    .default("2"),
  /**
   * Most settlement transactions one pass keeps in flight at once (#249).
   * Each in-flight transaction leases its own channel account, so the cap can
   * never exceed the number of channels (`KEEPER_SECRET` plus the distinct
   * `KEEPER_CHANNEL_SECRETS`): a larger value is rejected at startup rather
   * than silently clamped. Unset means one transaction per channel, the
   * behaviour before the cap existed.
   */
  KEEPER_CONCURRENCY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1, "must be at least 1").optional(),
  ),
  /**
   * Seconds a keeper instance's claim on a due charge lasts before another
   * instance may take it over (#249). Claims stop two keepers settling the
   * same mandate; the timeout makes a claim abandoned by a crashed keeper
   * eligible again. It must outlast one settlement (build, simulate, submit,
   * poll), which takes well under a minute.
   */
  KEEPER_CLAIM_TTL_S: z.coerce.number().int().min(60, "must be at least 60 seconds").default(300),
  /**
   * Per-mandate backoff after a failed charge (#248): the wait after the
   * n-th consecutive failure is
   * `min(KEEPER_BACKOFF_BASE_S * KEEPER_BACKOFF_MULTIPLIER^(n-1), KEEPER_BACKOFF_MAX_S)`,
   * less a random share of up to `KEEPER_BACKOFF_JITTER` of it, so mandates
   * that failed together do not all come back at the same instant. Only
   * failures that are the mandate's own (an underfunded vault, a contract
   * refusal) grow the wait; RPC, network and keeper-signer failures retry
   * after the base delay without growing it.
   */
  KEEPER_BACKOFF_BASE_S: z.coerce.number().int().min(1, "must be at least 1 second").default(60),
  KEEPER_BACKOFF_MULTIPLIER: z.coerce.number().min(1, "must be at least 1").default(2),
  KEEPER_BACKOFF_MAX_S: z.coerce
    .number()
    .int()
    .min(1, "must be at least 1 second")
    .max(604_800, "must be at most 604800 seconds (7 days)")
    .default(21_600),
  KEEPER_BACKOFF_JITTER: z.coerce
    .number()
    .min(0, "must be between 0 and 0.5")
    .max(0.5, "must be between 0 and 0.5")
    .default(0.1),
  /** Use charge_many when the deployed contract supports it. */
  KEEPER_BATCH: z.string().default("true").transform((v) => v === "true"),
  /** Mandates per batch transaction, bounded by the contract's supported list size. */
  KEEPER_BATCH_SIZE: z.coerce.number().int().min(2).max(25).default(10),
  KEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Which due mandate to settle first: `oldest` (due date ascending, the
   * historical behaviour) or `largest` (amount descending, to prioritise
   * high-value mandates under a fee budget).
   */
  KEEPER_ORDER: z.enum(["oldest", "largest"]).default("oldest"),
  /**
   * Only settle mandates payable to these merchants, comma-separated
   * `G...` addresses. Empty (the default) settles every merchant's mandates,
   * so an operator running a keeper for their own business can stop paying
   * fees for everyone else's.
   */
  KEEPER_MERCHANTS: z
    .string()
    .default("")
    .transform((raw) => [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))])
    .pipe(
      z.array(
        z.string().refine(StrKey.isValidEd25519PublicKey, "must be a valid Stellar account address"),
      ),
    ),
  KEEPER_FEE_PERCENTILE: z.enum(["50", "60", "70", "80", "90", "95", "99"]).default("90"),
  KEEPER_MAX_FEE: z.coerce
    .bigint()
    .min(BigInt(BASE_FEE), `must be at least BASE_FEE (${BASE_FEE})`)
    .default(100_000n),
  /**
   * Rehearse a pass: every due charge is built and simulated against the
   * RPC exactly as a real pass would, but nothing is signed or submitted —
   * no `sendTransaction`, no backoff changes, no pass history, no metrics.
   * Each mandate's outcome is logged as `simulated`, carrying the
   * simulation's error when the charge would fail. Made for a first run on
   * a new deployment: see what the keeper would do before it costs a fee.
   */
  KEEPER_DRY_RUN: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  KEEPER_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  INDEXER_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * Ledgers one indexing batch reads and applies before the cursor moves
   * (#241). This is the tuning knob for a catch-up: a larger batch means
   * fewer, longer RPC windows and fewer cursor commits; a smaller one keeps
   * each pass short, so a stop or a `SIGHUP` takes effect sooner. It must
   * stay inside the RPC's getEvents window, so 8,000 is the ceiling.
   */
  INDEXER_BATCH_SIZE: z.coerce.number().int().positive().max(8_000).default(8_000),
  INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
  /**
   * A full-history archive that can re-serve ledgers the RPC node no longer
   * keeps. When the stored cursor falls behind the oldest ledger RPC serves
   * (a gap), the archive backfills it before indexing continues. The archive
   * must answer the same getEvents shape as Soroban RPC
   * (`startLedger`, `endLedger`, `limit`, `cursor`). Unset means gaps are
   * reported and refused instead of backfilled.
   */
  ARCHIVE_URL: z
    .string()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .refine((value) => value === undefined || isHttpUrl(value), "must be an http(s) URL"),
  /**
   * Let the indexer advance its cursor past a gap the RPC cannot serve,
   * accepting that history in the gap is lost and the projection will
   * under-report. Without this the indexer refuses to advance past a gap
   * until ARCHIVE_URL is configured.
   */
  ALLOW_GAPS: z.string().default("false").transform((v) => v === "true"),
  /**
   * How often the reconciler re-checks a sample of active mandates against the
   * contract state. An indexer pass can miss an event (RPC gap, bug); this
   * pass repairs drift the projection would otherwise keep forever.
   */
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  /**
   * How many active mandates one reconcile pass samples. Each sampled mandate
   * costs one read-only RPC simulation, so keep this small relative to the
   * interval.
   */
  RECONCILE_SAMPLE_SIZE: z.coerce.number().int().positive().default(25),
  /**
   * How many ledger windows one pass may fetch at once. Events are still
   * applied in ledger order and the cursor advances per applied window; set
   * this to 1 for strictly sequential reads.
   */
  INDEXER_FETCH_CONCURRENCY: z.coerce.number().int().positive().max(16).default(4),
  /**
   * How many ledgers the indexer advances between two `indexer progress`
   * log lines. A catch-up over a long range is otherwise silent between
   * passes that apply no events; this gives operators a steady heartbeat of
   * cursor, lag and rate. `0` turns the progress log off.
   */
  INDEXER_PROGRESS_LEDGERS: z.coerce.number().int().nonnegative().default(10_000),

  /**
   * Days to retain raw contract events before pruning. Events older than this
   * are removed by the prune operation. Set to 0 to keep all events indefinitely.
   * @deprecated Use RAW_EVENT_RETENTION_DAYS for per-table control.
   */
  DATA_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
  /**
   * Days to retain raw contract events (`events` table). Overrides
   * `DATA_RETENTION_DAYS` when set. Set to 0 to keep events indefinitely.
   */
  RAW_EVENT_RETENTION_DAYS: z.coerce.number().int().nonnegative().optional(),
  /**
   * Days to retain keeper charge-attempt logs (`charge_attempts` table).
   * Attempts older than this are pruned automatically on each keeper pass and
   * on demand via the admin prune endpoint. Set to 0 to keep all logs.
   */
  CHARGE_ATTEMPT_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(90),

  PORT: z.coerce.number().int().positive().default(8080),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  METRICS_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  DATABASE_URL: postgresUrl,
  /**
   * Most connections one process opens to PostgreSQL (#263). Every API
   * process and every indexer/keeper process holds its own pool, so the cap
   * must leave room for the others inside the server's max_connections.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  /**
   * How long a query waits for a free pooled connection before it fails
   * (#263). Without a bound, a saturated pool makes every request wait
   * forever and a slow query takes the whole process down with it.
   */
  DATABASE_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * Server-side cap on how long a single statement may run (#263). A query
   * that exceeds it is cancelled by PostgreSQL and answers with an error
   * instead of pinning a connection; the indexer retries on its next pass.
   */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DATABASE_PATH: z.string().default("./payflow.db"),
  /**
   * Comma-separated exact origins a browser may call the API from. Empty
   * (the default) allows none; `*` allows every origin. Validated at startup
   * so a typo fails the boot instead of silently matching no request.
   */
  CORS_ORIGIN: z
    .string()
    .default("")
    .transform((value, ctx) => {
      try {
        return corsOrigins(value);
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          message: err instanceof Error ? err.message : "invalid origin list",
        });
        return z.NEVER;
      }
    }),
  /** Read only to pick the `REQUIRE_HTTPS` default. */
  NODE_ENV: z.string().default("development"),
  /**
   * Reject plaintext HTTP requests (#277). Unset means on when
   * `NODE_ENV=production` (the Docker image sets it) and off otherwise, so
   * local development keeps working over `http://localhost`. The scheme is
   * read from `X-Forwarded-Proto` set by the first proxy hop (Fly, Render).
   */
  REQUIRE_HTTPS: z
    .enum(["true", "false", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v === "true")),
  /** `Strict-Transport-Security` max-age in seconds; 0 disables the header. */
  HSTS_MAX_AGE_S: z.coerce.number().int().nonnegative().default(31_536_000),
  LOG_LEVEL: z.string().default("info"),
  // An empty value means "not set": the shipped .env.example leaves the
  // variable blank, and a container that reads it must not refuse to start
  // over a URL that is not there.
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .union([z.literal(""), z.url()])
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  REDIS_URL: z
    .string()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .refine((value) => value === undefined || isHttpUrl(value) || value.startsWith("redis://") || value.startsWith("rediss://"), "must be a redis(s) URL"),

  ADMIN_TOKEN: z.string().optional(),
  /**
   * Scoped operator tokens, as a JSON array of
   * `{ "token": "...", "scopes": ["reindex" | "keeper" | "indexer" | "*"], "expiresAt": <unix seconds> }`.
   * `scopes` defaults to all; `expiresAt` is optional. `ADMIN_TOKEN` keeps
   * working as a full-access token with no expiry.
   */
  ADMIN_TOKENS: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw || !raw.trim()) return [];
      try {
        const parsed = adminTokensSchema.parse(JSON.parse(raw));
        return parsed;
      } catch (err) {
        ctx.addIssue({ code: "custom", message: `ADMIN_TOKENS must be a JSON array of tokens (${err instanceof Error ? err.message.slice(0, 120) : "invalid"})` });
        return z.NEVER;
      }
    }),

  /**
   * How long a rotated webhook secret keeps signing deliveries beside the new
   * one, in seconds. During the overlap every delivery carries both
   * signatures, so a receiver can switch secrets without a gap; 0 drops the
   * old secret at once (a leak). At most seven days.
   */
  WEBHOOK_SECRET_OVERLAP_S: z.coerce.number().int().min(0).max(604_800).default(86_400),

  /**
   * SEP-10 sign-in (`GET`/`POST /api/auth`). The server account's secret seed
   * signs challenge transactions; its public key is the `SIGNING_KEY` the
   * home domain's stellar.toml publishes. Leave empty to disable sign-in.
   */
  SEP10_SIGNING_KEY: optionalSecret,
  /** HMAC-SHA256 key for the issued JWTs; at least 32 characters. */
  SEP10_JWT_SECRET: z
    .string()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .refine((value) => value === undefined || value.length >= 32, "must be at least 32 characters"),
  /**
   * The home domain clients authenticate to: the challenge's first operation
   * is keyed `<home domain> auth`, which a manage data key caps at 64 bytes.
   */
  SEP10_HOME_DOMAIN: z
    .string()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .refine((value) => value === undefined || isDomain(value, 59), "must be a domain of at most 59 characters"),
  /** The domain serving the auth endpoint; defaults to SEP10_HOME_DOMAIN. */
  SEP10_WEB_AUTH_DOMAIN: z
    .string()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .refine((value) => value === undefined || isDomain(value, 64), "must be a domain of at most 64 characters"),
  /** Lifetime of an issued JWT in seconds; short-lived by design. */
  SEP10_JWT_TTL_S: z.coerce.number().int().min(60).max(86_400).default(3_600),
});

export type Config = z.infer<typeof schema>;

/** How a process sizes and bounds its pool for one PostgreSQL network (#263). */
export interface PoolSettings {
  /** Most connections this process opens at once. */
  max: number;
  /** How long a query waits for a free connection before it fails, in ms. */
  acquireTimeoutMs: number;
  /** Server-side cap on one statement's runtime, in ms. */
  statementTimeoutMs: number;
}

/** One network this instance indexes and serves. */
export interface NetworkConfig {
  /** Route segment (`/api/<name>/...`) and log label. */
  name: string;
  rpcUrl: string | string[];
  networkPassphrase: string;
  planRegistryId: string;
  vaultId: string;
  subscriptionId: string;
  defaultToken?: string | undefined;
  /** Where the indexer starts when its database has no cursor. */
  startLedger: number;
  /** SQLite file holding this network's projection when DATABASE_URL is unset. */
  databasePath: string;
  /** Shared PostgreSQL server, isolated by per-network schema when configured. */
  databaseUrl?: string | undefined;
  /** Sizing and timeouts for this network's PostgreSQL pool (#263). */
  pool?: PoolSettings | undefined;
  /** Full-history archive URL used to backfill a detected gap. */
  archiveUrl?: string | undefined;
  /** Advance the cursor past a gap the RPC cannot serve. */
  allowGaps?: boolean | undefined;
  /** Ledgers between two `indexer progress` log lines; 0 turns them off. */
  progressLedgers?: number | undefined;
  /** Ledgers one indexing batch reads and applies at a time (#241). */
  batchSize?: number | undefined;
  /** How often the indexer loop runs a pass, in milliseconds (#241). */
  indexerIntervalMs?: number | undefined;
}

/**
 * How many signing channels the keeper builds from `config`: `KEEPER_SECRET`
 * (with `KEEPER_SECRET_NEXT` as a standby in the same channel) plus each
 * distinct `KEEPER_CHANNEL_SECRETS` entry, deduplicated exactly as the keeper
 * does. Zero without `KEEPER_SECRET`.
 */
export function keeperChannelCount(
  config: Pick<Config, "KEEPER_SECRET" | "KEEPER_SECRET_NEXT"> & {
    KEEPER_CHANNEL_SECRETS?: readonly string[] | undefined;
  },
): number {
  if (!config.KEEPER_SECRET) return 0;
  const seen = new Set([config.KEEPER_SECRET, config.KEEPER_SECRET_NEXT].filter(Boolean));
  let channels = 1;
  for (const secret of config.KEEPER_CHANNEL_SECRETS ?? []) {
    if (!secret || seen.has(secret)) continue;
    seen.add(secret);
    channels += 1;
  }
  return channels;
}

/**
 * What is wrong with the keeper's backoff settings taken together, or null
 * when they fit (#248). Each value is range-checked by the schema; this
 * checks them against each other: the cap may not sit below the first wait,
 * and a wait may not outlive the attempt log that remembers it — a mandate's
 * newest `charge_attempts` row is its backoff state, so pruning it early
 * would let the mandate retry before its time.
 */
export function keeperBackoffProblem(
  config: Pick<Config, "KEEPER_BACKOFF_BASE_S" | "KEEPER_BACKOFF_MAX_S" | "CHARGE_ATTEMPT_RETENTION_DAYS">,
): string | null {
  if (config.KEEPER_BACKOFF_MAX_S < config.KEEPER_BACKOFF_BASE_S) {
    return (
      `KEEPER_BACKOFF_MAX_S=${config.KEEPER_BACKOFF_MAX_S} is below ` +
      `KEEPER_BACKOFF_BASE_S=${config.KEEPER_BACKOFF_BASE_S}; the cap must be at least the first wait`
    );
  }
  const retentionDays = config.CHARGE_ATTEMPT_RETENTION_DAYS;
  if (retentionDays > 0 && config.KEEPER_BACKOFF_MAX_S > retentionDays * 86_400) {
    return (
      `KEEPER_BACKOFF_MAX_S=${config.KEEPER_BACKOFF_MAX_S} outlasts ` +
      `CHARGE_ATTEMPT_RETENTION_DAYS=${retentionDays}; a backoff must end before its attempt is pruned`
    );
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.KEEPER_ENABLED && !parsed.data.KEEPER_SECRET) {
    throw new Error("KEEPER_ENABLED=true requires KEEPER_SECRET to be set");
  }
  const concurrency = parsed.data.KEEPER_CONCURRENCY;
  if (concurrency !== undefined && parsed.data.KEEPER_SECRET) {
    const channels = keeperChannelCount(parsed.data);
    if (concurrency > channels) {
      // Counts only: a secret never appears in the message.
      throw new Error(
        `KEEPER_CONCURRENCY=${concurrency} exceeds the ${channels} keeper channel account(s) configured ` +
          "(KEEPER_SECRET plus distinct KEEPER_CHANNEL_SECRETS); add channel accounts or lower the cap",
      );
    }
  }
  const backoffProblem = keeperBackoffProblem(parsed.data);
  if (backoffProblem) throw new Error(backoffProblem);
  if (
    parsed.data.SEP10_SIGNING_KEY &&
    (!parsed.data.SEP10_JWT_SECRET || !parsed.data.SEP10_HOME_DOMAIN)
  ) {
    throw new Error("SEP10_SIGNING_KEY requires SEP10_JWT_SECRET and SEP10_HOME_DOMAIN to be set");
  }
  return {
    ...parsed.data,
    REQUIRE_HTTPS: parsed.data.REQUIRE_HTTPS ?? parsed.data.NODE_ENV === "production",
  };
}

/** Route segments have to survive a URL path: lowercase letters, digits, dashes. */
const NETWORK_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Resolve every network to serve: the default one first, configured entirely
 * by the unprefixed variables, then any extra names from `NETWORKS`, each
 * configured by `<NAME>_`-prefixed variables. A name that repeats the default
 * is ignored. The first entry is the network served by unprefixed routes.
 */
export function networkConfigs(config: Config, env: NodeJS.ProcessEnv = process.env): NetworkConfig[] {
  const names: string[] = [];
  const seen = new Set([config.STELLAR_NETWORK]);
  for (const name of config.NETWORKS.split(",").map((n) => n.trim()).filter(Boolean)) {
    if (!NETWORK_NAME.test(name)) {
      throw new Error(
        `Invalid network name "${name}" in NETWORKS: use lowercase letters, digits and dashes, e.g. "mainnet"`,
      );
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  return [
    {
      name: config.STELLAR_NETWORK,
      rpcUrl: config.SOROBAN_RPC_URL,
      networkPassphrase: config.NETWORK_PASSPHRASE,
      planRegistryId: config.PLAN_REGISTRY_ID,
      vaultId: config.VAULT_ID,
      subscriptionId: config.SUBSCRIPTION_ID,
      startLedger: config.INDEXER_START_LEDGER,
      databasePath: config.DATABASE_PATH,
      databaseUrl: config.DATABASE_URL,
    },
    ...names.map((name) => extraNetwork(name, config, env)),
  ].map((network) => ({
    ...network,
    archiveUrl: config.ARCHIVE_URL,
    allowGaps: config.ALLOW_GAPS,
    progressLedgers: config.INDEXER_PROGRESS_LEDGERS,
    // A network may pace its own passes; otherwise it follows the defaults.
    batchSize: network.batchSize ?? config.INDEXER_BATCH_SIZE,
    indexerIntervalMs: network.indexerIntervalMs ?? config.INDEXER_INTERVAL_MS,
    pool: {
      max: config.DATABASE_POOL_MAX,
      acquireTimeoutMs: config.DATABASE_ACQUIRE_TIMEOUT_MS,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    },
  }));
}

function extraNetwork(name: string, base: Config, env: NodeJS.ProcessEnv): NetworkConfig {
  const prefix = name.toUpperCase().replace(/-/g, "_");
  const schema = z.object({
    [`${prefix}_SOROBAN_RPC_URL`]: z.url(),
    [`${prefix}_NETWORK_PASSPHRASE`]: z.string().min(1),
    [`${prefix}_PLAN_REGISTRY_ID`]: contractId,
    [`${prefix}_VAULT_ID`]: contractId,
    [`${prefix}_SUBSCRIPTION_ID`]: contractId,
    [`${prefix}_INDEXER_START_LEDGER`]: z.coerce.number().int().nonnegative().default(0),
    [`${prefix}_INDEXER_BATCH_SIZE`]: z.coerce
      .number()
      .int()
      .positive()
      .max(8_000)
      .optional(),
    [`${prefix}_INDEXER_INTERVAL_MS`]: z.coerce.number().int().positive().optional(),
    [`${prefix}_DATABASE_PATH`]: z.string().min(1).optional(),
  });
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration for network "${name}":\n${issues}`);
  }
  const data = parsed.data as unknown as Record<string, string | number | undefined>;
  const databasePath = data[`${prefix}_DATABASE_PATH`];
  return {
    name,
    rpcUrl: String(data[`${prefix}_SOROBAN_RPC_URL`]),
    networkPassphrase: String(data[`${prefix}_NETWORK_PASSPHRASE`]),
    planRegistryId: String(data[`${prefix}_PLAN_REGISTRY_ID`]),
    vaultId: String(data[`${prefix}_VAULT_ID`]),
    subscriptionId: String(data[`${prefix}_SUBSCRIPTION_ID`]),
    startLedger: Number(data[`${prefix}_INDEXER_START_LEDGER`] ?? 0),
    ...(data[`${prefix}_INDEXER_BATCH_SIZE`] === undefined
      ? {}
      : { batchSize: Number(data[`${prefix}_INDEXER_BATCH_SIZE`]) }),
    ...(data[`${prefix}_INDEXER_INTERVAL_MS`] === undefined
      ? {}
      : { indexerIntervalMs: Number(data[`${prefix}_INDEXER_INTERVAL_MS`]) }),
    databasePath:
      databasePath === undefined ? databasePathFor(base.DATABASE_PATH, name) : String(databasePath),
    databaseUrl: base.DATABASE_URL,
  };
}

/** `./payflow.db` + `mainnet` becomes `./payflow-mainnet.db`, beside the base file. */
function databasePathFor(basePath: string, name: string): string {
  const ext = extname(basePath);
  return `${basePath.slice(0, basePath.length - ext.length)}-${name}${ext}`;
}
