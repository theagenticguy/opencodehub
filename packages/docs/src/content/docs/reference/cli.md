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
build BM25 + vector indexes, and write `.codehub/`.

```bash title="usage"
codehub analyze [path]
```

| Flag | Default | Purpose |
|---|---|---|
| `--force` | off | Ignore the registry cache and re-run the pipeline. |
| `--embeddings` | off | Compute semantic vectors. |
| `--embeddings-int8` | off | Use the int8 embedder variant (~81 MB) instead of fp32 (~321 MB). |
| `--granularity <csv>` | `symbol` | Any subset of `symbol,file,community`. |
| `--embeddings-workers <n\|auto>` | `auto` | Size of the ONNX worker pool. |
| `--embeddings-batch-size <n>` | 32 | Batch size per worker. |
| `--offline` | off | Zero sockets. |
| `--verbose` | off | Per-phase pipeline progress. |
| `--skip-agents-md` | off | Skip the AGENTS.md / CLAUDE.md stanza. |
| `--sbom` / `--no-sbom` | **on** | Emit `sbom.cyclonedx.json` + `sbom.spdx.json` from `Dependency` nodes. Use `--no-sbom` to suppress. |
| `--scan` / `--no-scan` | **on** | Run Priority-1 scanners, write `.codehub/scan.sarif`, and ingest findings into the graph. Network-backed scanners (osv-scanner, grype, npm/pip audit) self-skip under `--offline`. Use `--no-scan` to suppress. |
| `--coverage` / `--no-coverage` | **auto** | Overlay lcov / cobertura / jacoco / coverage.py reports onto `File` nodes. `auto` probes `coverage/lcov.info`, `lcov.info`, `coverage.xml`, `build/reports/jacoco/test/jacocoTestReport.xml`, `coverage.json` in that order and enables the phase when one exists (silent no-op otherwise). `--coverage` forces on and warns if nothing is found; `--no-coverage` forces off. |
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
| `--int8` | off | Use the int8 weight variant (~92 MB) instead of fp32 (~332 MB). |
| `--model-dir <path>` | — | Override the target directory for embedder weights. |
| `--plugin` | off | Install the Claude Code plugin to `~/.claude/plugins/opencodehub/`. |
| `--scip <tool>` | — | Install an external SCIP adapter binary: `clang`, `ruby`, `dotnet`, `kotlin`, or `all`. SHA256-pinned; `dotnet` requires .NET SDK 8+ on `PATH`. |
| `--cobol-proleap` | off | Build the `uwol/cobol-parser` library from source (`git clone` + `mvn install`) and compile the bridge wrapper. Requires `git`, `mvn`, and JDK 17+ on `PATH`. Installs under `~/.codehub/vendor/proleap/`. |

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

Produce the deterministic 8-item code-pack BOM sized to a token budget.
The BOM is `manifest.json` plus seven body items: skeleton, file-tree,
dependency list, ast-chunks, xrefs, findings, and licenses. A
consumer-facing `readme.md` ships alongside the BOM but is not part of
the manifest hash preimage. The pack is byte-identical given the same
`(commit, tokenizer, budget)`, and `packHash` names its on-disk
directory (`<repo>/.codehub/packs/<packHash>/`).

The default engine is `pack` (the `@opencodehub/pack` BOM). `--engine
repomix` opts into the legacy single-file snapshot (a single output
file, `bomItemCount` of 1, no manifest).

```bash title="usage"
codehub code-pack [path]
```

| Flag | Default | Purpose |
|---|---|---|
| `--budget <n>` | 100000 | AST-chunker token budget. |
| `--tokenizer <id>` | `openai:o200k_base@tiktoken-0.8.0` | Tokenizer pin `<vendor>:<name>@<pin>`. |
| `--out-dir <dir>` | `<repo>/.codehub/packs/<packHash>/` | Override the default output directory. |
| `--engine <pack\|repomix>` | `pack` | `pack` emits the 8-item BOM; `repomix` emits the legacy single-file snapshot. |
| `--explain-context` | off | After packing, print the context read-receipt (files indexed, lines, hash coverage, per-language breakdown) from `context-bom.json`. |
| `--json` | off | With `--explain-context` or `--variance-probe`, emit the result as JSON on stdout. |
| `--variance-probe <task-file>` | — | Measure the run-to-run answer variance an OCH pack removes from a coding agent. Loads the task file, generates the pack, runs the agent N times with vs. without the pack, and reports the dispersion delta plus token overhead. Agents run on Amazon Bedrock. On-demand only. |
| `--runs <n>` | 10 | With `--variance-probe`: runs per arm. |
| `--harness <claude\|codex>` | both | With `--variance-probe`: restrict to one agent. |
| `--aws-region <region>` | inherited `AWS_REGION` | With `--variance-probe`: AWS region for Bedrock inference. |
| `--model-claude <id>` | `us.anthropic.claude-sonnet-4-6` | With `--variance-probe`: Claude Code Bedrock model / inference-profile id. |
| `--model-codex <id>` | `openai.gpt-5.5` | With `--variance-probe`: Codex Bedrock model id. |

