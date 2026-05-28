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
# your agent now has impact, query, context, detect_changes, rename — 29 tools over MCP
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
  F -->|29 tools| G[AI coding agent]
```

## Design choices worth knowing

| Choice | Why it matters |
|---|---|
| **Apache-2.0, end to end** | Every runtime dep is OSI-approved permissive. No PolyForm, BSL, Commons Clause, Elastic v2, GPL, or AGPL. You can fork, embed, and ship commercial products on top without a license-review detour. |
| **Local-first, offline-capable** | `codehub analyze --offline` opens zero sockets. Your code never leaves your machine. No telemetry. |
| **Deterministic indexing** | Identical inputs produce a byte-identical graph hash. Reproducible. Auditable. Cacheable in CI. |
| **MCP-native** | Works out-of-the-box with Claude Code, Cursor, Codex, Windsurf, OpenCode. The MCP server is the primary interface; CLI exists for scripts and CI. |
| **Embedded storage, two-tier** | `@ladybugdb/core` holds the structural store: symbols, edges, embeddings, BM25 + HNSW. A dedicated DuckDB sibling holds the temporal views: cochanges and summaries. Embedded files. No daemon. No database to operate. Both tiers are always present, with no backend knob (ADR 0016). |
| **15 languages at GA** | TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++, Ruby, Kotlin, Swift, PHP, Dart, COBOL — tree-sitter for the first 14 plus a regex provider for fixed-format COBOL. |
| **WASM-only parse runtime** | `web-tree-sitter` WASM is the only parse runtime, on Node 20, 22, and 24. The 15 grammar `.wasm` blobs are vendored at `packages/ingestion/vendor/wasms/`. There is no native opt-in — `npm install -g @opencodehub/cli@latest` does zero native builds and zero GitHub fetches. |

## Quick start

### Install from npm (recommended)

**Requirements:** Node 22 or 24.

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

# your agent can now call impact, query, context, detect_changes, rename, …
```

### Build from source

**Requirements:** Node 22 or 24; pnpm 10+; Python 3.12 (only needed for
SCIP indexers on Python-heavy repos); `mise` recommended.

```bash
git clone https://github.com/theagenticguy/opencodehub
cd opencodehub
mise install
pnpm install --frozen-lockfile
pnpm run check          # lint + typecheck + test + banned-strings
mise run cli:link       # puts `codehub` on your PATH
```

## MCP tool surface (29 tools)

| Tool | Purpose |
|---|---|
| `query` | Process-grouped code intelligence — execution flows related to a concept |
| `context` | 360-degree symbol view — callers, callees, processes, ACCESSES edges |
| `impact` | Blast radius — what breaks at depth 1/2/3 with confidence + risk tier |
| `detect_changes` | Git-diff impact — what do your current changes affect |
| `rename` | Multi-file coordinated rename with confidence-tagged edits |
| `route_map` / `api_impact` / `shape_check` / `tool_map` | HTTP route & MCP tool intelligence |
| `group_query` / `group_status` / `group_contracts` / `group_cross_repo_links` / `group_sync` / `group_list` | Cross-repo federation — fan out BM25, contracts, and staleness across a named group |
| `list_repos` · `sql` | Registry & escape-hatch SQL (read-only, timeout-guarded) |
| `pack_codebase` | Deterministic Repomix-compatible code pack export |
| …and the rest | `verdict`, `risk_trends`, `project_profile`, `dependencies`, `license_audit`, `owners`, `list_findings`, `list_findings_delta`, `list_dead_code`, `remove_dead_code`, `scan` |

Architecture decision records live in [`docs/adr/`](./docs/adr/). A
Claude Code plugin at `plugins/opencodehub/` wraps the MCP tools into
skills + a code-analyst subagent — install via `codehub init`.

## Repository layout

The monorepo is organised as 17 workspace packages under `packages/`:

| Package | Purpose |
|---|---|
| `analysis` | Heuristic + SCIP call-graph resolution, community + flow detection |
| `cli` | `codehub` command — `init`, `analyze`, `status`, `setup`, scanners, group federation |
| `cobol-proleap` | ProLeap-backed deep-parse path for free-format COBOL (regex provider handles fixed-format) |
| `core-types` | Shared TypeScript types, Zod schemas, error codes, canonical `LanguageId` and node/edge kinds |
| `embedder` | Embedding backends — local ONNX, HTTP, SageMaker; deterministic `embedderId` fingerprint |
| `frameworks` | HTTP route + MCP tool detectors used by `route_map` / `api_impact` / `tool_map` |
| `ingestion` | Tree-sitter + WASM parsers, symbol extraction, import resolution, complexity phase |
| `mcp` | Model Context Protocol server — 29 tools, resources, structured error envelopes |
| `pack` | Deterministic Repomix-compatible code-pack generator (M5) |
| `policy` | Allowlist + license-tier policy engine driving `license_audit` and CI gates |
| `sarif` | SARIF schema validation and scanner output normalisation |
| `scanners` | Subprocess wrappers for 20 scanners — OSV, Semgrep, hadolint, tflint, detect-secrets, and the rest |
| `scip-ingest` | SCIP indexer runners (TS, Python, Go, Rust, Java) — emits CALLS, REFERENCES, IMPLEMENTS, TYPE_OF |
| `search` | Hybrid BM25 + HNSW (ACORN-1 + RaBitQ) query layer |
| `storage` | `IGraphStore` (`@ladybugdb/core`) + `ITemporalStore` (DuckDB) adapters; deterministic `graphHash` |
| `summarizer` | Process + cluster summaries for MCP responses |
| `wiki` | LLM-narrated module pages emitted by `codehub wiki --llm` |

