# Changelog

All notable changes to `@mmm-pay/payflow-client`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[semantic versioning](https://semver.org/).

## [0.1.0] - 2026-10-22

### Added

- The typed client as a standalone package, built from the same response
  types the backend routes use. It has no runtime dependencies: `fetch` is
  the only API it needs, so it runs in Node.js, Bun, Deno, and browsers.
- `PayflowClient` for the read-only endpoints: health, plans, mandates,
  charges, due mandates, merchant and subscriber summaries, merchant churn
  and revenue, stats, protocol, vault, and keeper history.
- `PayflowApiError`, which carries the HTTP status and the parsed error
  envelope.
