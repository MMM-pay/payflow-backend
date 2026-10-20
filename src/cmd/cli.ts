/**
 * The operator CLI.
 *
 * The questions an operator asks during an incident — is the projection
 * current, what does mandate 42 look like, what is due right now, force a
 * charge, rebuild the projection — used to need an ad-hoc script or a
 * hand-written SQL query against the projection file. This is the same work
 * behind one command, reading and writing the same tables the service does.
 *
 * Two rules shape it:
 *
 * - **The service's own logic, not a second copy of it.** The commands read
 *   through `lib/queries.ts`, settle through `Keeper` and re-index through
 *   `Indexer`, so the CLI cannot drift away from what the API and the keeper
 *   do. A CLI that re-implemented the queries would be a second projection.
 * - **Nothing destructive happens by accident.** A charge moves a
 *   subscriber's money and a re-index rewrites the projection, so both
 *   refuse to run until the operator says `--yes`.
 *
 * Amounts are printed as the decimal strings the projection stores. A
 * stroop-scale amount does not survive a round trip through a JavaScript
 * number, so it never becomes one.
 *
 * Secrets are never printed. The keeper's public keys are safe to show and
 * its secret seeds are not, so only the former ever reach the output.
 *
 * ### Output is not logging
 *
 * The CLI writes its result to stdout with `process.stdout.write`, not
 * through the pino logger: stdout *is* the interface here, and an operator
 * pipes it into `jq` or reads it in a terminal. The structured logger is for
 * the service's own diagnostics; a CLI whose output is a log line is harder
 * to use than one whose output is a report. Errors go to stderr, so a
 * caller can separate them from the result.
 */
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { networkConfigs, loadConfig, type Config, type NetworkConfig } from "../config.ts";
import { openDatabase, readCursor, writeCursor } from "../lib/db.ts";
import { HttpArchive, makeRpc, type RpcLike } from "../lib/stellar.ts";
import {
  countDueMandates,
  getMandateById,
  getProtocolStats,
  listDueMandates,
  listLatestVaultBalances,
  listMandateCharges,
  planTokensByIds,
} from "../lib/queries.ts";
import { Indexer } from "../indexer.ts";
import { Keeper } from "../keeper.ts";
import { MAX_LIMIT } from "../routes/helpers.ts";

/** Writes one line of output. */
export type Writer = (line: string) => void;

/**
 * The RPC calls the CLI makes.
 *
 * `RpcLike` already covers everything the indexer, the keeper and the
 * status probe need, so one client serves all of them.
 */
export type CliRpc = RpcLike;

/** A failure the operator can act on: a bad argument or a failed operation. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** One option a command understands. */
export interface OptionSpec {
  /** Long name, without the leading dashes. */
  name: string;
  /** Other spellings of the option, such as `-h`. */
  aliases?: string[];
  /** Takes a value; a flag does not. */
  value?: boolean;
  /** Placeholder shown next to the option in the help text. */
  placeholder?: string;
  /** One line describing what the option does. */
  description: string;
}

/** A positional argument a command takes. */
export interface PositionalSpec {
  /** Name shown in the usage line. */
  name: string;
  /** One line describing the argument. */
  description: string;
}

/** Everything the parser and the help text need to know about a command. */
export interface CommandSpec {
  /** The word the operator types. */
  name: string;
  /** One line describing the command. */
  summary: string;
  /** The argument part of the usage line. */
  usage: string;
  /** Positional arguments, in order. */
  positionals: PositionalSpec[];
  /** Options the command adds to the common ones. */
  options: OptionSpec[];
  /** Extra lines under the generated help. */
  notes?: string[];
}

/**
 * The collaborators the CLI uses.
 *
 * Every one of them has a production default and can be replaced in a test,
 * so the commands themselves are exercised without a network, a database
 * file or a clock.
 */
export interface CliDeps {
  /** The validated environment configuration. */
  config: Config;
  /** Every network this instance knows about; the first is the default. */
  networks: NetworkConfig[];
  /** Opens a projection database. Defaults to `openDatabase`. */
  openDb?: (path: string) => DatabaseSync;
  /** Builds the RPC client for a network. Defaults to `makeRpc`. */
  rpc?: (network: NetworkConfig) => CliRpc;
  /** The current time, in unix seconds. */
  now?: () => number;
  /** Writes a line of the result. Defaults to stdout. */
  write?: Writer;
  /** Writes a line of diagnostics. Defaults to stderr. */
  writeError?: Writer;
}

/** The options a command understands, after parsing. */
export interface ParsedArgs {
  /** Positional arguments, in the order they were given. */
  positionals: string[];
  /** Option values by long name; `true` for a flag. */
  options: Record<string, string | true>;
}

