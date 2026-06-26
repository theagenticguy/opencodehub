---
title: CLI reference
description: Every codehub command, flag, and exit code.
sidebar:
  order: 10
---

Binary: `codehub`. Source entry: `packages/cli/src/index.ts`. Published
entry: `packages/cli/dist/index.js`. Default error contract: an
unhandled throw writes `codehub: <msg>` to stderr and sets
`process.exitCode = 1`.

## `analyze`

Index a repository. Runs the full pipeline: parse, resolve, cluster,
build BM25 + HNSW indexes, and write `.codehub/`.

```bash title="usage"
codehub analyze [path]
```

| Flag | Default | Purpose |
|---|---|---|
| `--force` | off | Ignore the registry cache and re-run the pipeline. |
| `--embeddings` | off | Compute semantic vectors. |
| `--embeddings-int8` | off | Quantise vectors to int8 (~23 MB weights). |
| `--granularity <csv>` | `symbol` | Any subset of `symbol,file,community`. |
| `--embeddings-workers <n\|auto>` | `auto` | Size of the ONNX worker pool. |
| `--embeddings-batch-size <n>` | 32 | Batch size per worker. |
| `--offline` | off | Zero sockets. |
| `--verbose` | off | Per-phase pipeline progress. |
| `--skip-agents-md` | off | Skip the AGENTS.md / CLAUDE.md stanza. |
| `--sbom` / `--no-sbom` | **on** | Emit `sbom.cyclonedx.json` + `sbom.spdx.json` from `Dependency` nodes. Use `--no-sbom` to suppress. |
| `--scan` / `--no-scan` | **on** | Run Priority-1 scanners, write `.codehub/scan.sarif`, and ingest findings into the graph. Network-backed scanners (osv-scanner, grype, npm/pip audit) self-skip under `--offline`. Use `--no-scan` to suppress. |
| `--coverage` / `--no-coverage` | **auto** | Overlay lcov / cobertura / jacoco / coverage.py reports onto `File` nodes. `auto` probes `coverage/lcov.info`, `lcov.info`, `coverage.xml`, `build/reports/jacoco/test/jacocoTestReport.xml`, `coverage.json` in that order and enables the phase when one exists (silent no-op otherwise). `--coverage` forces on and warns if nothing is found; `--no-coverage` forces off. |
| `--summaries` / `--no-summaries` | off | LLM symbol summaries (Bedrock). Opt in with `--summaries` or `CODEHUB_BEDROCK_SUMMARIES=1`; kill with `--no-summaries` or `CODEHUB_BEDROCK_DISABLED=1`. |
| `--max-summaries <n\|auto>` | `auto` (10% of SCIP-confirmed callables, cap 500) | Summary budget. |
| `--summary-model <id>` | — | Override the Bedrock summary model id. |
| `--skills` | off | Emit one `SKILL.md` per Community (≥5 symbols) under `.codehub/skills/`. |
| `--strict-detectors` | off | Drop heuristic-only matches from route / ORM detectors (DET-O-001). |
| `--allow-build-scripts <list>` | — | Comma-separated build-script opt-ins (e.g. `proleap` for the JVM COBOL deep-parse). |

Exit codes: `0` success, `1` caught error.

## `index`

Register an existing `.codehub/` into `~/.codehub/registry.json` without
re-analysing.

```bash title="usage"
codehub index [paths...]
```

| Flag | Default | Purpose |
|---|---|---|
| `--force` | off | Stamp a minimal `meta.json` stub when missing. |
| `--allow-non-git` | off | Permit registering a directory with no `.git`. |

## `init`

Bootstrap a repo for OpenCodeHub. Copies the Claude Code plugin assets
into `.claude/` (project scope, with hook tokens rewritten from
`${CLAUDE_PLUGIN_ROOT}` to `${CLAUDE_PROJECT_DIR}/.claude`), writes
`.mcp.json`, appends `.codehub/` to `.gitignore`, and seeds
`opencodehub.policy.yaml` with every rule commented out.

```bash title="usage"
codehub init [path]
```

| Flag | Default | Purpose |
|---|---|---|
| `--force` | off | Overwrite conflicting files under `.claude/`. |
| `--skip-mcp` | off | Skip writing `.mcp.json`. |
| `--skip-policy` | off | Skip seeding `opencodehub.policy.yaml`. |

## `setup`

Wire MCP config into supported editors, install the Claude Code
plugin, or download embedder weights.

```bash title="usage"
codehub setup
```

