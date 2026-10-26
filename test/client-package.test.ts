import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageDir = join(root, "client");

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  files?: string[];
  exports?: Record<string, unknown>;
}

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  ) as PackageManifest;
}

describe("the published client package", () => {
  test("is a standalone, dependency-free package with its own version", async () => {
    const pkg = await manifest();
    assert.equal(pkg.name, "@mmm-pay/payflow-client");
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.notEqual(pkg.private, true, "the package is publishable");
    assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
    assert.equal(pkg.peerDependencies, undefined, "nothing to install beside it");
    assert.ok(pkg.files?.includes("dist"), "the build output is published");
    assert.ok(pkg.files?.includes("CHANGELOG.md"), "the changelog is published");
    assert.deepEqual(pkg.exports?.["."], {
      types: "./dist/client/index.d.ts",
      import: "./dist/client/index.js",
      default: "./dist/client/index.js",
    });
  });

  test("its changelog records the version in the manifest", async () => {
    const pkg = await manifest();
    const changelog = await readFile(join(packageDir, "CHANGELOG.md"), "utf8");
    assert.match(changelog, new RegExp(`## \\[${pkg.version.replaceAll(".", "\\.")}\\]`));
  });

  test("the README quick-start example type-checks against the client", async () => {
    const readme = await readFile(join(packageDir, "README.md"), "utf8");
    const block = /```ts\r?\n([\s\S]*?)```/.exec(readme);
    assert.ok(block?.[1], "the README has a TypeScript example");
    assert.match(block[1], /from "@mmm-pay\/payflow-client"/);

    const dir = await mkdtemp(join(tmpdir(), "payflow-client-example-"));
    try {
      const example = join(dir, "example.mts");
      await writeFile(example, block[1], "utf8");

      const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: true,
        baseUrl: root,
        paths: { "@mmm-pay/payflow-client": ["src/client/index.ts"] },
      };
      const program = ts.createProgram({ rootNames: [example], options });
      const errors = ts
        .getPreEmitDiagnostics(program)
        .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

      assert.deepEqual(
        errors.map((diagnostic) => {
          const where = diagnostic.file?.fileName ?? "unknown file";
          const what = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
          return `${where}: ${what}`;
        }),
        [],
        "the README example compiles",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
