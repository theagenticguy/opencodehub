---
title: Testing
description: Test harnesses — Node test runner, Python eval, MCP smoke, acceptance gates, SCIP gym.
sidebar:
  order: 70
---

OpenCodeHub has four test surfaces. Each runs at a different cadence
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

## Python eval harness

The parity and regression eval lives in `packages/eval/`. It is a
pytest suite that drives the MCP server end-to-end against fixture
repos and asserts on the tool responses.

```bash
mise run test:eval       # uv sync + uv run pytest in packages/eval/
```

`mise.toml` wires a per-project venv via
`_.python.venv = { path = "packages/eval/.venv", create = true }`, so
the first run creates the venv; subsequent runs reuse it.

There are 49 parametrized cases. The release gate (acceptance gate 9)
requires ≥ 40 / 49 to pass. This is the floor that prevents
undetected regressions in MCP tool behaviour between releases.

### When to add an eval case

Any time you change the shape of an MCP tool response, the resolver,
or a ranking behaviour. Fixtures live under
`packages/eval/src/opencodehub_eval/fixtures/`. Test definitions live
under `packages/eval/src/opencodehub_eval/tests/`.

## MCP smoke test

`scripts/smoke-mcp.sh` boots the stdio MCP server, sends
`initialize` + `tools/list`, and asserts that the advertised tool
count matches `EXPECTED_TOOLS`. Run it directly or via:

```bash
mise run smoke:mcp
```

:::caution[Known drift]
`scripts/smoke-mcp.sh` defaults `EXPECTED_TOOLS=19`.
`packages/mcp/src/server.ts` currently registers **28** tools, and the
top-level README cites **27**. The smoke test is therefore wrong on any
build that has not overridden `EXPECTED_TOOLS`. The fix is a one-line
update to the default; until it lands, use `EXPECTED_TOOLS=28 mise run
smoke:mcp` locally, or expect the acceptance gate 8 output to reflect
the stale count.
:::

## Acceptance gates — v1.0 Definition of Done

`scripts/acceptance.sh` runs all 15 Definition-of-Done gates. Mandatory
gates fail the run; soft gates (gates 7, 10, 11) log timings or skip
when a dependency binary is missing and do not change the exit code.

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
| 9    | Python eval harness — ≥ 40 / 49 cases pass                                 | no    |
| 10   | embeddings determinism (skipped if model weights absent)                   | soft  |
| 11   | 100-file fixture incremental timing (5-run p95, logged only)                | soft  |
| 12   | scanner smoke — `codehub scan --scanners semgrep` emits SARIF              | no    |
| 13   | SARIF Zod-schema validation                                                | no    |
| 14   | license-audit smoke via the MCP tool                                        | no    |
| 15   | verdict smoke on a 2-commit fixture                                         | no    |

Run acceptance before opening a PR that touches the analyze pipeline,
storage, the MCP server, or anything else called out in
[Dev loop / When to run acceptance](/opencodehub/contributing/dev-loop/#when-to-run-acceptance).

## Gym — SCIP indexer differential tests

The gym drives each per-language SCIP indexer against a frozen baseline
manifest and asserts that precision, recall, and F1 have not regressed
per language. It is the regression gate for compiler-grade edge
upgrades.

```bash
mise run gym                # run against the frozen baseline
mise run gym:baseline       # lock a new baseline manifest (careful)
mise run gym:replay         # bit-exact replay of a frozen manifest
```

Baselines live at `packages/gym/baselines/`. The differential tests run
in CI via `.github/workflows/gym.yml` on every PR that touches
`packages/scip-ingest`, `packages/ingestion`, or the frozen corpus.

## Tenets apply to failing tests too

Every failure — a lint warning, a flaky eval, a soft acceptance gate
that turned hard because a binary became available — is a blocker until
it is fixed or explicitly waived. See the
[tenets block](/opencodehub/contributing/overview/#tenets).

## Related files

- `scripts/acceptance.sh` — the 15-gate runner.
- `scripts/smoke-mcp.sh` — MCP boot smoke.
- `packages/eval/src/opencodehub_eval/tests/` — Python parametrized
  eval cases.
- `packages/gym/baselines/` — frozen gym baselines.
- `.github/workflows/{ci,gym}.yml` — CI workflows.
