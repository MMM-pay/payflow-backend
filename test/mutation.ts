/** Mutation testing for indexer projections.
 *
 * Mutation testing checks that the test suite is sensitive to regressions in
 * the projection logic. For each mutation (a small, deliberate change to the
 * source), the test suite is run: if a test fails the mutation is "killed"
 * (good — the tests caught it); if every test passes the mutation "survived"
 * (bad — a regression could slip through).
 *
 * Usage:
 *   npm run mutation-test
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Mutation {
  name: string;
  file: string;
  find: string;
  replace: string;
}

const MUTATIONS: Mutation[] = [
  {
    name: "guards reject late pause when mandate is not active or paused",
    file: "src/indexer.ts",
    find: "WHERE id = ? AND status IN ('Active','Paused')",
    replace: "WHERE id = ? AND status IN ('Active','Paused','Cancelled','Ended','Completed')",
  },
  {
    name: "charge guard does not prevent moving charges_made backwards",
    file: "src/indexer.ts",
    find: "WHERE id = ? AND charges_made < ?",
    replace: "WHERE id = ? AND charges_made <= ?",
  },
  {
    name: "upsert no longer ignores replayed events",
    file: "src/indexer.ts",
    find: "INSERT OR IGNORE INTO mandate_events (mandate_id, slot, merchant, kind, at, ledger)",
    replace: "INSERT INTO mandate_events (mandate_id, slot, merchant, kind, at, ledger)",
  },
  {
    name: "cursor advances without applying events",
    file: "src/lib/db.ts",
    find: "ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger",
    replace: "ON CONFLICT(id) DO UPDATE SET last_ledger = last_ledger + 1",
  },
  {
    name: "mandate status update accepted regardless of order",
    file: "src/indexer.ts",
    find: "status IN ('Active','Paused')",
    replace: "status IN ('Active','Paused','Cancelled','Ended','Completed')",
  },
];

interface MutationResult extends Mutation {
  testsPassed: boolean;
  output: string;
}

/** Run the test suite once, returning whether every test passed. */
function runTests(): { passed: boolean; output: string } {
  let output: string;
  let passed: boolean;
  try {
    output = execFileSync(
      "node",
      ["--experimental-strip-types", "--test", "test/*.test.ts"],
      { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
    );
    passed = true;
  } catch (err) {
    output =
      err instanceof Error && typeof (err as { stdout?: string }).stdout === "string"
        ? (err as { stdout?: string }).stdout!
        : String(err);
    passed = false;
  }
  return { passed, output };
}

describe("mutation testing", () => {
  test("every mutation to indexer projections is killed by the test suite", () => {
    const results: MutationResult[] = [];

    const baseline = runTests();
    assert.ok(baseline.passed, `baseline test suite is red:\n${baseline.output}`);

    for (const mutation of MUTATIONS) {
      const workDir = mkdtempSync(join(tmpdir(), "payflow-mut-"));
      try {
        execFileSync("cp", ["-r", "package.json", "tsconfig.json", "tsconfig.test.json", "src", "test", workDir], { encoding: "utf8" });

        const target = join(workDir, mutation.file);
        if (!existsSync(target)) {
          results.push({ ...mutation, testsPassed: true, output: `file not found: ${mutation.file}` });
          continue;
        }

        const source = readFileSync(target, "utf8");
        const escaped = mutation.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const count = (source.match(new RegExp(escaped, "g")) ?? []).length;
        if (count !== 1) {
          results.push({ ...mutation, testsPassed: true, output: `expected exactly one occurrence of search text, found ${count}` });
          continue;
        }

        const mutated = source.replace(mutation.find, mutation.replace);
        writeFileSync(target, mutated);

        const result = runTests();
        results.push({ ...mutation, testsPassed: result.passed, output: result.output });
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }

    const killed = results.filter((r) => !r.testsPassed).length;
    const survived = results.filter((r) => r.testsPassed).length;
    const total = results.length;
    const score = total === 0 ? 100 : (killed / total) * 100;

    console.log(`\nMutation testing: ${killed}/${total} killed (${score.toFixed(1)}%)\n`);
    for (const r of results) {
      const mark = r.testsPassed ? "SURVIVED" : "killed";
      console.log(`  [${mark}] ${r.name}`);
      if (r.testsPassed) {
        console.log(`    ${r.file}: ${r.find} -> ${r.replace}`);
      }
    }

    assert.equal(
      survived,
      0,
      `${survived} mutation(s) survived the test suite:\n` +
        results.filter((r) => r.testsPassed).map((r) => `  - ${r.name}`).join("\n") +
        "\nAdd tests that assert the behaviour each survivor changes.",
    );
  });
});