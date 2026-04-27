# OpenCodeHub — ERPAVal durable knowledge index

Compound-extracted lessons and EARS specs from prior autonomous
development sessions. Solutions are reusable; specs are per-feature.

## Solutions (architecture patterns + conventions)

- [SCIP replaces LSP for code-graph oracle edges](solutions/architecture-patterns/scip-replaces-lsp.md) — one-shot indexers beat stateful LSP clients for compiler-grade graph edges.
- [Repomix --compress is output-side only](solutions/architecture-patterns/repomix-is-output-side.md) — don't substitute it for a tree-sitter chunker; use it for repo snapshots.
- [Hand-roll a minimal protobuf reader for fixed schemas](solutions/conventions/scip-protobuf-hand-rolled-reader.md) — ~130 LOC beats pulling in buf+codegen when the schema is small and stable.

## Specs

- [001-scip-replaces-lsp](specs/001-scip-replaces-lsp/spec.md) — rip-and-replace LSP with SCIP for TS/Py/Go/Rust/Java. Task map: [tasks.md](specs/001-scip-replaces-lsp/tasks.md).
