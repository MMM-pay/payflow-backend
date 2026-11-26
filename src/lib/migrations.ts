import type { Storage } from "./store/types.ts";

/** One ordered, versioned database migration. */
export interface Migration {
  version: number;
  name: string;
  description: string;
}

/** Status of a single migration against a store. */
export interface MigrationStatusEntry extends Migration {
  applied: boolean;
}

/** Applied vs pending migrations for a store. */
export interface MigrationStatus {
  dialect: "sqlite" | "postgres";
  applied: MigrationStatusEntry[];
  pending: MigrationStatusEntry[];
}

/**
 * Ordered list of versioned schema migrations shared across SQLite and
 * PostgreSQL stores.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "redact-webhook-response-bodies",
    description: "Clear receiver-controlled response_body text in webhook_deliveries",
  },
];

/**
 * Inspect `schema_migrations` on either SQLite or PostgreSQL and return which
 * versioned migrations have been applied and which are still pending.
 */
export async function getMigrationStatus(storage: Storage): Promise<MigrationStatus> {
  let appliedVersions = new Set<number>();
  try {
    const rows = await storage.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    );
    appliedVersions = new Set(rows.map((row) => Number(row.version)));
  } catch (err) {
    // An uninitialized database without schema_migrations has zero applied migrations.
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("no such table") && !message.includes("does not exist")) {
      throw err;
    }
  }

  const applied: MigrationStatusEntry[] = [];
  const pending: MigrationStatusEntry[] = [];

  for (const migration of MIGRATIONS) {
    const isApplied = appliedVersions.has(migration.version);
    const entry: MigrationStatusEntry = { ...migration, applied: isApplied };
    if (isApplied) {
      applied.push(entry);
    } else {
      pending.push(entry);
    }
  }

  return {
    dialect: storage.dialect,
    applied,
    pending,
  };
}
