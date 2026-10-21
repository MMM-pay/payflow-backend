import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The repository root: the tsconfig lives there. */
const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * A path the way the compiler reports it, whatever the platform.
 *
 * The compiler names the file a diagnostic belongs to with the separators of
 * the platform it runs on, so both sides of the comparison are normalised:
 * on Windows the probe's path would otherwise never match.
 */
function comparablePath(path: string): string {
  return path.split("\\").join("/");
}

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
      const probe = comparablePath(join(dir, "test", "typecheck-probe.ts"));
      await writeFile(probe, 'export const broken: number = "not a number";\n', "utf8");

      // The project the CI typecheck job compiles: the compiler reads
      // `tsconfig.test.json` — which extends `tsconfig.json` and includes
      // `test/` — and reports the errors it finds. The CI job fails because
      // `tsc` exits non-zero, and `tsc` exits non-zero when there are
      // errors, so the errors are what has to be looked at.
      const configFile = ts.readConfigFile(join(dir, "tsconfig.test.json"), ts.sys.readFile);
      assert.ok(configFile.config, "tsconfig.test.json is readable");
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dir);
      assert.ok(
        parsed.fileNames.some((name) => name.endsWith("test/typecheck-probe.ts")),
        "the probe is part of the project the compiler checks",
      );

      const program = ts.createProgram({
        rootNames: parsed.fileNames,
        options: { ...parsed.options, noEmit: true },
      });
      const errors = ts
        .getPreEmitDiagnostics(program)
        .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

      const inProbe = errors.filter(
        (diagnostic) =>
          diagnostic.file && comparablePath(diagnostic.file.fileName) === probe,
      );
      assert.ok(inProbe.length > 0, "the probe's type error is reported");
      assert.match(
        ts.flattenDiagnosticMessageText(inProbe[0]!.messageText, " "),
        /not assignable to type 'number'/,
        "the failure is a type error",
      );

      // Every other file is clean, so the failure above is the probe's and
      // not a pre-existing one: the repository's own tests type-check.
      const elsewhere = errors.filter(
        (diagnostic) =>
          diagnostic.file && comparablePath(diagnostic.file.fileName) !== probe,
      );
      assert.deepEqual(
        elsewhere.map((diagnostic) => {
          const where = comparablePath(diagnostic.file!.fileName);
          const what = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
          return `${where}: ${what}`;
        }),
        [],
        "only the probe fails",
      );
    } finally {
      // The symlink is removed first, so the cleanup cannot reach the
      // repository's own node_modules.
      await rm(join(dir, "node_modules"), { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