| Flag | Default | Purpose |
|---|---|---|
| `--editors <list>` | all | `claude-code,cursor,codex,windsurf,opencode`. |
| `--force` | off | Overwrite existing entries; re-download weights. |
| `--undo` | off | Restore the most recent `.bak` next to each config. |
| `--embeddings` | off | Download `F2LLM-v2-80M` ONNX weights (SHA256-pinned GitHub release asset). |
| `--int8` | off | Use the int8 weight variant (~81 MB) instead of fp32 (~321 MB). |
| `--model-dir <path>` | — | Override the target directory for embedder weights. |
| `--plugin` | off | Install the Claude Code plugin to `~/.claude/plugins/opencodehub/`. |

## `mcp`

Launch the stdio MCP server.

```bash title="usage"
codehub mcp
```

Signal handling: `SIGINT` → 130, `SIGTERM` → 143, stdin close → 0.

## `list`

List repos indexed on this machine.

```bash title="usage"
codehub list
```

The output table includes a `HEALTH` column flagging dangling registry
entries (`missing path`) and cleaned indexes (`no graph artifact`).

## `status`

Report index metadata and staleness for one repo.

```bash title="usage"
codehub status [path]
```

## `clean`

Delete the index at `[path]`.

```bash title="usage"
codehub clean [path]
```

| Flag | Default | Purpose |
|---|---|---|
| `--all` | off | Delete every registered index. |

## `pack`

Emit a single-file LLM-ready snapshot of the repo via repomix
(AST-compressed by default).

```bash title="usage"
codehub pack [path]
```

| Flag | Default | Purpose |
|---|---|---|
| `--style <xml\|markdown\|json\|plain>` | `xml` | Output format. |
| `--no-compress` | off | Disable AST compression. |
| `--remove-comments` | off | Strip comments. |
| `--out <path>` | `<repo>/.codehub/pack/repo.<ext>` | Output file. |

## `code-pack`

Produce the deterministic 9-item code-pack BOM (manifest, skeleton,
file-tree, dependency list, top symbols, processes, routes, tools,
findings) sized to a token budget. This is the artifact attached to
every release and signed with cosign.

```bash title="usage"
codehub code-pack [path]
```

| Flag | Default | Purpose |
|---|---|---|
| `--budget <n>` | 100000 | AST-chunker token budget. |

## `query`

Hybrid BM25 + embedding search.

```bash title="usage"
codehub query <text>
```

| Flag | Default | Purpose |
|---|---|---|
| `--limit <n>` | 10 | Max results. |
| `--repo <name>` | current | Target repo (required when >1 indexed and no cwd match). |
| `--json` | off | Structured envelope. |
| `--content` | off | Include source content per result. |
| `--context <text>` | — | Extra context string for re-ranking. |
| `--goal <text>` | — | Goal string for re-ranking. |
| `--max-symbols <n>` | 50 | Cap on candidate symbols. |
| `--bm25-only` | off | Skip vector search. |
| `--rerank-top-k <n>` | 50 | Candidates fed into the re-ranker. |
| `--zoom` | off | Zoom into processes. |
| `--fanout <n>` | — | Fan-out per process. |
| `--granularity <symbol\|file\|community>` | `symbol` | Result granularity. |

## `context`

Callers, callees, and processes for one symbol.

```bash title="usage"
codehub context <symbol>
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--json` | off | Structured envelope. |
| `--target-uid <id>` | — | Disambiguate by graph UID. |
| `--file-path <hint>` | — | Disambiguate by file path suffix. |
| `--kind <kind>` | — | Disambiguate by kind (Function / Method / Class / Interface / ...). |

## `impact`

Blast radius for one symbol.

```bash title="usage"
codehub impact <symbol>
```

| Flag | Default | Purpose |
|---|---|---|
| `--depth <n>` | 3 | BFS depth. |
| `--direction <up\|down\|both>` | `both` | Traversal direction. |
| `--repo <name>` | current | Target repo. |
| `--json` | off | Structured envelope. |
| `--target-uid <id>` | — | Disambiguate by graph UID. |
| `--file-path <hint>` | — | Disambiguate by file path. |
| `--kind <kind>` | — | Disambiguate by kind. |

## `detect-changes`

Map a diff to symbols and processes.

```bash title="usage"
codehub detect-changes
```

| Flag | Default | Purpose |
|---|---|---|
| `--scope <unstaged\|staged\|all\|compare>` | `all` | Diff scope. |
| `--compare-ref <ref>` | — | Ref for `--scope compare`. |
| `--repo <name>` | current | Target repo. |
| `--json` | off | Structured envelope. |
| `--strict` | off | Exit 1 on MEDIUM as well. |

