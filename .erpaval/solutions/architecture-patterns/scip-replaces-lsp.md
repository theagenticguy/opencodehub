---
title: SCIP replaces LSP for code-graph oracle edges
tags: [scip, lsp, ingestion, graph, indexer]
first_applied: 2026-04-26
repos: [open-code-hub]
---

## The pattern

When a code-intelligence system needs compiler-grade call / reference /
heritage edges across many languages, prefer **SCIP** indexers (one-shot
artifact producers) over **LSP** servers (stateful JSON-RPC subprocesses).

SCIP indexers exist for TypeScript, Python, Go, Rust (via
`rust-analyzer scip`), and Java. Each emits a single `.scip` protobuf
file per run. A symbol string encodes
`<scheme> <manager> <package> <version> <descriptor>+` which is
globally unique — cross-repo references work by construction.

## The shape

```
source tree  ─►  per-lang SCIP indexer (×5) ─►  .opencodehub/scip/<lang>.scip
                                                        │
                                                        ▼
                                   parseScipIndex(Uint8Array) -> ScipIndex
                                                        │
                                                        ▼
                                    deriveIndex(index) -> {symbols, edges}
                                                        │
                                                        ▼
                                    materialize(edges) -> {node_metrics,
                                                           reach_forward,
                                                           reach_backward,
                                                           scc}
                                                        │
                                                        ▼
                                   CodeRelation(confidence=1.0,
                                                reason="scip:<indexer>@<v>")
```

## Why this beats the LSP approach

- **No daemon.** SCIP produces an artifact; no stdio JSON-RPC, no
  request correlation, no warm-up, no timeout tuning.
- **Dependency surface shrinks.** No pyright / tsserver / gopls /
  rust-analyzer binaries in node_modules.
- **Cross-repo for free.** SCIP symbol strings are globally unique;
  merging two `.scip` files is just `concat documents[] + concat
  external_symbols[]` at the protobuf level.
- **Incremental caching is trivial.** One mtime check per language; no
  need to track per-symbol queries.

## The contract boundary worth preserving

The `confidence=1.0` + `reason startsWith "<oracle>:"` contract that
downstream consumers (`confidence-demote`, `summarize`,
`mcp/confidence`, `cli/analyze` auto-cap) hinge on is load-bearing.
When migrating from LSP to SCIP, keep the same confidence ceiling and
switch only the reason-prefix list and the phase-name that produces
the edges. Downstream code changes are then one-line (new constant).

## Lingering gotchas

- **scip-java / rust-analyzer run build scripts** — gate behind an
  explicit `allowBuildScripts=true` opt-in for untrusted workspaces.
- **Relationship edges (IMPLEMENTS) are in SymbolInformation, not in
  Occurrence** — a minimal protobuf reader that only decodes
  Occurrence will not surface them. When we need real IMPLEMENTS
  semantics, extend the parser to decode `SymbolInformation.relationships`.
- **SCIP range encoding has two shapes** — 4-int
  `[startLine, startChar, endLine, endChar]` OR 3-int
  `[line, startChar, endChar]` when start/end share a line. Normalize
  at decode time.

## When NOT to use this

- Small toy projects where tree-sitter heuristic edges are good enough.
- Languages without a SCIP indexer (C#, C, C++, Ruby, Kotlin, Swift,
  PHP, Dart — as of 2026-04-26). Keep tree-sitter for those.
