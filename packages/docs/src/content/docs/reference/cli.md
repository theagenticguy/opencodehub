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
| `--force` | off | Rebuild even if the no-op short-circuit fires. |
| `--embeddings` | off | Compute semantic vectors. |
| `--embeddings-int8` | off | Quantise vectors to int8. |
| `--granularity <csv>` | `symbol` | Any subset of `symbol,file,community`. |
| `--embeddings-workers <n\|auto>` | auto | Size of the embedding worker pool. |
| `--embeddings-batch-size <n>` | 32 | Batch size per worker. |
| `--offline` | off | Zero sockets. |
| `--verbose` | off | Noisier logs. |
| `--skip-agents-md` | off | Skip AGENTS.md ingestion. |
| `--sbom` | off | Emit `sbom.cdx.json` alongside the index. |
| `--coverage` | off | Bridge coverage data into the graph. |
| `--summaries` / `--no-summaries` | on | LLM-generated symbol summaries. |
| `--max-summaries <n\|auto>` | auto (10% of callables, cap 500) | Summary budget. |
| `--summary-model <id>` | — | Override the summary model. |
| `--skills` | off | Emit Claude Code skills. |
| `--wasm-only` | off | Force WASM tree-sitter; sets `OCH_WASM_ONLY=1`. |
| `--strict-detectors` | off | Fail the build if DET-O-001 regresses. |

Exit codes: `0` success, `1` caught error.

## `index`

Register an existing `.codehub/` into `~/.codehub/registry.json` without
re-analysing.

```bash title="usage"
codehub index [paths...]
```

| Flag | Default | Purpose |
|---|---|---|
| `--force` | off | Overwrite an existing registry entry. |
| `--allow-non-git` | off | Permit registering a repo with no `.git`. |

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
| `--force` | off | Overwrite existing entries. |
| `--undo` | off | Remove only the `codehub` entry each writer added. |
| `--embeddings` | off | Download the embedder model weights. |
| `--int8` | off | Download int8-quantised weights. |
| `--model-dir <path>` | — | Custom weights directory. |
| `--plugin` | off | Install the Claude Code plugin. |

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

Emit a single-file, LLM-ready, AST-compressed snapshot of the repo
(powered by repomix).

```bash title="usage"
codehub pack [path]
```

| Flag | Default | Purpose |
|---|---|---|
| `--style <xml\|markdown\|json\|plain>` | `xml` | Output format. |
| `--no-compress` | off | Disable AST compression. |
| `--remove-comments` | off | Strip comments. |
| `--out <path>` | — | Output file. |

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
| `--granularity <symbol\|file\|community>` | symbol | Result granularity. |

## `context`

Callers, callees, and processes for one symbol.

```bash title="usage"
codehub context <symbol>
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--json` | off | Structured envelope. |

## `impact`

Blast-radius for one symbol.

```bash title="usage"
codehub impact <symbol>
```

| Flag | Default | Purpose |
|---|---|---|
| `--depth <n>` | 3 | BFS depth. |
| `--direction <up\|down\|both>` | both | Traversal direction. |
| `--repo <name>` | current | Target repo. |
| `--json` | off | Structured envelope. |
| `--target-uid <id>` | — | Disambiguate by graph UID. |
| `--file-path <hint>` | — | Disambiguate by file. |
| `--kind <Function\|Method\|Class\|Interface\|...>` | — | Disambiguate by kind. |

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

Exit codes: `0` OK, `1` HIGH/CRITICAL (or MEDIUM+ `--strict`), `2` caught error.

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
| `--json` | off | Structured envelope. |

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

Run Priority-1 scanners and ingest findings.

```bash title="usage"
codehub scan [path]
```

| Flag | Default | Purpose |
|---|---|---|
| `--scanners <list>` | all | Scanner IDs. |
| `--with <list>` | — | Additional scanners. |
| `--output <file>` | `<repo>/.codehub/scan.sarif` | SARIF output path. |
| `--severity <list>` | `HIGH,CRITICAL` | Gate severity. |
| `--repo <name>` | current | Target repo. |
| `--concurrency <n>` | — | Scanner concurrency. |
| `--timeout <ms>` | — | Per-scanner timeout. |

Exit codes: `0` clean, `1` findings at severity, `2` scanner crashed.

## `doctor`

Probe the environment.

```bash title="usage"
codehub doctor
```

| Flag | Default | Purpose |
|---|---|---|
| `--skip-native` | off | Skip native-module probes. |
| `--repoRoot <path>` | cwd | Repo root to probe. |

## `bench`

Run the acceptance-gate bench suite and emit a dashboard.

```bash title="usage"
codehub bench
```

| Flag | Default | Purpose |
|---|---|---|
| `--acceptance <path>` | — | Acceptance manifest. |
| `--silent` | off | Suppress console output. |

## `wiki`

Emit a Markdown wiki for the repo.

```bash title="usage"
codehub wiki
```

| Flag | Default | Purpose |
|---|---|---|
| `--output <dir>` | required | Destination directory. |
| `--repo <name>` | current | Target repo. |
| `--json` | off | Structured envelope. |
| `--offline` | off | Incompatible with `--llm`. |
| `--llm` | off | Enrich with LLM prose. |
| `--max-llm-calls <n>` | 0 (dry-run) | Budget. |
| `--llm-model <id>` | — | Override LLM model. |

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
| `--force` | off | Overwrite. |

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

Read-only SQL against the graph store.

```bash title="usage"
codehub sql <query>
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--timeout <ms>` | 5000 | Statement timeout. |
| `--json` | off | Structured envelope. |
