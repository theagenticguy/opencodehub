---
title: Monorepo map
description: Every OpenCodeHub workspace package, its folder, purpose, versioning, and key exports.
sidebar:
  order: 20
---

OpenCodeHub is a pnpm workspace under `packages/*`. Fourteen TypeScript
packages plus one Python harness (15 total). Ten of the TypeScript
packages are versioned independently by release-please; the rest are
internal harnesses or the Starlight docs site that ride along with the
monorepo version. The Python eval lives outside the pnpm package graph
entirely.

## All packages

| Package                     | Folder                 | Versioned? | Purpose                                                   | Key surface                                    |
|-----------------------------|------------------------|------------|-----------------------------------------------------------|------------------------------------------------|
| `@opencodehub/analysis`     | `packages/analysis`    | yes        | `impact`, `rename`, `detect_changes`, staleness logic    | `computeImpact()`, `computeRename()`           |
| `@opencodehub/cli`          | `packages/cli`         | yes        | User-facing CLI                                           | `codehub` bin                                  |
| `@opencodehub/core-types`   | `packages/core-types`  | yes        | Shared graph schema, `LanguageId`, determinism primitives | `LanguageId`, `SCIP_PROVENANCE_PREFIXES`       |
| `@opencodehub/embedder`     | `packages/embedder`    | yes        | Deterministic ONNX embedder (gte-modernbert-base)         | `embed()`, `embedInt8()`                       |
| `@opencodehub/ingestion`    | `packages/ingestion`   | yes        | 12-phase analyze pipeline, tree-sitter, language providers | `LanguageProvider` registry, pipeline phases   |
| `@opencodehub/mcp`          | `packages/mcp`         | yes        | stdio MCP server, tools, resources, prompts               | `buildServer()`                                |
| `@opencodehub/sarif`        | `packages/sarif`       | yes        | SARIF 2.1.0 Zod schemas, merge + enrich                   | `SarifLogSchema`, `mergeSarif()`               |
| `@opencodehub/scanners`     | `packages/scanners`    | yes        | Priority-1 scanner wrappers (semgrep, osv, etc.)          | Subprocess runners                             |
| `@opencodehub/search`       | `packages/search`      | yes        | Hybrid BM25 + RRF search                                  | `hybridSearch()`                               |
| `@opencodehub/storage`      | `packages/storage`     | yes        | DuckDB graph store (`@duckdb/node-api` + `hnsw_acorn` + `fts`) | `IGraphStore`                              |
| `@opencodehub/docs`         | `packages/docs`        | no         | Starlight documentation site (Astro + starlight-llms-txt)  | `pnpm -F @opencodehub/docs build`             |
| `@opencodehub/gym`          | `packages/gym`         | no         | SCIP-indexer differential gym + regression gates          | `codehub-gym` bin                              |
| `@opencodehub/scip-ingest`  | `packages/scip-ingest`  | no         | `.scip` protobuf reader + per-language indexer runners    | `readScipFile()`, per-language runners         |
| `@opencodehub/summarizer`   | `packages/summarizer`  | no         | Structured code-symbol summarizer (Bedrock Converse + Zod) | `summarizeSymbol()`                           |
| `opencodehub-eval`          | `packages/eval`        | no (Python) | Parity + regression eval harness (98 core cases)        | `pytest` suite driven by MCP stdio             |

## Versioning

Ten packages get their own tag and changelog via `release-please`. They
are the public surface — anyone who takes a `peerDependency` on
OpenCodeHub gets versioned guarantees on these.

The five unversioned packages (`docs`, `gym`, `scip-ingest`,
`summarizer`, `eval`) are harnesses, the documentation site, or
internal-only dependencies with no external consumer at v1.0. They move
in lockstep with the monorepo but do not publish independent tags. See
[Release process](/opencodehub/contributing/release-process/) for the
full table.

## The CLI is the only bin

The only packaged executable is `codehub` under `@opencodehub/cli`.
`@opencodehub/gym` exposes a `codehub-gym` bin for internal harness
use; it is not distributed separately.

Every other package is a library imported by `cli`, `mcp`, or the
ingestion pipeline.

## Dependency direction

Think of it as two layers:

- **Leaf libraries.** `core-types`, `sarif`, `embedder`, `storage`,
  `search`, `summarizer`, `scip-ingest`.
- **Orchestrators.** `ingestion`, `analysis`, `scanners`, `mcp`,
  `gym`, `cli`.

Orchestrators import leaves; leaves do not import orchestrators. The
TypeScript project-references graph enforces this via
`tsc --noEmit`.

## Python eval lives outside the graph

`packages/eval` is a uv-managed Python project (Python 3.12, pytest,
anyio, mcp). It sits in the monorepo for colocation but is not in the
pnpm workspace. Run it with `mise run test:eval`; see
[Testing](/opencodehub/contributing/testing/#python-eval-harness).

## Related files

- `pnpm-workspace.yaml` — `packages/*` glob.
- `.release-please-config.json` — which packages are versioned.
- `packages/*/package.json` — per-package `name` and `description`.
