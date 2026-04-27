---
title: CI integration
description: Emit CI workflows, compute PR verdicts, and gate PRs on detected changes.
sidebar:
  order: 80
---

OpenCodeHub is built for CI from day one. Every command that matters in
a pipeline emits structured exit codes, supports `--json`, and runs
offline against the committed index.

## Scaffold a pipeline

```bash title="emit opinionated CI workflows"
codehub ci-init
```

`ci-init` detects whether the repo is on GitHub or GitLab and writes
the corresponding workflow file. Pass `--platform github`,
`--platform gitlab`, or `--platform both` to override. Use
`--main-branch release` to change the base branch, and `--force` to
overwrite an existing workflow.

The emitted workflow runs `codehub analyze`, `codehub detect-changes
--scope compare --compare-ref origin/main --strict`, `codehub scan`,
and `codehub verdict` in that order.

## Verdict: a 5-tier PR gate

```bash title="compute a PR verdict"
codehub verdict --base main --head HEAD
```

`verdict` returns one of five tiers with a deterministic exit code:

| Tier | Exit code | Meaning |
|---|---|---|
| `auto_merge` | 0 | Low-risk, no reviewer required by the graph. |
| `single_review` | 1 | One reviewer sufficient. |
| `dual_review` | 1 | Two reviewers recommended. |
| `expert_review` | 2 | Domain owner review required. |
| `block` | 3 | Do not merge — critical blast radius or policy fail. |

Use the exit code directly in a CI step, or pass `--json` for the full
envelope with reasoning and contributing signals.

## Detect changes on a PR

```bash title="map the diff to graph symbols and processes"
codehub detect-changes --scope compare --compare-ref origin/main --strict
```

`detect-changes` returns the list of symbols, processes, and files
touched by the diff, each tagged with a risk tier. Exit codes:

- `0` — OK (no HIGH/CRITICAL; MEDIUM allowed unless `--strict`).
- `1` — HIGH/CRITICAL found, or MEDIUM found with `--strict`.
- `2` — the command itself crashed.

## Exit-code reference

| Command | Exit 0 | Exit 1 | Exit 2 | Exit 3 |
|---|---|---|---|---|
| `analyze` | success | caught error | — | — |
| `detect-changes` | OK | risk found | caught error | — |
| `verdict` | `auto_merge` | `single_review` / `dual_review` | `expert_review` | `block` |
| `scan` | clean | findings at severity | scanner crashed | — |

## Ingesting external SARIF

If you already run another SAST tool, ingest its SARIF output into the
graph so the same `list_findings` MCP tool surfaces both sets:

```bash title="ingest an external SARIF file"
codehub ingest-sarif path/to/report.sarif
```

The findings become `Finding` nodes with `FOUND_IN` edges to the
symbol and file they reference.

## Next

- [CLI reference](/opencodehub/reference/cli/) — every command, every
  flag.
- [Error codes](/opencodehub/reference/error-codes/) — the fixed set of
  MCP error codes your CI tooling may encounter.
