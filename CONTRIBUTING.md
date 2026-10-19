# Contributing to the Payflow Backend

## Setup

```bash
npm install
cp .env.example .env
npm test
```

Node 22.5+ is required — the service uses the built-in `node:sqlite` module and
native TypeScript execution.

The same service runs in a container, with the projection on a named volume:

```bash
cp .env.example .env
docker compose up
```

## What CI enforces

| Job | Command |
|---|---|
| `lint` | `npm run lint` |
| `typecheck` | `npm run typecheck` |
| `test` | `npm test` |
| `build` | `npm run build` |
| `docker build` | builds the image, pushes nothing |
| `audit` | `npm audit --omit=dev --audit-level=high` |

Dependencies are kept current by [Dependabot](.github/dependabot.yml), which
opens weekly updates for npm packages and GitHub Actions.

## Code standards

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
