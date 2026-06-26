# OpenCodeHub

[![CI](https://github.com/theagenticguy/opencodehub/actions/workflows/ci.yml/badge.svg)](https://github.com/theagenticguy/opencodehub/actions/workflows/ci.yml)
[![CodeQL](https://github.com/theagenticguy/opencodehub/actions/workflows/codeql.yml/badge.svg)](https://github.com/theagenticguy/opencodehub/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/theagenticguy/opencodehub/badge)](https://securityscorecards.dev/viewer/?uri=github.com/theagenticguy/opencodehub)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-ready-green)](https://modelcontextprotocol.io)

> **Code intelligence for AI coding agents, under Apache-2.0, on an all-OSS stack.**

```bash
npm install -g @opencodehub/cli
cd /path/to/your/repo
codehub init && codehub analyze
# your agent now has impact, query, context, detect_changes — 28 tools over MCP
```

## Why this exists

AI coding agents have a structural blind spot: they can see a file, but
they can't see the *graph* the file lives in. This causes three recurring
failures that anyone who has shipped with a coding agent has lived through:

1. **Missed dependencies.** The agent renames a function and doesn't
   touch the 14 callers it can't see, because `grep` found 3.
2. **Broken call chains.** The agent changes a return shape, the handler
   two hops downstream explodes at runtime, and neither the agent nor
   its tests flag it — the relationship was never in context.
3. **Blind edits.** The agent edits a critical-path function without
   knowing it's on the hot path of 8 production flows, because nothing
   computed that ahead of time.

Grep is textual. Language servers are per-file. Embeddings are lossy.
None of them answer the questions an agent actually needs answered
*before* it writes a diff: **what breaks if I change this? what depends
on this? where does this data flow?**

## What OpenCodeHub solves

OpenCodeHub indexes your repository into a **hybrid knowledge graph**
(structural + semantic) and exposes it to agents over the **Model
Context Protocol**. Agents stop guessing and start asking:

```
impact(target: "validateUser")
→ direct callers: 14 · affected processes: 3 · risk: HIGH
→ fix direction: dependents (input validation boundary)

query("auth token refresh flow")
→ process: auth.refresh_token (7 steps, 4 files)
→ process: oauth.rotate_session (5 steps, 3 files)

context(name: "PaymentProcessor")
→ callers · callees · processes it participates in · ACCESSES edges · docstrings
```

The graph is **precomputed at index time** — clustering, execution-flow
tracing, and blast-radius analysis are done once, not at every query.
That means agents get complete relational context in one tool call, not
ten round-trips.

```mermaid
flowchart LR
  A[Source tree] -->|tree-sitter parse| B[Symbol graph]
  B -->|resolve imports / MRO| C[Typed relations]
  C -->|BM25 + HNSW index| D[Hybrid graph store]
  C -->|detect communities + flows| E[Processes / clusters]
  D --> F[MCP server]
  E --> F
  F -->|28 tools| G[AI coding agent]
```

## Design choices worth knowing

| Choice | Why it matters |
|---|---|
| **Apache-2.0, end to end** | Every runtime dep is OSI-approved permissive. No PolyForm, BSL, Commons Clause, Elastic v2, GPL, or AGPL. You can fork, embed, and ship commercial products on top without a license-review detour. |
| **Local-first, offline-capable** | `codehub analyze --offline` opens zero sockets. Your code never leaves your machine. No telemetry. |
| **Deterministic indexing** | Identical inputs produce a byte-identical graph hash. Reproducible. Auditable. Cacheable in CI. |
| **MCP-native** | Works out-of-the-box with Claude Code, Cursor, Codex, Windsurf, OpenCode. The MCP server is the primary interface; CLI exists for scripts and CI. |
| **Single-file embedded storage** | One `store.sqlite` file holds everything — symbols, edges, embeddings, BM25 (FTS5) + HNSW traversal, and the temporal views (cochanges, summaries) — via Node's built-in `node:sqlite`. No daemon, no database to operate, and **zero native storage bindings** (ADR 0019 removed both `@ladybugdb/core` and `@duckdb/node-api`). |
| **15 languages at GA** | TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++, Ruby, Kotlin, Swift, PHP, Dart, COBOL — tree-sitter for the first 14 plus a regex provider for fixed-format COBOL. |
| **WASM-only parse runtime** | `web-tree-sitter` WASM is the only parse runtime. The 15 grammar `.wasm` blobs are vendored at `packages/ingestion/vendor/wasms/`, so parsing does **zero grammar/native builds and zero GitHub fetches** at install time — there is no native parser opt-in. Storage is pure `node:sqlite`; the only optional native dep is the local embedder (see Platform support). |

## Platform support

Parsing is WASM and storage is pure `node:sqlite`, so the core runs anywhere
Node ≥ 24.15 does — no prebuilt native storage bindings, no Docker, no
postinstall compile (ADR 0019). There is exactly **one** optional native
dependency: `onnxruntime-web`, the WASM ONNX runtime that powers
`--embeddings`. It ships prebuilt WebAssembly (no node-gyp, no native
binding) and runs single-threaded under Node, so it too is platform-agnostic;
a BM25-only install never loads it.

| Platform | Supported |
|---|---|
| `darwin-arm64`, `darwin-x64` | ✅ |
| `linux-x64`, `linux-arm64` (glibc **and** musl/Alpine) | ✅ |
| `win32-x64`, `win32-arm64` | ✅ |
| anywhere else Node ≥ 24.15 runs | ✅ |

Because storage no longer depends on a platform-specific prebuild, the
earlier `GraphDbBindingError` / unsupported-platform failure mode is gone —
see [ADR 0019](./docs/adr/0019-single-file-sqlite-storage.md) (which
superseded the native-binding storage of [ADR 0016](./docs/adr/0016-duckdb-graph-rip.md)).

## Quick start

### Install from npm (recommended)

**Requirements:** Node 24+.

```bash
# global install — puts `codehub` on your PATH
npm install -g @opencodehub/cli

# or run without installing
npx @opencodehub/cli --help
```

Bootstrap any repo and start querying:

```bash
cd /path/to/your/repo

# writes .mcp.json so Claude Code / Cursor launch `codehub mcp`,
# installs the Claude Code plugin, appends .codehub/ to .gitignore,
# seeds opencodehub.policy.yaml
codehub init

# index the repo (WASM parser, no native binaries needed)
codehub analyze

# your agent can now call impact, query, context, detect_changes, …
```

### Build from source

**Requirements:** Node 24+; pnpm 11+; Python 3.12 (only needed for
SCIP indexers on Python-heavy repos); `mise` recommended.

```bash
git clone https://github.com/theagenticguy/opencodehub
cd opencodehub
mise install
pnpm install --frozen-lockfile
pnpm run check          # lint + typecheck + test + banned-strings
mise run cli:link       # puts `codehub` on your PATH
```

## MCP tool surface (28 tools)

| Tool | Purpose |
|---|---|
| `query` | Process-grouped code intelligence — execution flows related to a concept |
| `context` | 360-degree symbol view — callers, callees, processes, ACCESSES edges |
| `signature` | Symbol declaration + stubbed members — class/interface header with method & property signatures, bodies elided |
| `impact` | Blast radius — what breaks at depth 1/2/3 with confidence + risk tier |
| `detect_changes` | Git-diff impact — what do your current changes affect |
| `route_map` / `api_impact` / `shape_check` / `tool_map` | HTTP route & MCP tool intelligence |
| `group_query` / `group_status` / `group_contracts` / `group_cross_repo_links` / `group_sync` / `group_list` | Cross-repo federation — fan out BM25, contracts, and staleness across a named group |
| `list_repos` · `sql` | Registry & escape-hatch SQL (read-only, timeout-guarded) |
| `pack_codebase` | Deterministic Repomix-compatible code pack export |
| …and the rest | `verdict`, `risk_trends`, `project_profile`, `dependencies`, `license_audit`, `owners`, `list_findings`, `list_findings_delta`, `list_dead_code`, `scan` |

Architecture decision records live in [`docs/adr/`](./docs/adr/). A
Claude Code plugin at `plugins/opencodehub/` wraps the MCP tools into
skills + a code-analyst subagent — install via `codehub init`.

## Repository layout

The monorepo is organised as 18 workspace packages under `packages/`:

| Package | Purpose |
|---|---|
| `analysis` | Heuristic + SCIP call-graph resolution, community + flow detection |
| `cli` | `codehub` command — `init`, `analyze`, `status`, `setup`, scanners, group federation |
| `cobol-proleap` | ProLeap-backed deep-parse path for free-format COBOL (regex provider handles fixed-format) |
| `core-types` | Shared TypeScript types, Zod schemas, error codes, canonical `LanguageId` and node/edge kinds |
| `embedder` | Embedding backends — local ONNX, HTTP, SageMaker; deterministic `embedderId` fingerprint |
| `frameworks` | HTTP route + MCP tool detectors used by `route_map` / `api_impact` / `tool_map` |
| `ingestion` | Tree-sitter + WASM parsers, symbol extraction, import resolution, complexity phase |
| `mcp` | Model Context Protocol server — 28 tools, resources, structured error envelopes |
| `pack` | Deterministic Repomix-compatible code-pack generator (M5) |
| `policy` | Allowlist + license-tier policy engine driving `license_audit` and CI gates |
| `sarif` | SARIF schema validation and scanner output normalisation |
| `scanners` | Subprocess wrappers for 19 scanners — OSV, Semgrep, hadolint, tflint, betterleaks, and the rest |
| `scip-ingest` | SCIP indexer runners (TS, Python, Go, Rust, Java) — emits CALLS, REFERENCES, IMPLEMENTS, TYPE_OF |
| `search` | Hybrid BM25 + HNSW (ACORN-1 + RaBitQ) query layer |
| `storage` | One `SqliteStore` (`node:sqlite`) implementing both `IGraphStore` + `ITemporalStore` over a single `store.sqlite`; deterministic `graphHash` |
| `summarizer` | Process + cluster summaries for MCP responses |
| `wiki` | LLM-narrated module pages emitted by `codehub wiki --llm` |

The retrieval / graph-quality evaluation harness and the per-language F1
regression gym used to live here as `eval` and `gym`; they were
extracted into the sibling `opencodehub-testbed` repository so the
production package set ships free of test-time dependencies.

## Embedding backends

OpenCodeHub ships with three embedding backends — all serve the same
`codefuse-ai/F2LLM-v2-80M` 320-dim space (last-token pooling + L2 norm
baked into the ONNX graph) — and picks one at runtime based on
environment variables:

| Precedence | Env | Backend |
|---|---|---|
| 1 | `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` | **SageMaker** — invokes an AWS SageMaker Runtime endpoint (e.g. a TEI-served `F2LLM-v2-80M`). Auth via the default AWS credential chain (profile, env vars, IMDS). No local weights needed. |
| 2 | `CODEHUB_EMBEDDING_URL` + `CODEHUB_EMBEDDING_MODEL` | **HTTP (OpenAI-compatible)** — POSTs to a `/v1/embeddings` server (Infinity, vLLM, TEI, Ollama, LM Studio, OpenAI). Bearer auth optional via `CODEHUB_EMBEDDING_API_KEY`. |
| 3 | *(nothing set)* | **Local ONNX** — deterministic, offline-safe. Requires `codehub setup --embeddings` to download the weights. |

**SageMaker-specific vars**:

| Var | Default | Purpose |
|---|---|---|
| `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` | *(required to select)* | Endpoint name (e.g. `F2LLM-v2-80M`). |
| `CODEHUB_EMBEDDING_SAGEMAKER_REGION` | `us-east-1` | AWS region. |
| `CODEHUB_EMBEDDING_DIMS` | `320` | Expected vector dimension — asserted on every response to catch model-swap drift. |
| `CODEHUB_EMBEDDING_MODEL` | `F2LLM-v2-80M/sagemaker:<endpoint-name>` | Stable modelId stamp recorded in index metadata. Override only when bridging a non-F2LLM endpoint. |

IAM: the caller needs `sagemaker:InvokeEndpoint` on the endpoint ARN —
e.g. `arn:aws:sagemaker:us-east-1:<account>:endpoint/F2LLM-v2-80M`.

**Do not mix backends against the same index.** Backends are pinned to a
single model identity via the `modelId` stamp in the `embeddings` table;
switching mid-project requires `codehub analyze --rebuild-embeddings`.
`--offline` refuses SageMaker and HTTP backends, so offline mode is
compatible only with the local ONNX path.

## Storage backend — single-file SQLite

The entire index lives in ONE `<repo>/.codehub/store.sqlite` file (WAL),
via Node's built-in `node:sqlite` — graph nodes, edges, embeddings, the
FTS5 BM25 table, and the temporal tables (cochanges, symbol summaries, the
`codehub query --sql` escape hatch). One `SqliteStore` class implements
**both** `IGraphStore` and `ITemporalStore`; `openStore()` returns that
single instance as both the `graph` and `temporal` views, so call sites use
`store.graph.X()` / `store.temporal.Y()` unchanged. **Zero native storage
bindings** — `@ladybugdb/core` and `@duckdb/node-api` are both gone, so
there is no `GraphDbBindingError`, no backend probe, and no platform-prebuild
matrix.

The segregated `IGraphStore` / `ITemporalStore` interfaces stay as the
community-fork escape hatch (AGE / Memgraph / Neo4j / Neptune) — a fork
implements both, on one class or split. Install is zero-native-dep:
`npm i -g @opencodehub/cli` + Node ≥ 24.15, no Docker, no postinstall
compile. (`onnxruntime-web`, the optional WASM embedder, is the only native
dependency — lazy-loaded under `--embeddings`.)

See [`docs/adr/0019-single-file-sqlite-storage.md`](./docs/adr/0019-single-file-sqlite-storage.md)
for the rationale; it supersedes [ADR 0016](./docs/adr/0016-duckdb-graph-rip.md)
(and, transitively, the native-binding storage of ADRs 0011 / 0013 / 0001).

## Parse runtime — WASM-only, vendored grammars

`@opencodehub/ingestion` runs `web-tree-sitter` (WASM) as the only parse
runtime on the supported Node range (22 and 24). There is no native opt-in:
the native `tree-sitter` N-API addon and all 14 `tree-sitter-<lang>` npm
packages are gone from the install graph, so parsing pulls **zero native
builds and zero GitHub fetches** at install time. (Storage is pure
`node:sqlite`; the only optional native dep is the WASM embedder — see
Platform support.)

All 15 grammar `.wasm` blobs are vendored at
`packages/ingestion/vendor/wasms/`, built from the grammar sources
pinned in `package.json`. Re-vendoring is a one-shot operation via
`bash scripts/build-vendor-wasms.sh` (requires docker, podman, finch,
or local emcc); consumers never build grammars at install time. The
complexity phase (cyclomatic-complexity metrics) is also WASM-backed,
so it runs on every install instead of degrading to a no-op.

See [`docs/adr/0015-wasm-only-parser-at-the-npm-distributed-boundary.md`](./docs/adr/0015-wasm-only-parser-at-the-npm-distributed-boundary.md)
for the WASM-only rationale and the bulletproof-install plan; ADR 0013
records the prior WASM-default + native-opt-in posture and is now
superseded.

## Status

**v1 — feature-complete on M1–M7.** Tracks A (M7 graph-DB default + the
`IGraphStore` / `ITemporalStore` interface segregation), B (19-scanner
fleet incl. betterleaks), C (debt sweep — embedder fingerprint, SCIP
REFERENCES + TYPE_OF), and D (dogfood polish) have all merged. The
published package is `@opencodehub/cli` (currently `0.7.0`; the monorepo
root tracks `0.8.0`); `1.0.0` is cut once schema + tool-surface stability
is signed off.

While on `0.x`, **any release may contain breaking changes** to the
graph schema, MCP tool shapes, CLI flags, or storage layout. Breaking
changes are called out with `!` or a `BREAKING CHANGE:` footer in the
commit log and summarised in each release's generated CHANGELOG.

## Troubleshooting

### `codehub analyze` runs out of memory on a large repo

The in-memory graph (`KnowledgeGraph`) holds the full node and edge set in
two JavaScript `Map`s for the duration of `analyze`, and `bulkLoad`
materializes transient copies before persistence — there is no spill to
disk during the build. A real index is already in the 96k-node /
291k-edge range; a monorepo roughly 10x that size can exhaust Node's
default heap and exit with an out-of-memory error (`FATAL ERROR:
Reached heap limit` / `JavaScript heap out of memory`), sometimes without
a clear message.

Raise Node's old-space ceiling for the run via `NODE_OPTIONS` (nothing
is set by default):

```bash
# 8 GB heap — bump higher for very large monorepos
NODE_OPTIONS=--max-old-space-size=8192 codehub analyze
```

Pick a value comfortably below your machine's free RAM. If you still hit
the ceiling, analyze a subtree at a time rather than the whole monorepo
in one pass.

## Supply-chain posture

- **CycloneDX SBOM** at [`SBOM.cdx.json`](./SBOM.cdx.json) (regenerated on every release)
- **Third-party license inventory** at [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md)
- **CI gates**: license allowlist, banned-strings grep, OSV vulnerability scan, CodeQL SAST, OpenSSF Scorecard
- **Zero open CVEs** on the lockfile at release time

## Documentation

Architecture decision records live in [`docs/adr/`](./docs/adr/) — the
durable record of design tradeoffs (storage backend, SCIP adoption,
hierarchical embeddings, CI toolchain pins, etc.).

The user guide + MCP reference is published at
**<https://theagenticguy.github.io/opencodehub>** — an Astro Starlight
site whose source lives in-repo at [`packages/docs/`](./packages/docs/)
and deploys to GitHub Pages on every push to `main`.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Issues and discussions welcome;
PRs must pass `pnpm run check` and have a filled-out PR template.

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
