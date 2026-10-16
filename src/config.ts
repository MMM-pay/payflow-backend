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

  KEEPER_SECRET: z.string().optional(),
  /**
   * Standby key for zero-downtime rotation. When set, the keeper falls back
   * to it if `KEEPER_SECRET` becomes unusable mid-pass, and accepts it as the
   * new primary on SIGHUP without a restart.
   */
  KEEPER_SECRET_NEXT: z.string().optional(),
  KEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
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
});

export type Config = z.infer<typeof schema>;

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