/** Options every command understands. */
const COMMON_OPTIONS: OptionSpec[] = [
  {
    name: "network",
    value: true,
    placeholder: "<name>",
    description: "Network to operate on (default: the first configured one)",
  },
  {
    name: "database",
    value: true,
    placeholder: "<path>",
    description: "Projection database to read (default: the network's own)",
  },
  { name: "json", description: "Print the result as JSON" },
  { name: "help", aliases: ["-h"], description: "Show this help" },
];

/** The commands the CLI offers, in the order the help lists them. */
const COMMAND_LIST: CommandSpec[] = [
  {
    name: "status",
    summary: "Show the indexer's and the API's health for a network",
    usage: "status",
    positionals: [],
    options: [
      {
        name: "api",
        value: true,
        placeholder: "<url>",
        description: "Probe a running API instance's /health and include its answer",
      },
      {
        name: "offline",
        description: "Do not call the RPC; report the projection as it stands",
      },
    ],
    notes: [
      "The projection is read from the database; the RPC is only asked for the",
      "latest ledger, and an unreachable node is reported rather than fatal.",
    ],
  },
  {
    name: "mandate",
    summary: "Show one mandate and the charges it has settled",
    usage: "mandate <id>",
    positionals: [{ name: "<id>", description: "On-chain mandate id (a positive integer)" }],
    options: [
      {
        name: "limit",
        value: true,
        placeholder: "<n>",
        description: "How many charges to show (default 10, max 200)",
      },
    ],
    notes: [
      "Reads the projection only: no RPC call, no transaction.",
      "Amounts are the decimal strings the projection stores.",
    ],
  },
  {
    name: "due",
    summary: "List the mandates that are due for charging",
    usage: "due",
    positionals: [],
    options: [
      {
        name: "limit",
        value: true,
        placeholder: "<n>",
        description: `How many mandates to list (default 50, max ${MAX_LIMIT})`,
      },
    ],
    notes: [
      "Reads the projection only: no RPC call, no transaction.",
      "`funded` compares the last indexed vault balance with the amount, as",
      "bigints: an amount never round-trips through a JavaScript number.",
    ],
  },
  {
    name: "charge",
    summary: "Trigger a charge for one mandate",
    usage: "charge <id>",
    positionals: [{ name: "<id>", description: "On-chain mandate id (a positive integer)" }],
    options: [{ name: "yes", description: "Confirm: charge the mandate and pay the fee" }],
    notes: [
      "Needs KEEPER_SECRET: the charge is signed with it, exactly as the",
      "keeper signs a scheduled pass. The secret is never printed.",
      "The command refuses to run without --yes, because a charge moves a",
      "subscriber's money and spends a fee.",
      "With KEEPER_DRY_RUN=true the charge is simulated and nothing is",
      "submitted; the command then reports `simulated`.",
    ],
  },
  {
    name: "reindex",
    summary: "Rebuild the indexed projection from a ledger",
    usage: "reindex",
    positionals: [],
    options: [
      {
        name: "from",
        value: true,
        placeholder: "<ledger>",
        description: "Ledger to restart from (default: the network's start ledger)",
      },
      { name: "yes", description: "Confirm: move the cursor back and re-apply events" },
      {
        name: "skip-ahead",
        description: "Allow --from to move the cursor forward, leaving the ledgers in between unapplied",
      },
    ],
    notes: [
      "Re-indexing is safe: every write is an idempotent upsert or an",
      "INSERT OR IGNORE, so applying the same ledger range twice leaves the",
      "projection unchanged. The cursor is written back only after a whole",
      "window is applied, so an interrupted run resumes where it stopped.",
      "The command refuses to run without --yes, because it rewrites the",
      "projection and moves the cursor.",
      "Moving the cursor forward is refused as well: the ledgers in between",
      "would never be applied, and the indexer would not notice the gap it",
      "leaves. --skip-ahead accepts it.",
    ],
  },
];

/** The commands by name. */
const COMMANDS: Map<string, CommandSpec> = new Map(
  COMMAND_LIST.map((spec) => [spec.name, spec]),
);

/** The help text of the CLI itself. */
export function helpText(): string {
  const width = Math.max(...COMMAND_LIST.map((spec) => spec.name.length));
  const commands = COMMAND_LIST.map(
    (spec) => `  ${spec.name.padEnd(width)}  ${spec.summary}`,
  ).join("\n");
  return [
    "Usage: npm run cli -- <command> [options]",
    "",
    "Operator CLI for the Payflow backend: the common incident tasks, without",
    "ad-hoc SQL.",
    "",
    "Commands:",
    commands,
    "",
    "Options:",
    ...COMMON_OPTIONS.map((option) => `  ${optionLine(option)}`),
    "",
    "Run 'npm run cli -- <command> --help' for a command's own arguments.",
    "",
    "Amounts are printed as the decimal strings the projection stores: they are",
    "never converted to JavaScript numbers. Secrets are never printed.",
  ].join("\n");
}

