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

### Storage backend

| Variable | Purpose |
|---|---|
| `CODEHUB_STORE` | `lbug` forces LadybugDB; `duck` forces the single-file DuckDB layout. Unset (the default) means probe `@ladybugdb/core` and use LadybugDB when the binding is importable, otherwise fall back to DuckDB. |
| `CODEHUB_HOME` | Override `~/.codehub/` (where the registry, embedder weights, and global state live). |
| `OCH_VERBOSE` | Set to `1` to surface the storage-backend probe advisory in non-TTY environments. |

ADR 0013 (`docs/adr/0013-m7-default-flip-and-abstraction.md`) records
the LadybugDB-default decision and the `IGraphStore` / `ITemporalStore`
interface segregation.

### Parse runtime

| Variable | Purpose |
|---|---|
| `OCH_NATIVE_PARSER` | Set to `1` on Node 22 to opt into the native `tree-sitter` N-API addon. The default runtime on Node 22 and Node 24 is `web-tree-sitter` (WASM). |

The `--native-parser` CLI flag is equivalent. ADR
0013-parse-runtime-wasm-default records the WASM-default decision.

### Embedding backends

The cascade is **SageMaker → HTTP → ONNX**. The first variable group
that resolves wins; the others are ignored.

| Variable | Purpose |
|---|---|
| `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` | SigV4-authenticated SageMaker endpoint name. When set, the SageMaker backend wins. |
| `CODEHUB_EMBEDDING_SAGEMAKER_REGION` | Override the AWS region for the SageMaker call. |
| `CODEHUB_EMBEDDING_URL` | Base URL for an OpenAI-compatible HTTP endpoint (Infinity, vLLM, TEI, Ollama, LM Studio, OpenAI). `/embeddings` is appended. |
| `CODEHUB_EMBEDDING_MODEL` | Model id passed through to the HTTP endpoint verbatim. |
| `CODEHUB_EMBEDDING_DIMS` | Dimensionality of the embedding model. Default 768. |
| `CODEHUB_EMBEDDING_API_KEY` | Bearer token sent as `Authorization: Bearer ...`. |

When none of the above are set, the local ONNX backend
(`gte-modernbert-base`, deterministic, offline-safe) is used.

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
exact files depend on the backend selected at index time.

### LadybugDB (default)

| Path | Purpose |
|---|---|
| `graph.lbug` | LadybugDB graph store — nodes, edges, embeddings. |
| `temporal.duckdb` | Sibling DuckDB file — temporal store (cochanges, symbol-summary cache). |
| `meta.json` | Index metadata: graph hash, node counts, CLI version, backend, embedder model id. |
| `scan.sarif` | SARIF output from `codehub scan`. |
| `sbom.cyclonedx.json` / `sbom.spdx.json` | SBOMs when `codehub analyze --sbom` has run. |

### DuckDB (opt-in fallback)

| Path | Purpose |
|---|---|
| `graph.duckdb` | Single DuckDB file — nodes, edges, embeddings, and temporal views in one place. |
| `meta.json` | Same shape as the LadybugDB layout. |
| `scan.sarif` | SARIF output from `codehub scan`. |

When both `graph.lbug` and `graph.duckdb` exist as siblings, the
newer-`mtime` file wins.

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
