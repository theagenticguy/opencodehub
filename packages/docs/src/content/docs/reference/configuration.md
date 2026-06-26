---
title: Configuration
description: Environment variables, on-disk layout, registry, and editor setup targets.
sidebar:
  order: 20
---

## Environment variables

OpenCodeHub honours a small, stable set of environment variables. Each
variable is read from `process.env` at the entry point that owns it
(CLI, MCP server, ingestion phase, embedder backend); none of them
mutate global state.

### Storage

The graph tier is always LadybugDB (`graph.lbug`) and the temporal tier
is always DuckDB (`temporal.duckdb`). There is no backend selector — the
`CODEHUB_STORE` env var was removed in ADR 0016 along with the probe and
the DuckDB-as-graph fallback. If the LadybugDB binding cannot load,
`open()` throws `GraphDbBindingError`.

| Variable | Purpose |
|---|---|
| `CODEHUB_HOME` | Override `~/.codehub/` (where the registry, embedder weights, and global state live). |

ADR 0013 (`docs/adr/0013-m7-default-flip-and-abstraction.md`) records
the `IGraphStore` / `ITemporalStore` interface segregation; ADR 0016
(`docs/adr/0016-duckdb-graph-rip.md`) records the rip-out of the DuckDB
graph backend, the env var, and the resolver.

### Parse runtime

`web-tree-sitter` (WASM) is the only parse runtime on Node 20, 22, and
24. There is no env var or CLI flag to switch parsers — the native
`tree-sitter` N-API addon was removed in 0.4.0. The CLI emits a
one-shot stderr advisory if a stale legacy env var is set, then ignores
it; consult the CHANGELOG and ADR 0015 for the variable name and
migration notes. ADR 0013 records the prior WASM-default + native-opt-in
posture and is superseded by ADR 0015
(`docs/adr/0015-wasm-only-parser-at-the-npm-distributed-boundary.md`).

### Embedding backends

The cascade is **SageMaker → HTTP → ONNX**. The first variable group
that resolves wins; the others are ignored.

| Variable | Purpose |
|---|---|
| `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` | SigV4-authenticated SageMaker endpoint name. When set, the SageMaker backend wins. |
| `CODEHUB_EMBEDDING_SAGEMAKER_REGION` | Override the AWS region for the SageMaker call. |
| `CODEHUB_EMBEDDING_URL` | Base URL for an OpenAI-compatible HTTP endpoint (Infinity, vLLM, TEI, Ollama, LM Studio, OpenAI). `/embeddings` is appended. |
| `CODEHUB_EMBEDDING_MODEL` | Model id passed through to the HTTP endpoint verbatim. |
| `CODEHUB_EMBEDDING_DIMS` | Dimensionality of the embedding model. Default 320. |
| `CODEHUB_EMBEDDING_API_KEY` | Bearer token sent as `Authorization: Bearer ...`. |

When none of the above are set, the local ONNX backend
(`F2LLM-v2-80M`, 320-dim, deterministic, offline-safe) is used.

### Other toggles

| Variable | Purpose |
|---|---|
| `CODEHUB_DISABLE_SCIP` | Set to `1` to make the `scip-index` ingestion phase a no-op. Heuristic edges still flow. |
| `CODEHUB_ALLOW_BUILD_SCRIPTS` | Set to `1` to allow SCIP indexers that require a build (Rust, Java) to run. Off by default for clean-room safety. |
| `CODEHUB_BEDROCK_SUMMARIES` | Set to `1` to opt the LLM summarize phase in. Equivalent to `--summaries`. Off by default — `codehub analyze` runs fast, local, deterministic phases only. |
| `CODEHUB_BEDROCK_DISABLED` | Set to `1` to force-disable the LLM summarize phase. Equivalent to `--no-summaries`. Wins over `CODEHUB_BEDROCK_SUMMARIES=1` and `--summaries`. |
| `NO_COLOR` | Standard convention; disables colored console output. |

## On-disk layout: `.codehub/`

`codehub analyze` writes everything under `<repo-root>/.codehub/`. The
layout is fixed: a LadybugDB graph file alongside a DuckDB temporal
file.

| Path | Purpose |
|---|---|
| `graph.lbug` | LadybugDB graph store — nodes, edges, embeddings, BM25 + HNSW indexes. |
| `temporal.duckdb` | Sibling DuckDB file — temporal store (cochanges, symbol-summary cache). |
| `meta.json` | Index metadata: graph hash, node counts, CLI version, embedder model id. |
| `scan.sarif` | SARIF output from `codehub scan`. |
| `sbom.cyclonedx.json` / `sbom.spdx.json` | SBOMs when `codehub analyze --sbom` has run. |

Safe to delete and rebuild at any time via `codehub clean` +
`codehub analyze`.

## Registry: `~/.codehub/registry.json`

The registry maps each registered repo to its index path. It is
consulted by:

- Every per-repo MCP tool that accepts an optional `repo` argument.
- `codehub list`, `codehub status`, `codehub clean --all`.
- `codehub group create` when resolving repo names.

`CODEHUB_HOME` relocates the parent directory.

## `codehub setup` targets

Each editor writer has a fixed target path and merges a `codehub`
entry non-destructively:

| Editor | Path | Format |
|---|---|---|
| `claude-code` | `<project>/.mcp.json` | JSON |
| `cursor` | `~/.cursor/mcp.json` | JSON |
| `codex` | `~/.codex/config.toml` | TOML |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | JSON |
| `opencode` | `<project>/opencode.json` | JSON |

`--undo` removes only the `codehub` entry each writer added; other
entries are preserved.
