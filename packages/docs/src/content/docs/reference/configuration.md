---
title: Configuration
description: Environment variables, on-disk layout, registry, and editor setup targets.
sidebar:
  order: 20
---

## Environment variables

| Name | Purpose |
|---|---|
| `OCH_WASM_ONLY` | Force the WASM fallback for every tree-sitter grammar. Set to `1` by `codehub analyze --wasm-only`. |
| `CODEHUB_HOME` | Override `~/.codehub/` (where the registry and embedder weights live). |
| `CODEHUB_EMBEDDING_URL` | Endpoint URL for an external embedding service. |
| `CODEHUB_EMBEDDING_MODEL` | Model ID to request from the embedding service. |
| `CODEHUB_EMBEDDING_DIMS` | Integer dimensionality of the embedding model. |
| `CODEHUB_EMBEDDING_API_KEY` | API key for the embedding service (sent as `Authorization: Bearer ...`). |
| `NO_COLOR` | Standard convention; disables colored console output. |

## On-disk layout: `.codehub/`

`codehub analyze` writes everything under `<repo-root>/.codehub/`:

| Path | Purpose |
|---|---|
| `graph.duckdb` | Primary DuckDB database: symbols, edges, processes, embeddings. |
| `meta.json` | Index metadata: graph hash, node counts, CLI version, toolchain pins. |
| `scan.sarif` | SARIF output from `codehub scan`. |
| `sbom.cdx.json` | CycloneDX SBOM when `codehub analyze --sbom` has run. |
| `coverage/` | Coverage bridge artefacts when `--coverage` has run. |

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
