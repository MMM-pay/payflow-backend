# Contributing to the Payflow Backend

## Setup

```bash
npm install
cp .env.example .env
npm test
```

Node 22.5+ is required — the service uses the built-in `node:sqlite` module and
native TypeScript execution.

A dev container is checked in for GitHub Codespaces and VS Code: it uses
Node 22, runs `npm ci`, and installs the Stellar CLI when it is created, so no
host setup is needed. Open the repository in a Codespace and run `npm test`.
The same service runs in a container, with the projection on a named volume:

```bash
cp .env.example .env
docker compose up
```

## What CI enforces

| Job | Command |
|---|---|
| `lint` | `npm run lint` |
| `typecheck` | `npm run typecheck` (the sources and the tests) |
| `test` | `npm test` |
| `coverage` | `npm run test:coverage` (the tests, with a coverage threshold) |
| `build` | `npm run build` |
| `docker build` | builds the image, pushes nothing |
| `audit` | `npm audit --omit=dev --audit-level=high` |

The typecheck job runs `tsc` twice: once over `src/` and once over `test/`
(`tsconfig.test.json`). A test that no longer type-checks is a build
failure, not a surprise at run time — a broken test type usually means the
API it exercises has changed shape.

## Coverage

`npm run test:coverage` runs the tests with Node's own coverage
(`--experimental-test-coverage`) and writes an lcov report to `lcov.info`,
which the `coverage` job uploads as an artifact. No coverage tool is added
as a dependency: the test runner already knows how to measure itself.

The job fails when the line coverage of `src/` falls below the threshold
`--test-coverage-lines` sets. The threshold is **94%**, which is the
measured baseline of **96.63%** minus two percentage points. The baseline
is a measurement, not a guess, and it moves: re-measure it with
`npm run test:coverage` and raise the threshold when the code is better
covered. Lowering it needs a reason in the pull request.

The measurement wobbles by about 0.03 points between runs, because a
handful of lines in `src/indexer.ts` are covered only when a test happens
to take a particular path. The threshold has enough room for that.

Dependencies are kept current by [Dependabot](.github/dependabot.yml), which
opens weekly updates for npm packages and GitHub Actions.

## Code standards

- **Pin actions to a commit SHA.** Write `uses: owner/action@<sha> # v1.2.3`,
  never a tag: a tag can be moved, and a moved tag runs someone else's code
  with the workflow's token. Dependabot updates the SHA and the comment.
- **Give every workflow and job the least permissions it needs.** List them
  explicitly with a comment saying what each one is for.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes` are on. Do not weaken them; fix the type.
- **No TypeScript parameter properties.** Node's type stripping rejects them.
  Declare fields explicitly and assign in the constructor body.
- **Import with `.ts` extensions.** `rewriteRelativeImportExtensions` converts
  them on build, and Node needs them at runtime.
- **Money is never a JS number.** i128 values arrive as `bigint` and are stored
  as `TEXT`. Use the `big()` helper. A float here is a bug.
- **Every indexer write must be idempotent.** Re-indexing a ledger range twice
  must not change the result. Add a replay test for any new event.
- **Structured logging only.** `logger.info({ field }, "message")` — never
  `console.log`, and never interpolate values into the message string.

## Tests

`node:test` with `node:assert/strict`. Indexer tests construct `DecodedEvent`
objects directly and need no network. API tests bind an ephemeral port.

Name tests by behaviour: `out-of-order charges never move a mandate backwards`.

## Commits

Conventional commits, one logical change each:

```
feat(api): add merchant revenue summary endpoint
fix(indexer): derive last_charge from next_charge and period
test(indexer): cover replayed charge idempotency
```