Exit codes: `0` OK, `1` HIGH/CRITICAL (or MEDIUM+ with `--strict`),
`2` caught error.

## `verdict`

5-tier PR verdict.

```bash title="usage"
codehub verdict
```

| Flag | Default | Purpose |
|---|---|---|
| `--base <ref>` | `main` | Base ref. |
| `--head <ref>` | `HEAD` | Head ref. |
| `--repo <name>` | current | Target repo. |
| `--json` | off | Emit JSON instead of Markdown. |

Exit codes: `auto_merge=0`, `single_review=1`, `dual_review=1`,
`expert_review=2`, `block=3`.

## `group`

Cross-repo group management.

```bash title="usage"
codehub group create <name> <repos...> [--description <text>]
codehub group list
codehub group delete <name>
codehub group status <name>
codehub group query <name> <text> [--limit <n>] [--json]
codehub group sync <name> [--json]
```

`--limit` defaults to 20 for `group query`.

## `ingest-sarif`

Ingest a SARIF 2.1.0 file into the graph as `Finding` nodes plus
`FOUND_IN` edges.

```bash title="usage"
codehub ingest-sarif <sarifFile>
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |

## `scan`

Run scanners and ingest findings.

```bash title="usage"
codehub scan [path]
```

| Flag | Default | Purpose |
|---|---|---|
| `--scanners <list>` | profile-gated | Comma-separated scanner ids. |
| `--with <list>` | — | Additional scanner ids to include. |
| `--output <file>` | `<repo>/.codehub/scan.sarif` | SARIF output path. |
| `--severity <list>` | `HIGH,CRITICAL` | Severity levels that fail the run. |
| `--repo <name>` | current | Target repo. |
| `--concurrency <n>` | — | Max parallel scanners. |
| `--timeout <ms>` | — | Per-scanner timeout. |

Exit codes: `0` clean, `1` findings at severity, `2` scanner crashed.

## `doctor`

Probe the environment.

```bash title="usage"
codehub doctor
```

| Flag | Default | Purpose |
|---|---|---|
| `--skip-native` | off | Skip checks that require native bindings (duckdb / lbug — `@duckdb/node-api` and `@ladybugdb/core`). Parsing has no native binding; it is WASM-only (`web-tree-sitter`) and unaffected by this flag. |
| `--repoRoot <path>` | cwd | Repo root to probe. |

## `bench`

Run the acceptance-gate bench suite and emit a dashboard.

```bash title="usage"
codehub bench
```

| Flag | Default | Purpose |
|---|---|---|
| `--acceptance <path>` | — | Override the path to `scripts/acceptance.sh`. |
| `--silent` | off | Suppress the listr2 progress renderer. |

## `wiki`

Emit a Markdown wiki for the repo.

```bash title="usage"
codehub wiki
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--json` | off | Emit a JSON summary on stdout. |
| `--offline` | off | Assert no network access (incompatible with `--llm`). |
| `--llm` | off | Route top-ranked modules through the summarizer. |
| `--max-llm-calls <n>` | 0 (dry-run) | LLM call budget. |
| `--llm-model <id>` | — | Override the Bedrock summary model id. |

## `ci-init`

Emit opinionated CI workflows.

```bash title="usage"
codehub ci-init
```

| Flag | Default | Purpose |
|---|---|---|
| `--platform <github\|gitlab\|both>` | auto-detect | Target CI. |
| `--main-branch <b>` | `main` | Base branch. |
| `--repo <path>` | cwd | Repo root. |
| `--force` | off | Overwrite existing workflows. |

## `augment`

Fast BM25 enrichment for editor PreToolUse hooks. Writes to stderr so
the hook can pipe it to the agent.

```bash title="usage"
codehub augment <pattern>
```

| Flag | Default | Purpose |
|---|---|---|
| `--limit <n>` | 5 | Max hits. |

## `sql`

Read-only SQL against the **temporal store** — the DuckDB-backed `cochanges` and
`symbol_summaries` tables. 5-second timeout by default. The node/edge graph lives
in `graph.lbug` (see ADR 0016) and is **not** reachable from this SQL path; query
it via the typed tools (`query` / `context` / `impact`) or Cypher via the MCP `sql`
tool.

```bash title="usage"
codehub sql <query>
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--timeout <ms>` | 5000 | Statement timeout. |
| `--json` | off | Structured envelope. |
