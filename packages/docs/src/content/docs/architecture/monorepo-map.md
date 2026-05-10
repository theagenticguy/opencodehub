---
title: Monorepo map
description: Every OpenCodeHub workspace package, its folder, purpose, and key surface.
sidebar:
  order: 20
---

OpenCodeHub is a pnpm workspace under `packages/*`. Seventeen
TypeScript packages plus the documentation site. The CLI is the only
binary; every other package is a library imported by `cli`, `mcp`,
`ingestion`, or `analysis`.

## All packages

| Package | Folder | Purpose |
|---|---|---|
| `@opencodehub/analysis` | `packages/analysis` | `impact`, `rename`, `detect_changes`, staleness, group cross-repo links. |
| `@opencodehub/cli` | `packages/cli` | The `codehub` binary (analyze, setup, mcp, query, context, impact, sql, group, scan, verdict, code-pack, ...). |
| `@opencodehub/cobol-proleap` | `packages/cobol-proleap` | Optional JVM ProLeap deep-parse bridge for COBOL — gated behind `--allow-build-scripts=proleap`. |
| `@opencodehub/core-types` | `packages/core-types` | Shared graph schema, `LanguageId`, `RelationType`, determinism primitives. |
| `@opencodehub/embedder` | `packages/embedder` | Deterministic ONNX embedder (`gte-modernbert-base`), modelId fingerprint, three-backend cascade. |
| `@opencodehub/frameworks` | `packages/frameworks` | Five-stage framework detector (manifest → lockfile → config-AST → folder → import/SCIP) over a curated registry. |
| `@opencodehub/ingestion` | `packages/ingestion` | The indexing pipeline (parse, resolve, scip-index, embeddings, communities, processes, summaries, ...). |
| `@opencodehub/mcp` | `packages/mcp` | The stdio MCP server, 29 tool registrations, 7 resources, the error envelope, the staleness `_meta` block. |
| `@opencodehub/pack` | `packages/pack` | Deterministic 9-item code-pack BOM (the artifact attached to every release). |
| `@opencodehub/policy` | `packages/policy` | `opencodehub.policy.yaml` loader, validator, evaluator. |
| `@opencodehub/sarif` | `packages/sarif` | SARIF 2.1.0 Zod schemas, merge + enrich, suppressions, baseline diffing. |
| `@opencodehub/scanners` | `packages/scanners` | Twenty scanner wrappers (semgrep, osv-scanner, bandit, ruff, grype, vulture, pip-audit, npm-audit, biome, betterleaks, detect-secrets, trivy, checkov, hadolint, tflint, spectral, radon, ty, clamav, och self-scan). |
| `@opencodehub/scip-ingest` | `packages/scip-ingest` | `.scip` protobuf reader + per-language indexer runners (TypeScript, Python, Go, Rust, Java, .NET, clang, Kotlin, Ruby). |
| `@opencodehub/search` | `packages/search` | Hybrid BM25 + RRF search. |
| `@opencodehub/storage` | `packages/storage` | The `IGraphStore` / `ITemporalStore` interface segregation, the LadybugDB and DuckDB adapters, the resolver that picks between them. |
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

## Storage — the M7 segregation

`@opencodehub/storage` exposes two narrow interfaces — `IGraphStore`
(graph workload: nodes, edges, embeddings, multi-hop traversal) and
`ITemporalStore` (temporal workload: cochanges, summary cache). Two
adapters implement them:

- **LadybugDB graph store + DuckDB temporal store** — the default. Two
  artifacts on disk (`graph.lbug` + `temporal.duckdb`), backed by a
  Cypher-emitting dialect for the graph half and DuckDB SQL for the
  temporal half.
- **Single DuckDB file** — the legacy fallback. One artifact
  (`graph.duckdb`) backs both interfaces.

See [Storage backend](/opencodehub/architecture/storage-backend/) for
the resolver, the dual-artifact precedence rule, and the
community-adapter escape hatch (AGE / Memgraph / Neo4j / Neptune).

## Related files

- `pnpm-workspace.yaml` — `packages/*` glob.
- `.release-please-config.json` — which packages are versioned.
- `packages/*/package.json` — per-package `name` and `description`.