```bash title="example"
codehub code-pack . --budget 80000 --explain-context
```

## `replay`

Assert two code-packs are decision-equivalent (spec 011 / ADR 0020): the
same files and byte ranges selected under the same budget, regardless of
incidental drift in `tokenCount`, pins, or chunk text. `packHash` equality
is the cheap witness; a `decisionHash` projection is the contract. The
verdict is one of `EQUIVALENT`, `DIVERGED`, `BUDGET_MISMATCH`, or
`CORRUPT`. On-demand, never a CI gate.

```bash title="usage"
codehub replay --compare <pack-a> <pack-b>
```

| Flag | Default | Purpose |
|---|---|---|
| `--compare <packs...>` | — | **Required.** Exactly two pack directories (`.codehub/packs/<packHash>/`) to compare. |
| `--json` | off | Emit the full replay record (verdict, `decisionHash`es, diff) as JSON on stdout. |
| `--budget-strict` | off | Treat a `BUDGET_MISMATCH` (different `--budget` between the packs) as a failure exit. |

Exit codes: `EQUIVALENT` → 0, `BUDGET_MISMATCH` → 0 (or 1 with
`--budget-strict`), `DIVERGED` → 1, `CORRUPT` → 1.

```bash title="example"
codehub replay --compare .codehub/packs/abc123 .codehub/packs/def456 --json
```

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

## `change-pack`

Diff-scoped change-pack: the impacted subgraph, a PR verdict, affected
tests, and a cost estimate for one diff. CLI sibling of the `change_pack`
MCP tool, usable in CI without launching the MCP server.

```bash title="usage"
codehub change-pack
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--base <ref>` | `main` | Base git ref. |
| `--head <ref>` | `HEAD` | Head git ref. |
| `--depth <n>` | 4 | Upstream traversal depth. |
| `--min-confidence <f>` | 0.7 | Traversal confidence floor, 0 to 1. |
| `--budget <n>` | 100000 | Context budget in heuristic tokens. |
| `--include-tests-in-subgraph` | off | Retain test nodes in the impacted subgraph. |
| `--json` | off | Structured envelope. |

Exit codes mirror `verdict`: `auto_merge` / `single_review` → 0,
`dual_review` → 1, `expert_review` / `block` → 2.

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
| `--skip-native` | off | Skip the two probes that load a runtime module: the `node:sqlite` built-in WAL round-trip and the optional `onnxruntime-web` embedder (prebuilt WASM). The store has no native bindings, so this flag retains only these two checks; it is kept for compatibility with CI sandboxes. Parsing is WASM-only (`web-tree-sitter`) and is never skipped. |
| `--strict` | off | Treat a missing SCIP indexer as a failure (exit 2), not a warning. For release / CI gates. Vendored WASM grammars fail in both modes. |
| `--repoRoot <path>` | cwd | Repo root to probe. |

Exit codes: `0` all checks OK, `1` at least one warning, `2` at least
one failure.

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

Emit a Markdown wiki for the repo under `--output`. Deterministic:
every page is rendered from the graph, so the same commit produces the
same wiki.

```bash title="usage"
codehub wiki --output <dir>
```

| Flag | Default | Purpose |
|---|---|---|
| `--output <dir>` | — | **Required.** Target directory for rendered pages. |
| `--repo <name>` | current | Target repo. |
| `--json` | off | Emit a JSON summary on stdout. |
| `--offline` | off | Assert no network access. |

```bash title="example"
codehub wiki --output docs/wiki
```

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

