import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: the tsconfig lives there. */
const root = fileURLToPath(new URL("..", import.meta.url));

/** The compiler the CI job runs. */
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

describe("test files are type-checked", () => {
  test("a type error in a test file fails the typecheck the CI job runs", async () => {
    // The check runs against a copy of the repository, with the probe
    // written into the copy's `test/` directory. Writing it into the
    // repository itself would leave a file that does not compile behind for
    // as long as the check runs — long enough for an editor watching the
    // project to report it, and long enough for a concurrent `tsc` to fail
    // on a file that has just been deleted.
    const dir = await mkdtemp(join(tmpdir(), "payflow-typecheck-"));
    try {
      await cp(join(root, "src"), join(dir, "src"), { recursive: true });
      await cp(join(root, "test"), join(dir, "test"), { recursive: true });
      await cp(join(root, "tsconfig.json"), join(dir, "tsconfig.json"));
      await cp(join(root, "tsconfig.test.json"), join(dir, "tsconfig.test.json"));
      // The package manifest decides that the files are ES modules, which is
      // what lets them use `import.meta`.
      await cp(join(root, "package.json"), join(dir, "package.json"));
      // The compiler finds the dependencies through node_modules.
      await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
      // The probe: a file under `test/` with a deliberate type error.
      await writeFile(
        join(dir, "test", "typecheck-probe.ts"),
        'export const broken: number = "not a number";\n',
        "utf8",
      );

      // The exact command the CI typecheck job runs for the tests.
      const result = spawnSync(
        process.execPath,
        [tsc, "--noEmit", "-p", join(dir, "tsconfig.test.json")],
        { cwd: dir, encoding: "utf8" },
      );
      const output = `${result.stdout}${result.stderr}`;

      assert.notEqual(result.status, 0, `the typecheck must fail:\n${output}`);
      assert.match(output, /typecheck-probe\.ts/, "the error names the file that carries it");
      assert.match(output, /error TS\d+/, "the failure is a type error");

      // Every other file is clean, so the failure above is the probe's and
      // not a pre-existing one: the repository's own tests type-check.
      const failures = output
        .split("\n")
        .filter((line) => /error TS\d+/.test(line) && /test[\\/]/.test(line));
      assert.ok(failures.length > 0, `the probe is reported:\n${output}`);
      assert.ok(
        failures.every((line) => line.includes("typecheck-probe.ts")),
        `only the probe fails:\n${output}`,
      );
    } finally {
      // The symlink is removed first, so the cleanup cannot reach the
      // repository's own node_modules.
      await rm(join(dir, "node_modules"), { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
