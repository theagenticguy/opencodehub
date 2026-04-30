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

## Specs

- [001-scip-replaces-lsp](specs/001-scip-replaces-lsp/spec.md) — rip-and-replace LSP with SCIP for TS/Py/Go/Rust/Java. Task map: [tasks.md](specs/001-scip-replaces-lsp/tasks.md).