Read-only SQL against the single-file store, `<repo>/.codehub/store.sqlite`
(WAL, via Node's built-in `node:sqlite`, ADR 0019). Every table lives in
this one file and is directly queryable: `nodes`, `edges`, `embeddings`,
`cochanges`, and `store_meta`. Reach kind-specific
fields on `nodes` via SQLite JSON1, e.g. `payload->>'$.field'`. The guard
rejects any mutation. 5-second timeout by default.

The typed tools (`query` / `context` / `impact`) remain the high-level
path for graph traversal. A `cypher` query path exists only as a reserved
escape hatch for community-fork graph adapters (AGE / Memgraph / Neo4j /
Neptune) and is not supported by the default backend.

```bash title="usage"
codehub sql <query>
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--timeout <ms>` | 5000 | Statement timeout. |
| `--json` | off | Structured envelope. |

```bash title="example"
codehub sql "SELECT id, name FROM nodes WHERE kind = 'Function' LIMIT 10"
```

## Read-only graph capabilities

Each command below is a CLI sibling of an MCP tool, reusing the same
underlying reader against the single-file store. They run in CI without
launching the MCP server.

## `findings`

List SARIF `Finding` nodes (sibling of the MCP `list_findings` tool).

```bash title="usage"
codehub findings
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--severity <level>` | — | Restrict to one SARIF severity: `error`, `warning`, `note`, or `none`. |
| `--scanner <id>` | — | Restrict to a single scanner id (e.g. `semgrep`). |
| `--rule-id <id>` | — | Restrict to a single rule id. |
| `--file-path <hint>` | — | Substring filter on the finding's file path. |
| `--limit <n>` | 500 | Maximum findings to return. |
| `--json` | off | Structured envelope. |

```bash title="example"
codehub findings --severity error --scanner semgrep
```

## `dead-code`

List dead and unreachable-export symbols (sibling of the MCP
`list_dead_code` tool).

```bash title="usage"
codehub dead-code
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--file-path-pattern <hint>` | — | Substring filter on each symbol's file path. |
| `--include-unreachable-exports` | off | Also include exported-but-unreferenced symbols. |
| `--limit <n>` | 100 | Maximum symbols to return. |
| `--json` | off | Structured envelope. |

```bash title="example"
codehub dead-code --include-unreachable-exports
```

## `license-audit`

Classify `Dependency` nodes by license risk tier (sibling of the MCP
`license_audit` tool).

```bash title="usage"
codehub license-audit
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--json` | off | Structured envelope. |

```bash title="example"
codehub license-audit --json
```

## `project-profile`

Show the detected project profile (sibling of the MCP `project_profile`
tool).

```bash title="usage"
codehub project-profile
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--json` | off | Structured envelope. |

```bash title="example"
codehub project-profile
```

## `risk-trends`

Per-community risk trend plus a 30-day projection (sibling of the MCP
`risk_trends` tool).

```bash title="usage"
codehub risk-trends
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--json` | off | Structured envelope. |

```bash title="example"
codehub risk-trends --json
```

## `owners`

List ranked `OWNED_BY` contributors for a node (sibling of the MCP
`owners` tool).

```bash title="usage"
codehub owners <target>
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--limit <n>` | 20 | Maximum contributors to return. |
| `--json` | off | Structured envelope. |

```bash title="example"
codehub owners src/auth/session.ts
```

## `route-map`

Map HTTP routes to handlers and consumers (sibling of the MCP
`route_map` tool).

```bash title="usage"
codehub route-map
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--route <hint>` | — | Substring match against `Route.url` (e.g. `/api/users`). |
| `--method <verb>` | — | Exact match against `Route.method` (e.g. `GET`). |
| `--json` | off | Structured envelope. |

```bash title="example"
codehub route-map --route /api/users --method GET
```

## `api-impact`

Score the blast radius of changing a `Route`'s contract (sibling of the
MCP `api_impact` tool).

```bash title="usage"
codehub api-impact
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--route <hint>` | — | Substring match against `Route.url`. |
| `--file <hint>` | — | Substring match against `Route.filePath`. |
| `--json` | off | Structured envelope. |

```bash title="example"
codehub api-impact --route /api/users
```

## `dependencies`

List external dependencies (sibling of the MCP `dependencies` tool).

```bash title="usage"
codehub dependencies
```

| Flag | Default | Purpose |
|---|---|---|
| `--repo <name>` | current | Target repo. |
| `--ecosystem <id>` | — | Restrict to one ecosystem: `npm`, `pypi`, `go`, `cargo`, `maven`, or `nuget`. |
| `--file-path <hint>` | — | Substring filter on the manifest / lockfile path. |
| `--limit <n>` | 500 | Maximum dependencies to return. |
| `--json` | off | Structured envelope. |

```bash title="example"
codehub dependencies --ecosystem npm
```
