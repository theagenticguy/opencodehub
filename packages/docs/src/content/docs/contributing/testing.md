---
title: Testing
description: Test harnesses — Node test runner, MCP smoke, acceptance gates, SCIP indexer regression.
sidebar:
  order: 70
---

OpenCodeHub has three test surfaces. Each runs at a different cadence
and covers a different level of the stack. This page is the map.

## Node tests — per-package

Every TypeScript package has its own `test` script that runs the
[Node.js test runner](https://nodejs.org/api/test.html) against compiled
output:

```bash
pnpm -r test
```

Conventions:

- Test files live alongside source as `*.test.ts`.
- `tsc` compiles them into `dist/**/*.test.js`.
- Each package's `test` script is `node --test './dist/**/*.test.js'`
  (or close — check `packages/<pkg>/package.json` for the exact form).
- No Jest, no Vitest. The stdlib test runner keeps the dev dependency
  surface small and Apache-2.0 clean.

`mise run test` runs the full matrix after a `build`. The `pre-push`
lefthook hook runs the same command, so you usually catch failures
before CI does.

### When to add a Node test

Any time you touch code under `packages/*/src/`. Fixtures live in
`packages/<pkg>/test/fixtures/`. The `parseFixture` helper in
`packages/ingestion` (see
[Adding a language provider](/opencodehub/contributing/adding-a-language-provider/))
is the standard tool for ingestion-side assertions.

## MCP smoke test

`scripts/smoke-mcp.sh` boots the stdio MCP server, sends
`initialize` + `tools/list`, and asserts that the advertised tool
count matches `EXPECTED_TOOLS`. Run it directly or via:

```bash
mise run smoke:mcp
```

The expected tool count is **29** (`packages/mcp/src/server.ts`). If
your fork drifts from that number, set `EXPECTED_TOOLS=<n>` to match.

## Acceptance gates — v1.0 Definition of Done

`scripts/acceptance.sh` runs the v1 Definition-of-Done gates.
Mandatory gates fail the run; soft gates log timings or skip when a
dependency binary is missing and do not change the exit code.

```bash
mise run acceptance
```

| Gate | What it checks                                                              | Soft? |
|------|-----------------------------------------------------------------------------|-------|
| 1    | `pnpm install --frozen-lockfile`                                           | no    |
| 2    | `pnpm -r build`                                                            | no    |
| 3    | `pnpm -r test`                                                             | no    |
| 4    | banned-strings sweep                                                       | no    |
| 5    | license allowlist                                                           | no    |
| 6    | determinism — double-run `graphHash` identical                             | no    |
| 7    | incremental reindex timings (5-run p95, logged only)                        | soft  |
| 8    | MCP stdio boot + `tools/list`                                              | no    |
| 9    | MCP server end-to-end harness — minimum case-pass floor                     | no    |
| 10   | embeddings determinism (skipped if model weights absent)                   | soft  |
| 11   | 100-file fixture incremental timing (5-run p95, logged only)                | soft  |
| 12   | scanner smoke — `codehub scan --scanners semgrep` emits SARIF              | no    |
| 13   | SARIF Zod-schema validation                                                | no    |
| 14   | license-audit smoke via the MCP tool                                        | no    |
| 15   | verdict smoke on a 2-commit fixture                                         | no    |

Run acceptance before opening a PR that touches the analyze pipeline,
storage, the MCP server, or anything else called out in
[Dev loop / When to run acceptance](/opencodehub/contributing/dev-loop/#when-to-run-acceptance).

## SCIP indexer regression tests

The SCIP indexer regression tests run via
`.github/workflows/gym.yml` on every PR that touches
`packages/scip-ingest`, `packages/ingestion`, or the frozen corpus.
Pinned indexer versions live in the same workflow file (ADR 0006). A
drift in any indexer's output against the frozen baseline fails the
PR.

## Tenets apply to failing tests too

Every failure — a lint warning, a flaky eval, a soft acceptance gate
that turned hard because a binary became available — is a blocker until
it is fixed or explicitly waived. See the
[tenets block](/opencodehub/contributing/overview/#tenets).

## Related files

- `scripts/acceptance.sh` — the v1 Definition-of-Done runner.
- `scripts/smoke-mcp.sh` — MCP boot smoke.
- `.github/workflows/{ci,gym}.yml` — CI workflows.
