---
title: Monorepo map
description: Every OpenCodeHub workspace package, its folder, purpose, and key surface.
sidebar:
  order: 20
---

OpenCodeHub is a pnpm workspace under `packages/*`. Seventeen
TypeScript library packages plus the documentation site (eighteen
package directories in all). The CLI is the only binary; every other
package is a library imported by `cli`, `mcp`, `ingestion`, or
`analysis`.

## All packages

| Package | Folder | Purpose |
|---|---|---|
| `@opencodehub/analysis` | `packages/analysis` | `impact`, `detect_changes`, staleness, group cross-repo links. |
| `@opencodehub/cli` | `packages/cli` | The `codehub` binary (analyze, setup, mcp, query, context, impact, sql, group, scan, verdict, code-pack, ...). |
| `@opencodehub/cobol-proleap` | `packages/cobol-proleap` | Optional JVM ProLeap deep-parse bridge for COBOL — gated behind `--allow-build-scripts=proleap`. |
| `@opencodehub/core-types` | `packages/core-types` | Shared graph schema, `LanguageId`, `RelationType`, determinism primitives. |
| `@opencodehub/embedder` | `packages/embedder` | Deterministic ONNX embedder (`F2LLM-v2-80M`, 320-dim), modelId fingerprint, three-backend cascade. |
| `@opencodehub/frameworks` | `packages/frameworks` | Five-stage framework detector (manifest → lockfile → config-AST → folder → import/SCIP) over a curated registry. |
| `@opencodehub/ingestion` | `packages/ingestion` | The indexing pipeline (parse, resolve, scip-index, embeddings, communities, processes, summaries, ...). |
| `@opencodehub/mcp` | `packages/mcp` | The stdio MCP server, 29 tool registrations (all read-only with respect to user source), 7 resources, the error envelope, the staleness `_meta` block. |
| `@opencodehub/pack` | `packages/pack` | Deterministic 8-item code-pack BOM (the artifact attached to every release). |
| `@opencodehub/policy` | `packages/policy` | `opencodehub.policy.yaml` loader, validator, evaluator. |
| `@opencodehub/sarif` | `packages/sarif` | SARIF 2.1.0 Zod schemas, merge + enrich, suppressions, baseline diffing. |
| `@opencodehub/scanners` | `packages/scanners` | Nineteen scanner wrappers (semgrep, betterleaks, osv-scanner, bandit, biome, pip-audit, npm-audit, trivy, checkov, checkov-docker-compose, hadolint, tflint, spectral, ruff, grype, vulture, radon, ty, clamav). |
| `@opencodehub/scip-ingest` | `packages/scip-ingest` | `.scip` protobuf reader + per-language indexer runners (TypeScript, Python, Go, Rust, Java, .NET, clang, Kotlin, Ruby). |
| `@opencodehub/search` | `packages/search` | Hybrid BM25 + RRF search. |
| `@opencodehub/storage` | `packages/storage` | The `IGraphStore` / `ITemporalStore` interface segregation, the `SqliteStore` class that implements both over one `store.sqlite` via `node:sqlite`, and `openStore()` that returns it as both views. |
| `@opencodehub/summarizer` | `packages/summarizer` | Structured per-symbol summarizer (Haiku 4.5 via Bedrock Converse + Zod 4). |
| `@opencodehub/wiki` | `packages/wiki` | Markdown wiki renderer (architecture, api-surface, dependency-map, ownership-map, risk-atlas) over the graph. |
| `@opencodehub/docs` | `packages/docs` | This Starlight documentation site. |

## The CLI is the only bin

The only packaged executable is `codehub` under `@opencodehub/cli`.
Every other package is a library imported by `cli`, `mcp`, `ingestion`,
or `analysis`.

## Dependency direction

Think of it as two layers:

- **Leaf libraries.** `core-types`, `sarif`, `embedder`, `storage`,
  `search`, `summarizer`, `scip-ingest`, `frameworks`, `pack`,
  `policy`, `cobol-proleap`.
- **Orchestrators.** `ingestion`, `analysis`, `scanners`, `mcp`, `wiki`,
  `cli`.

Orchestrators import leaves; leaves do not import orchestrators. The
TypeScript project-references graph enforces this via `tsc --noEmit`.

## Storage — interface segregation

`@opencodehub/storage` exposes two narrow interfaces: `IGraphStore`
(graph workload: nodes, edges, embeddings, multi-hop traversal) and
`ITemporalStore` (temporal workload: cochanges, summary cache). The
single shipping class implements both:

- **`SqliteStore` over one `store.sqlite`** — always. One artifact on
  disk (`.codehub/store.sqlite`, WAL mode) backed by Node's built-in
  `node:sqlite`, holding nodes, edges, embeddings, the FTS5 index, and
  the temporal tables. One `SqliteStore` implements both `IGraphStore`
  and `ITemporalStore`; `openStore()` returns that one instance as both
  the `graph` and `temporal` views. There is no backend selector, no
  native binding, and no fallback (ADR 0019 removed both
  `@ladybugdb/core` and `@duckdb/node-api`).

See [Storage backend](/opencodehub/architecture/storage-backend/) for
how `openStore()` returns the single store as both views and the
community-adapter escape hatch (AGE / Memgraph / Neo4j / Neptune via
the segregated interfaces).

## Related files

- `pnpm-workspace.yaml` — `packages/*` glob.
- `.release-please-config.json` — which packages are versioned.
- `packages/*/package.json` — per-package `name` and `description`.