/** The help text of one command. */
export function commandHelp(spec: CommandSpec): string {
  const lines: string[] = [
    `Usage: npm run cli -- ${spec.usage} [options]`,
    "",
    spec.summary,
  ];
  if (spec.positionals.length > 0) {
    lines.push("", "Arguments:");
    const width = Math.max(...spec.positionals.map((p) => p.name.length));
    for (const positional of spec.positionals) {
      lines.push(`  ${positional.name.padEnd(width)}  ${positional.description}`);
    }
  }
  lines.push("", "Options:");
  for (const option of [...spec.options, ...COMMON_OPTIONS]) {
    lines.push(`  ${optionLine(option)}`);
  }
  if (spec.notes && spec.notes.length > 0) {
    lines.push("", ...spec.notes);
  }
  return lines.join("\n");
}

/** One option as it appears in the help text. */
function optionLine(option: OptionSpec): string {
  const spellings = [`--${option.name}`, ...(option.aliases ?? [])].join(", ");
  const flag = `${spellings}${option.value ? ` ${option.placeholder ?? "<value>"}` : ""}`;
  return `${flag.padEnd(24)}${option.description}`;
}

/**
 * Parse a command's arguments.
 *
 * The option names come from the command's spec, so an unknown option is an
 * error rather than a silently ignored typo — and the help text is
 * generated from the same spec, so the two cannot disagree.
 */
export function parseArgs(argv: string[], spec: CommandSpec): ParsedArgs {
  const byName = new Map<string, OptionSpec>();
  const byAlias = new Map<string, OptionSpec>();
  for (const option of [...spec.options, ...COMMON_OPTIONS]) {
    byName.set(option.name, option);
    for (const alias of option.aliases ?? []) byAlias.set(alias, option);
  }
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      const name = equals === -1 ? body : body.slice(0, equals);
      const option = byName.get(name);
      if (!option) throw new CliError(`unknown option '--${name}'`);
      if (!option.value) {
        if (equals !== -1) throw new CliError(`option '--${name}' does not take a value`);
        options[option.name] = true;
        continue;
      }
      let value: string;
      if (equals !== -1) {
        value = body.slice(equals + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new CliError(`option '--${name}' needs a value`);
        }
        value = next;
        i += 1;
      }
      options[option.name] = value;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const option = byAlias.get(token);
      if (!option) throw new CliError(`unknown option '${token}'`);
      if (option.value) throw new CliError(`option '${token}' needs a value`);
      options[option.name] = true;
      continue;
    }
    positionals.push(token);
  }

  return { positionals, options };
}