The retrieval / graph-quality evaluation harness and the per-language F1
regression gym used to live here as `eval` and `gym`; they were
extracted into a sibling testbed in M5 so the production package set
ships free of test-time dependencies.

## Embedding backends

OpenCodeHub ships with three embedding backends — all serve the same
`gte-modernbert-base` 768-dim space, all use CLS pooling + L2 norm — and
picks one at runtime based on environment variables:

| Precedence | Env | Backend |
|---|---|---|
| 1 | `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` | **SageMaker** — invokes an AWS SageMaker Runtime endpoint (e.g. a TEI-served `gte-modernbert-embed`). Auth via the default AWS credential chain (profile, env vars, IMDS). No local weights needed. |
| 2 | `CODEHUB_EMBEDDING_URL` + `CODEHUB_EMBEDDING_MODEL` | **HTTP (OpenAI-compatible)** — POSTs to a `/v1/embeddings` server (Infinity, vLLM, TEI, Ollama, LM Studio, OpenAI). Bearer auth optional via `CODEHUB_EMBEDDING_API_KEY`. |
| 3 | *(nothing set)* | **Local ONNX** — deterministic, offline-safe. Requires `codehub setup --embeddings` to download the weights. |

**SageMaker-specific vars**:

| Var | Default | Purpose |
|---|---|---|
| `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` | *(required to select)* | Endpoint name (e.g. `gte-modernbert-embed`). |
| `CODEHUB_EMBEDDING_SAGEMAKER_REGION` | `us-east-1` | AWS region. |
| `CODEHUB_EMBEDDING_DIMS` | `768` | Expected vector dimension — asserted on every response to catch model-swap drift. |
| `CODEHUB_EMBEDDING_MODEL` | `gte-modernbert-base/sagemaker:<endpoint-name>` | Stable modelId stamp recorded in index metadata. Override only when bridging a non-gte endpoint. |

IAM: the caller needs `sagemaker:InvokeEndpoint` on the endpoint ARN —
e.g. `arn:aws:sagemaker:us-east-1:<account>:endpoint/gte-modernbert-embed`.

**Do not mix backends against the same index.** Backends are pinned to a
single model identity via the `modelId` stamp in the `embeddings` table;
switching mid-project requires `codehub analyze --rebuild-embeddings`.
`--offline` refuses SageMaker and HTTP backends, so offline mode is
compatible only with the local ONNX path.

## Storage backend — lbug graph + DuckDB temporal

The graph tier is always `@ladybugdb/core` (`<repo>/.codehub/graph.lbug`);
the temporal tier — cochanges, structured symbol summaries, and the
`codehub query --sql` escape hatch — is always DuckDB
(`<repo>/.codehub/temporal.duckdb`). Both files are written on every
`analyze`. There is no `CODEHUB_STORE` env var, no backend probe, no
single-file `graph.duckdb` layout, and no mtime arbitration; if the lbug
binding fails to load, `open()` throws `GraphDbBindingError` and the
operation aborts.

`IGraphStore` lives only on `GraphDbStore`; `DuckDbStore` implements
`ITemporalStore` only. The segregated interfaces stay because they are
the v1.0 contract for community-fork adapters (AGE / Memgraph / Neo4j /
Neptune target `IGraphStore`; DuckDB owns `ITemporalStore`). Embeddings
live in `graph.lbug` and stream into a per-call DuckDB temp table at
pack time so the byte-identical Parquet sidecar still works.

See [`docs/adr/0016-duckdb-graph-rip.md`](./docs/adr/0016-duckdb-graph-rip.md)
for the rationale behind ripping out the DuckDB graph backend; it
supersedes ADR 0013 and the DuckDB-as-graph passages of ADR 0011.

## Parse runtime — WASM-only, vendored grammars

`@opencodehub/ingestion` runs `web-tree-sitter` (WASM) as the only parse
runtime on Node 20, 22, and 24. There is no native opt-in: the native
`tree-sitter` N-API addon and all 14 `tree-sitter-<lang>` npm packages
are gone from the install graph. `npm install -g @opencodehub/cli@latest`
does zero native builds and zero GitHub fetches.

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
`IGraphStore` / `ITemporalStore` interface segregation), B (20-scanner
fleet incl. detect-secrets), C (debt sweep — embedder fingerprint, SCIP
REFERENCES + TYPE_OF), and D (dogfood polish) have all merged. The
current shipped tag remains `0.1.1`; `1.0.0` is cut once schema +
tool-surface stability is signed off.

While on `0.x`, **any release may contain breaking changes** to the
graph schema, MCP tool shapes, CLI flags, or storage layout. Breaking
changes are called out with `!` or a `BREAKING CHANGE:` footer in the
commit log and summarised in each release's generated CHANGELOG.

## Supply-chain posture

- **CycloneDX SBOM** at [`SBOM.cdx.json`](./SBOM.cdx.json) (regenerated on every release)
- **Third-party license inventory** at [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md)
- **CI gates**: license allowlist, banned-strings grep, OSV vulnerability scan, CodeQL SAST, OpenSSF Scorecard
- **Zero open CVEs** on the lockfile at release time

## Documentation

Architecture decision records live in [`docs/adr/`](./docs/adr/) — the
durable record of design tradeoffs (storage backend, SCIP adoption,
hierarchical embeddings, CI toolchain pins, etc.).

A standalone user-guide + MCP reference site is being bootstrapped in a
dedicated repo; this README will link it once published.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Issues and discussions welcome;
PRs must pass `pnpm run check` and have a filled-out PR template.

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
