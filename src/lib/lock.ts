import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/**
 * An advisory lock beside a SQLite file, `<database>.lock`, holding the PID
 * of the process that owns the database. SQLite's own locks are only held
 * for the length of a transaction (and WAL lets readers and a writer share
 * the file), so they cannot tell a maintenance command that the server is
 * running. The lock file can.
 *
 * Creation is atomic (`O_CREAT | O_EXCL`). A lock left behind by a process
 * that crashed is detected by its PID no longer being alive and is taken
 * over. In-memory databases have no file and are never locked.
 */
export class DatabaseLockedError extends Error {
  readonly pid: number;

  constructor(path: string, pid: number) {
    super(`${path} is in use by process ${pid}; stop it before running this command`);
    this.name = "DatabaseLockedError";
    this.pid = pid;
  }
}

export function lockPathFor(databasePath: string): string {
  return `${databasePath}.lock`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The PID holding the lock on `databasePath`, or null when it is free. */
export function lockHolder(databasePath: string): number | null {
  if (databasePath === ":memory:") return null;
  let raw: string;
  try {
    raw = readFileSync(lockPathFor(databasePath), "utf8");
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
}

/**
 * Take the lock on `databasePath` for this process and return a function
 * that releases it. Throws `DatabaseLockedError` when another live process
 * holds it; a stale lock is replaced.
 */
export function acquireLock(databasePath: string): () => void {
  if (databasePath === ":memory:") return () => {};
  const path = lockPathFor(databasePath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = lockHolder(databasePath);
      if (holder !== null && holder !== process.pid) throw new DatabaseLockedError(databasePath, holder);
      // Stale (or our own): clear it and try once more.
      try {
        unlinkSync(path);
      } catch {
        // Someone else cleared it first.
      }
      continue;
    }
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    };
  }
  throw new Error(`could not acquire ${path}`);
}
