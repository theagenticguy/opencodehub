# OpenCodeHub — ERPAVal durable knowledge index

Compound-extracted lessons and EARS specs from prior autonomous
development sessions. Solutions are reusable; specs are per-feature.

## Solutions (architecture patterns + conventions)

- [SCIP replaces LSP for code-graph oracle edges](solutions/architecture-patterns/scip-replaces-lsp.md) — one-shot indexers beat stateful LSP clients for compiler-grade graph edges.
- [Repomix --compress is output-side only](solutions/architecture-patterns/repomix-is-output-side.md) — don't substitute it for a tree-sitter chunker; use it for repo snapshots.
- [Starlight in a pnpm monorepo — minimal scaffold + GH Pages](solutions/architecture-patterns/starlight-in-pnpm-monorepo.md) — 9 files + 1 workflow give you a buildable docs site; gotchas captured.
- [Hand-roll a minimal protobuf reader for fixed schemas](solutions/conventions/scip-protobuf-hand-rolled-reader.md) — ~130 LOC beats pulling in buf+codegen when the schema is small and stable.
- [Seed docs-authoring subagents with a single ground-truth YAML](solutions/conventions/docs-site-ground-truth-yaml.md) — parallel writers agree when you tell them where truth lives.
- [Adding a new Embedder backend that calls an AWS service](solutions/api-patterns/sagemaker-embedder-backend.md) — dynamic-import + credential soft-fail, structural runtime typing, modelId stamping, mixed sync/async tryOpenHttpEmbedder return.
- [SCIP ingest must resolve callees from DEFINITION occurrences, not first call sites](solutions/architecture-patterns/scip-callee-definition-site.md) — first-seen call site routes same-named symbols to the wrong local node; pre-scan for SCIP_ROLE_DEFINITION.
- [BM25 over a node-id FTS index plus ORDER BY id ASC systematically favors synthetic stubs](solutions/conventions/bm25-over-node-id-favors-stubs.md) — external re-export stubs out-score real Function nodes; fix with exact-name SQL + stub filter + disambiguation flags.
- [SCIP symbol-def index must alias `src/*.ts` defs under `dist/*.d.ts` in a TS monorepo](solutions/architecture-patterns/scip-monorepo-dist-src-alias.md) — cross-package refs carry `dist/` shape, defs carry `src/` shape; same-package refs work by accident. Alias closes the gap. Also documents the SCIP 0-indexed / graph 1-indexed line off-by-one.
- [SCIP range lines are 0-indexed; OCH graph node startLine is 1-indexed](solutions/conventions/scip-0-indexed-vs-graph-1-indexed.md) — asymmetric failure mode where caller-side lookups work by accident while callee-side lookups silently drop. `+1` at the scip-ingest→OCH boundary.
- [llms-txt config strings quietly anchor doc accuracy](solutions/conventions/llms-txt-as-ground-truth.md) — in a Starlight site with `starlight-llms-txt`, `astro.config.mjs` is more load-bearing than prose READMEs; audit it first in doc-sync sweeps.
- [tsconfig project references go stale on package removal](solutions/conventions/tsconfig-project-references-stale-on-package-removal.md) — root tsconfig `references` drift is invisible until a root-scoped tsc invocation hits; clean up in the same commit as the package delete.

## Specs

- [001-scip-replaces-lsp](specs/001-scip-replaces-lsp/spec.md) — rip-and-replace LSP with SCIP for TS/Py/Go/Rust/Java. Task map: [tasks.md](specs/001-scip-replaces-lsp/tasks.md).
