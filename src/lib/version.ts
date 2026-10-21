/**
 * Build-time version and commit information.
 * Populated by build process; at runtime exports package.json version.
 */

let buildVersion = "0.2.0";
let buildCommit = "unknown";
let buildTime = new Date().toISOString();

export interface VersionInfo {
  version: string;
  commit: string;
  buildTime: string;
  nodeVersion: string;
  typescript: boolean;
}

export function getVersionInfo(): VersionInfo {
  return {
    version: buildVersion,
    commit: buildCommit,
    buildTime,
    nodeVersion: process.version,
    typescript: true,
  };
}