/** The value of an option, when it is one. */
function optionValue(options: Record<string, string | true>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

/** Whether a flag was given. */
function flag(options: Record<string, string | true>, name: string): boolean {
  return options[name] === true;
}

/** A positive integer option or positional argument. */
function positiveInt(raw: string, what: string): number {
  if (!/^\d+$/.test(raw)) throw new CliError(`${what} must be a positive integer, got '${raw}'`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CliError(`${what} must be a positive integer, got '${raw}'`);
  }
  return value;
}

/** A non-negative integer option. */
function nonNegativeInt(raw: string, what: string): number {
  if (!/^\d+$/.test(raw)) throw new CliError(`${what} must be a non-negative integer, got '${raw}'`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new CliError(`${what} must be a non-negative integer, got '${raw}'`);
  }
  return value;
}

/** A bounded count. */
function boundedInt(raw: string | undefined, what: string, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = positiveInt(raw, what);
  return Math.min(value, max);
}

/** The network a command operates on. */
function resolveNetwork(deps: CliDeps, options: Record<string, string | true>): NetworkConfig {
  const networks = deps.networks;
  const first = networks[0];
  if (!first) throw new CliError("no network is configured");
  const name = optionValue(options, "network");
  if (name === undefined) return first;
  const found = networks.find((network) => network.name === name);
  if (!found) {
    throw new CliError(
      `unknown network '${name}'; configured networks: ${networks.map((n) => n.name).join(", ")}`,
    );
  }
  return found;
}

/** The projection a command reads. */
function databasePath(network: NetworkConfig, options: Record<string, string | true>): string {
  return optionValue(options, "database") ?? network.databasePath;
}

/** The UTC time of a unix timestamp. */
function isoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Everything a command implementation needs. */
interface CommandContext {
  deps: CliDeps;
  spec: CommandSpec;
  args: ParsedArgs;
  write: Writer;
  writeError: Writer;
  network: NetworkConfig;
  now: number;
}

/** Print the result as JSON, when the operator asked for it. */
function emitJson(context: CommandContext, payload: unknown): void {
  context.write(JSON.stringify(payload, null, 2));
}

/**
 * `status`: the indexer's and the API's health for a network.
 *
 * The projection is read from the database, so the command works when the
 * RPC is down — that is exactly when an operator needs it. The RPC is only
 * asked for the latest ledger, and a failure is reported, not fatal.
 */
async function statusCommand(context: CommandContext): Promise<number> {
  const { deps, args, write } = context;
  const openDb = deps.openDb ?? openDatabase;
  const db = openDb(databasePath(context.network, args.options));
  try {
    const stats = getProtocolStats(db, context.now - 86_400);
    const due = countDueMandates(db, context.now);
    const cursor = stats.lastIndexedLedger;

    let latest: number | null = null;
    let rpcError: string | null = null;
    const offline = flag(args.options, "offline");
    if (!offline) {
      const rpc = (deps.rpc ?? makeRpc)(context.network);
      try {
        const response = await rpc.getLatestLedger();
        latest = response.sequence;
      } catch (err) {
        rpcError = err instanceof Error ? err.message : String(err);
      }
    }

    const lag = latest === null ? null : Math.max(0, latest - cursor);
    const keeper = keeperSummary(deps, db);

    const apiUrl = optionValue(args.options, "api");
    const api = apiUrl === undefined ? null : await probeApi(apiUrl);

    const payload = {
      network: context.network.name,
      database: databasePath(context.network, args.options),
      rpc: {
        endpoints: rpcEndpoints(context.network),
        latestLedger: latest,
        error: rpcError,
        probed: !offline,
      },
      projection: {
        cursor,
        latestLedger: latest,
        lag,
        status: lag === null ? "unknown" : lag <= 120 ? "ok" : "catching_up",
        dueMandates: due,
      },
      counts: {
        plans: stats.plans,
        mandates: stats.mandates,
        activeMandates: stats.activeMandates,
        charges: stats.charges,
        activeMerchants: stats.activeMerchants,
        volume24h: stats.volume24h,
        volumeAllTime: stats.volumeAllTime,
        totalFees: stats.totalFees,
      },
      keeper,
      api,
    };

    if (flag(args.options, "json")) {
      emitJson(context, payload);
      return 0;
    }

    const endpoints = rpcEndpoints(context.network);
    write(`network:      ${context.network.name}`);
    write(`database:     ${payload.database}`);
    write(`contracts:    plan ${context.network.planRegistryId}`);
    write(`              vault ${context.network.vaultId}`);
    write(`              subscription ${context.network.subscriptionId}`);
    if (offline) {
      write(`rpc:          not probed (--offline)`);
    } else if (rpcError !== null) {
      write(`rpc:          ${endpoints.join(", ")} — unreachable: ${rpcError}`);
    } else {
      write(`rpc:          ${endpoints.join(", ")} — latest ledger ${latest}`);
    }
    write(
      `projection:   cursor ${cursor}` +
        (lag === null ? ", lag unknown" : `, latest ${latest}, lag ${lag} (${payload.projection.status})`),
    );
    write(
      `counts:       ${stats.plans} plans, ${stats.mandates} mandates (${stats.activeMandates} active), ${stats.charges} charges`,
    );
    write(`due now:      ${due}`);
    write(`keeper:       ${keeper.summary}`);
    if (api !== null) {
      write(`api:          ${api.summary}`);
      // The running indexer knows things the projection does not: whether it
      // is held back, what it last failed on, how many events it rejected.
      const live = api.health?.indexer ?? null;
      if (live !== null) {
        write(
          `  indexer:    cursor ${live.cursor ?? "?"}, latest ${live.latestLedger ?? "?"}, lag ${
            live.lag ?? "unknown"
          }${live.paused ? ", paused" : ""}`,
        );
        if (live.freshnessSeconds !== null) {
          write(`  freshness:  ${live.freshnessSeconds}s`);
        }
        if (live.lastRunAt !== null) {
          write(`  last run:   ${live.lastRunAt}`);
        }
        if (live.lastError !== null) {
          write(`  last error: ${live.lastError}`);
        }
        if (live.mismatchedEvents !== null && live.mismatchedEvents > 0) {
          write(`  mismatched: ${live.mismatchedEvents} event(s) failed validation`);
        }
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

/** The RPC endpoints of a network. */
function rpcEndpoints(network: NetworkConfig): string[] {
  return typeof network.rpcUrl === "string"
    ? network.rpcUrl.split(",").map((url) => url.trim()).filter(Boolean)
    : [...network.rpcUrl];
}

/** What the keeper is configured to do, without naming a secret. */
function keeperSummary(
  deps: CliDeps,
  db: DatabaseSync,
): { configured: boolean; summary: string; publicKey: string | null; channels: number | null; dryRun: boolean } {
  const dryRun = deps.config.KEEPER_DRY_RUN;
  if (!deps.config.KEEPER_SECRET) {
    return {
      configured: false,
      summary: `not configured (no KEEPER_SECRET)${dryRun ? ", dry run on" : ""}`,
      publicKey: null,
      channels: null,
      dryRun,
    };
  }
  try {
    // The keeper's own view of its channels: the public key it signs with
    // and how many signing lanes it has. The secret itself is never read
    // out of the config here.
    const keeper = new Keeper(db, {} as CliRpc, deps.config);
    const summary = `${keeper.channelCount} channel(s), signing with ${keeper.publicKey}${
      dryRun ? ", dry run on" : ""
    }`;
    return {
      configured: true,
      summary,
      publicKey: keeper.publicKey,
      channels: keeper.channelCount,
      dryRun,
    };
  } catch (err) {
    return {
      configured: false,
      summary: `unusable (${err instanceof Error ? err.message : String(err)})`,
      publicKey: null,
      channels: null,
      dryRun,
    };
  }
}

/**
 * The live indexer's health, as the API reports it.
 *
 * The running service is the only place this exists: the projection holds
 * the cursor, but not whether the indexer is paused, what it last failed on
 * or how many events failed validation.
 */
export interface ApiIndexerHealth {
  /** The ledger the indexer has applied up to. */
  cursor: number | null;
  /** The ledger the network is on. */
  latestLedger: number | null;
  /** How far behind the indexer is. */
  lag: number | null;
  /** True when the indexer loop is held back at runtime. */
  paused: boolean;
  /** How long ago the network's last ledger closed. */
  freshnessSeconds: number | null;
  /** When the indexer last ran. */
  lastRunAt: string | null;
  /** The last error the indexer ran into. */
  lastError: string | null;
  /** Contract events that failed validation. */
  mismatchedEvents: number | null;
  /** Reconcile passes run. */
  reconciliations: number | null;
  /** Mandate rows the reconciler corrected. */
  corrections: number | null;
}

/** What the API's `/health` says, as far as the CLI reads it. */
export interface ApiHealth {
  /** The API's own verdict: `ok`, `catching_up` or `starting`. */
  status: string;
  /** The network the API serves. */
  network: string | null;
  /** The live indexer's health, when the API runs one. */
  indexer: ApiIndexerHealth | null;
}

/** A number in a JSON body, when the body holds one. */
function jsonNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A string in a JSON body, when the body holds one. */
function jsonString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Read the API's `/health` body.
 *
 * The body is the API's own `HealthResponse`, but the CLI reads it from an
 * HTTP response whose shape it does not control: an older API, a proxy or a
 * different service may answer with something else. Every field is therefore
 * optional, and a body that is not a health report at all yields the API's
 * verdict alone.
 */
export function parseApiHealth(body: unknown): ApiHealth {
  const raw = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;
  const rawIndexer =
    typeof raw.indexer === "object" && raw.indexer !== null
      ? (raw.indexer as Record<string, unknown>)
      : null;
  return {
    status: jsonString(raw.status) ?? "unknown",
    network: jsonString(raw.network),
    indexer:
      rawIndexer === null
        ? null
        : {
            cursor: jsonNumber(rawIndexer.cursor),
            latestLedger: jsonNumber(rawIndexer.latestLedger),
            lag: jsonNumber(rawIndexer.lag),
            paused: rawIndexer.paused === true,
            freshnessSeconds: jsonNumber(rawIndexer.freshnessSeconds),
            lastRunAt: jsonString(rawIndexer.lastRunAt),
            lastError: jsonString(rawIndexer.lastError),
            mismatchedEvents: jsonNumber(rawIndexer.mismatchedEvents),
            reconciliations: jsonNumber(rawIndexer.reconciliations),
            corrections: jsonNumber(rawIndexer.corrections),
          },
  };
}

/**
 * Ask a running API instance how it sees itself.
 *
 * The probe is best effort: an API that is not running is a fact the
 * operator wants to know, not a failure of the command.
 */
async function probeApi(url: string): Promise<{
  url: string;
  reachable: boolean;
  summary: string;
  health: ApiHealth | null;
}> {
  const target = url.endsWith("/health") ? url : `${url.replace(/\/$/, "")}/health`;
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(5_000) });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A body that is not JSON is not a health report; the verdict below is
      // all that can be said about it.
    }
    const health = parseApiHealth(body);
    const summary = `${health.status}${health.network ? ` on ${health.network}` : ""}`;
    return { url: target, reachable: response.ok, summary: `${target} — ${summary}`, health };
  } catch (err) {
    return {
      url: target,
      reachable: false,
      summary: `${target} — unreachable: ${err instanceof Error ? err.message : String(err)}`,
      health: null,
    };
  }
}

/**
 * `mandate <id>`: one mandate and the charges it has settled.
 *
 * Reads the projection only: no RPC call, no transaction.
 */
function mandateCommand(context: CommandContext): Promise<number> {
  const { deps, args, write } = context;
  const id = positiveInt(context.args.positionals[0] ?? "", "the mandate id");
  const openDb = deps.openDb ?? openDatabase;
  const db = openDb(databasePath(context.network, args.options));
  try {
    const mandate = getMandateById(db, id);
    if (!mandate) {
      throw new CliError(`no mandate ${id} in the ${context.network.name} projection`);
    }
    const token = planTokensByIds(db, [mandate.plan_id]).get(mandate.plan_id) ?? null;
    const limit = boundedInt(optionValue(args.options, "limit"), "--limit", 10, MAX_LIMIT);
    const charges = listMandateCharges(db, id, limit);

    const payload = {
      network: context.network.name,
      mandate: { ...mandate, token },
      charges,
    };
    if (flag(args.options, "json")) {
      emitJson(context, payload);
      return Promise.resolve(0);
    }

    write(`mandate ${mandate.id}`);
    write(`  subscriber:   ${mandate.subscriber}`);
    write(`  merchant:     ${mandate.merchant}`);
    write(`  plan:         ${mandate.plan_id}${token ? ` (token ${token})` : ""}`);
    write(`  amount:       ${mandate.amount}`);
    write(`  period:       ${mandate.period} seconds`);
    write(`  fee:          ${mandate.fee_bps} bps`);
    write(`  status:       ${mandate.status}${mandate.ended_by ? ` (ended by ${mandate.ended_by})` : ""}`);
    write(
      `  charges:      ${mandate.charges_made} made${
        mandate.max_charges > 0 ? ` of at most ${mandate.max_charges}` : ""
      }`,
    );
    write(`  next charge:  ${mandate.next_charge} (${isoTime(mandate.next_charge)})`);
    write(`  last charge:  ${mandate.last_charge}`);
    write(`  ledger:       ${mandate.ledger}`);
    if (charges.length === 0) {
      write("  charges:      none");
    } else {
      write(`  charges (${charges.length}):`);
      for (const charge of charges) {
        write(
          `    ${charge.tx_hash}  amount ${charge.amount}  fee ${charge.fee}  ledger ${charge.ledger}  ${isoTime(
            Math.floor(charge.created_at / 1000),
          )}`,
        );
      }
    }
    return Promise.resolve(0);
  } finally {
    db.close();
  }
}

/**
 * `due`: the mandates that are due for charging.
 *
 * The same rows the API's `/due` returns: the projection's due mandates,
 * each with the `funded` flag the last indexed vault balance gives.
 */
function dueCommand(context: CommandContext): Promise<number> {
  const { deps, args, write } = context;
  const openDb = deps.openDb ?? openDatabase;
  const db = openDb(databasePath(context.network, args.options));
  try {
    const limit = boundedInt(optionValue(args.options, "limit"), "--limit", 50, MAX_LIMIT);
    const rows = listDueMandates(db, context.now, limit);
    const tokens = planTokensByIds(db, rows.map((row) => row.plan_id));
    const balances = listLatestVaultBalances(db, rows.map((row) => row.subscriber));

    const due = rows.map((row) => {
      const token = tokens.get(row.plan_id);
      const balance = token ? balances.get(row.subscriber)?.get(token) : undefined;
      return {
        id: row.id,
        subscriber: row.subscriber,
        merchant: row.merchant,
        next_charge: row.next_charge,
        amount: row.amount,
        // Amounts are compared as bigints: a balance is a decimal string in
        // the token's smallest unit and must never round-trip through a
        // JavaScript number.
        funded: balance !== undefined && BigInt(balance) >= BigInt(row.amount),
      };
    });

    if (flag(args.options, "json")) {
      emitJson(context, { network: context.network.name, now: context.now, due });
      return Promise.resolve(0);
    }

    if (due.length === 0) {
      write("no mandate is due for charging");
      return Promise.resolve(0);
    }
    write(`${due.length} mandate(s) due for charging:`);
    for (const row of due) {
      write(
        `  ${row.id}  ${row.subscriber}  ${row.merchant}  amount ${row.amount}  due ${row.next_charge} (${isoTime(
          row.next_charge,
        )})  funded ${row.funded ? "yes" : "no"}`,
      );
    }
    return Promise.resolve(0);
  } finally {
    db.close();
  }
}

/**
 * `charge <id>`: settle one mandate now.
 *
 * The charge is built, signed and submitted by the keeper itself, so it
 * goes through the same code path as a scheduled pass — the same fee
 * selection, the same key rotation, the same scrubbing of secrets from
 * errors. The command adds the confirmation gate and the report.
 */
async function chargeCommand(context: CommandContext): Promise<number> {
  const { deps, args, write } = context;
  const id = positiveInt(context.args.positionals[0] ?? "", "the mandate id");
  if (!flag(args.options, "yes")) {
    throw new CliError(
      "refusing to charge without --yes: a charge moves a subscriber's money and spends a fee",
    );
  }
  if (!deps.config.KEEPER_SECRET) {
    throw new CliError("KEEPER_SECRET is not set; the charge cannot be signed");
  }

  const openDb = deps.openDb ?? openDatabase;
  const db = openDb(databasePath(context.network, args.options));
  const asJson = flag(args.options, "json");
  try {
    const mandate = getMandateById(db, id);
    if (!mandate) {
      throw new CliError(`no mandate ${id} in the ${context.network.name} projection`);
    }
    // The report is JSON when the operator asked for it, so nothing else is
    // written to stdout: the output has to stay parseable.
    if (!asJson) {
      if (mandate.next_charge > context.now) {
        write(
          `note: mandate ${id} is not due until ${mandate.next_charge} (${isoTime(mandate.next_charge)}); the contract may refuse the charge`,
        );
      }
      write(
        `charging mandate ${id} (${mandate.subscriber} -> ${mandate.merchant}, amount ${mandate.amount})`,
      );
    }
    const rpc = (deps.rpc ?? makeRpc)(context.network);
    // The keeper signs with the key the environment holds, but it charges the
    // contracts of the network the command operates on.
    const keeper = new Keeper(db, rpc, keeperConfigFor(deps.config, context.network));
    const result = await keeper.settle(id);

    if (asJson) {
      emitJson(context, {
        network: context.network.name,
        mandateId: id,
        // The amount stays the string the projection stores.
        amount: mandate.amount,
        nextCharge: mandate.next_charge,
        status: result.status,
        txHash: result.txHash ?? null,
        error: result.error ?? null,
      });
      return result.status === "failed" ? 1 : 0;
    }

    if (result.status === "settled") {
      write(`settled: ${result.txHash ?? "no transaction hash"}`);
      return 0;
    }
    if (result.status === "simulated") {
      write(`simulated: nothing was submitted${result.error ? ` (${result.error})` : ""}`);
      return 0;
    }
    write(`failed: ${result.error ?? "the charge did not settle"}`);
    return 1;
  } finally {
    db.close();
  }
}

/**
 * The keeper's configuration for one network.
 *
 * The keeper reads the contracts and the passphrase it charges from the
 * configuration, so a command that operates on another network needs that
 * network's contracts — otherwise it would charge the default network's
 * contract with another network's projection. The signing keys stay the ones
 * the environment holds: the keeper signs with the same key on every network.
 */
function keeperConfigFor(config: Config, network: NetworkConfig): Config {
  return {
    ...config,
    VAULT_ID: network.vaultId,
    SUBSCRIPTION_ID: network.subscriptionId,
    NETWORK_PASSPHRASE: network.networkPassphrase,
  };
}

/**
 * `reindex`: rebuild the projection from a ledger.
 *
 * The cursor is moved back and the indexer is run until it has caught up
 * again. Every write the indexer makes is an idempotent upsert or an
 * INSERT OR IGNORE, so re-applying a ledger range leaves the projection
 * exactly as it was — which is what makes this safe to run.
 */
async function reindexCommand(context: CommandContext): Promise<number> {
  const { deps, args, write } = context;
  if (!flag(args.options, "yes")) {
    throw new CliError(
      "refusing to re-index without --yes: the projection is rewritten and the cursor moves back",
    );
  }
  const openDb = deps.openDb ?? openDatabase;
  const db = openDb(databasePath(context.network, args.options));
  try {
    const from = optionValue(args.options, "from");
    const start = from === undefined ? context.network.startLedger : nonNegativeInt(from, "--from");
    const before = readCursor(db, 0);

    // Moving the cursor forward would leave the ledgers in between unapplied:
    // the indexer starts at the cursor, so it would never see them and the
    // projection would carry a gap nobody is told about. Re-indexing *back*
    // is safe — the events are re-applied — but skipping forward is a loss,
    // so the operator has to accept it out loud.
    if (before > 0 && start > before && !flag(args.options, "skip-ahead")) {
      throw new CliError(
        `refusing to move the cursor forward from ${before} to ${start}: the ledgers in between would never be applied; re-index from ${before} or lower, or pass --skip-ahead to accept the gap`,
      );
    }

    writeCursor(db, start);
    const rpc = (deps.rpc ?? makeRpc)(context.network);
    const archive = context.network.archiveUrl ? new HttpArchive(context.network.archiveUrl) : undefined;
    const indexer = new Indexer(db, rpc, context.network, undefined, archive);
    const applied = await indexer.catchUp();
    const cursor = readCursor(db, 0);

    if (flag(args.options, "json")) {
      emitJson(context, {
        network: context.network.name,
        from: start,
        previousCursor: before,
        cursor,
        applied,
      });
      return 0;
    }
    write(
      `re-indexed ${context.network.name} from ledger ${start} (cursor was ${before}): ${applied} event(s) applied, cursor now ${cursor}`,
    );
    return 0;
  } finally {
    db.close();
  }
}

/** Run one command. */
async function runCommand(context: CommandContext): Promise<number> {
  switch (context.spec.name) {
    case "status":
      return statusCommand(context);
    case "mandate":
      return mandateCommand(context);
    case "due":
      return dueCommand(context);
    case "charge":
      return chargeCommand(context);
    case "reindex":
      return reindexCommand(context);
    default:
      throw new CliError(`unknown command '${context.spec.name}'`);
  }
}

/** What the command line asks for. */
export type CliPlan =
  /** The operator asked for help; the text is what to print. */
  | { kind: "help"; text: string }
  /** The command line is wrong; the message says what is wrong with it. */
  | { kind: "error"; message: string; hint?: string }
  /** A command to run, with its arguments parsed. */
  | { kind: "run"; spec: CommandSpec; args: ParsedArgs };

/**
 * Work out what a command line asks for.
 *
 * The answer needs no configuration and no database, so `--help` works even
 * when the environment is broken: an operator asking what the CLI can do
 * must get an answer, not a validation error about a contract id.
 */
export function planCli(argv: string[]): CliPlan {
  const first = argv[0];
  if (first === undefined) {
    return {
      kind: "error",
      message: "no command given",
      hint: "Run 'npm run cli -- --help' for the list of commands.",
    };
  }
  if (first === "--help" || first === "-h") {
    return { kind: "help", text: helpText() };
  }
  if (first === "help") {
    const target = argv[1];
    if (target === undefined) return { kind: "help", text: helpText() };
    const spec = COMMANDS.get(target);
    if (!spec) {
      return {
        kind: "error",
        message: `unknown command '${target}'`,
        hint: `Known commands: ${COMMAND_LIST.map((command) => command.name).join(", ")}.`,
      };
    }
    return { kind: "help", text: commandHelp(spec) };
  }

  const spec = COMMANDS.get(first);
  if (!spec) {
    return {
      kind: "error",
      message: `unknown command '${first}'`,
      hint: `Known commands: ${COMMAND_LIST.map((command) => command.name).join(", ")}. Run 'npm run cli -- --help' for usage.`,
    };
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(argv.slice(1), spec);
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
      hint: `Run 'npm run cli -- ${spec.name} --help' for usage.`,
    };
  }
  if (flag(args.options, "help")) {
    return { kind: "help", text: commandHelp(spec) };
  }
  if (args.positionals.length !== spec.positionals.length) {
    return {
      kind: "error",
      message: `'${spec.name}' takes ${spec.positionals.length} argument(s), got ${args.positionals.length}`,
      hint: `Run 'npm run cli -- ${spec.name} --help' for usage.`,
    };
  }
  return { kind: "run", spec, args };
}

