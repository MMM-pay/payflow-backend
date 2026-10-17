import { extname } from "node:path";
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

  PLAN_REGISTRY_ID: z.string().min(56),
  VAULT_ID: z.string().min(56),
  SUBSCRIPTION_ID: z.string().min(56),
  TOKEN_ID: z.string().min(56).optional(),

  /** Extra networks to serve beside the default, comma-separated. */
  NETWORKS: z.string().default(""),

  KEEPER_SECRET: z.string().optional(),
  /**
   * Standby key for zero-downtime rotation. When set, the keeper falls back
   * to it if `KEEPER_SECRET` becomes unusable mid-pass, and accepts it as the
   * new primary on SIGHUP without a restart.
   */
  KEEPER_SECRET_NEXT: z.string().optional(),
  KEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Which due mandate to settle first: `oldest` (due date ascending, the
   * historical behaviour) or `largest` (amount descending, to prioritise
   * high-value mandates under a fee budget).
   */
  KEEPER_ORDER: z.enum(["oldest", "largest"]).default("oldest"),
  KEEPER_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  INDEXER_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
  /**
   * How many ledger windows one pass may fetch at once. Events are still
   * applied in ledger order and the cursor advances per applied window; set
   * this to 1 for strictly sequential reads.
   */
  INDEXER_FETCH_CONCURRENCY: z.coerce.number().int().positive().max(16).default(4),

  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_PATH: z.string().default("./payflow.db"),
  CORS_ORIGIN: z.string().default("*"),
  LOG_LEVEL: z.string().default("info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  ADMIN_TOKEN: z.string().optional(),

});

export type Config = z.infer<typeof schema>;

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
  /** SQLite file holding this network's projection. */
  databasePath: string;
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
  return parsed.data;
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
    },
    ...names.map((name) => extraNetwork(name, config, env)),
  ];
}

function extraNetwork(name: string, base: Config, env: NodeJS.ProcessEnv): NetworkConfig {
  const prefix = name.toUpperCase().replace(/-/g, "_");
  const schema = z.object({
    [`${prefix}_SOROBAN_RPC_URL`]: z.string().url(),
    [`${prefix}_NETWORK_PASSPHRASE`]: z.string().min(1),
    [`${prefix}_PLAN_REGISTRY_ID`]: z.string().min(56),
    [`${prefix}_VAULT_ID`]: z.string().min(56),
    [`${prefix}_SUBSCRIPTION_ID`]: z.string().min(56),
    [`${prefix}_INDEXER_START_LEDGER`]: z.coerce.number().int().nonnegative().default(0),
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
    databasePath:
      databasePath === undefined ? databasePathFor(base.DATABASE_PATH, name) : String(databasePath),
  };
}

/** `./payflow.db` + `mainnet` becomes `./payflow-mainnet.db`, beside the base file. */
function databasePathFor(basePath: string, name: string): string {
  const ext = extname(basePath);
  return `${basePath.slice(0, basePath.length - ext.length)}-${name}${ext}`;
}
