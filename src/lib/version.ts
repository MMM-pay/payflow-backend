import { readFileSync } from "node:fs";

/**
 * Version information for `GET /version`.
 *
 * The version is read from package.json once at startup. The commit comes
 * from the environment the deployment sets: `GIT_COMMIT`, or the variables
 * Render and GitHub Actions provide. Nothing here is secret.
 */
export interface VersionInfo {
  version: string;
  commit: string;
  nodeVersion: string;
  startedAt: string;
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = packageVersion();
const COMMIT =
  process.env.GIT_COMMIT ?? process.env.RENDER_GIT_COMMIT ?? process.env.GITHUB_SHA ?? "unknown";
const STARTED_AT = new Date().toISOString();

export function getVersionInfo(): VersionInfo {
  return { version: VERSION, commit: COMMIT, nodeVersion: process.version, startedAt: STARTED_AT };
}