/** Run a planned command. */
async function execute(plan: { spec: CommandSpec; args: ParsedArgs }, deps: CliDeps): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError =
    deps.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const context: CommandContext = {
      deps,
      spec: plan.spec,
      args: plan.args,
      write,
      writeError,
      network: resolveNetwork(deps, plan.args.options),
      now: (deps.now ?? (() => Math.floor(Date.now() / 1000)))(),
    };
    return await runCommand(context);
  } catch (err) {
    writeError(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * Run the CLI and answer the exit code.
 *
 * Nothing here throws: an invalid argument and a failed operation both come
 * back as a message on stderr and a non-zero exit code, which is what a
 * shell script driving the CLI needs.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError =
    deps.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));

  const plan = planCli(argv);
  if (plan.kind === "help") {
    write(plan.text);
    return 0;
  }
  if (plan.kind === "error") {
    writeError(`error: ${plan.message}`);
    if (plan.hint) writeError(plan.hint);
    return 1;
  }
  return execute(plan, deps);
}

/** The script's entry point: read the environment, then run the CLI. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const writeError = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  try {
    const plan = planCli(argv);
    if (plan.kind === "help") {
      write(plan.text);
      return;
    }
    if (plan.kind === "error") {
      writeError(`error: ${plan.message}`);
      if (plan.hint) writeError(plan.hint);
      process.exitCode = 1;
      return;
    }
    // The same `.env` the service reads on SIGHUP: an operator who copied
    // `.env.example` to `.env` gets the configuration the service runs with.
    // Variables already in the environment win, so an exported value always
    // beats the file.
    try {
      process.loadEnvFile();
    } catch {
      // No `.env` file: the process environment is the source of truth.
    }
    const config = loadConfig();
    const networks = networkConfigs(config);
    process.exitCode = await execute(plan, { config, networks, write, writeError });
  } catch (err) {
    writeError(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// Only run when this file is the program, not when a test imports it.
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  await main();
}
