# Task map — SCIP replaces LSP

Task IDs map 1:1 to AC IDs in spec.md. Brackets `[P]` = parallel-safe
with any other `[P]` task in the same wave once dependencies are met.

## Wave 1 — Foundation (parallel after intake)

- T-AC-1-1 `scip-ingest` package + proto bindings + parseScipIndex +
  deriveCallEdges [P]
- T-AC-1-2 `scip-ingest` materialize (port materialize.py)
  Dependencies: T-AC-1-1
- T-AC-1-3 `SCIP_PROVENANCE_PREFIXES` in core-types [P]

## Wave 2 — Runners (parallel after AC-1-1)

- T-AC-2-1 typescript runner [P]
- T-AC-2-2 python runner [P]
- T-AC-2-3 go runner [P]
- T-AC-2-4 rust runner [P]
- T-AC-2-5 java runner [P]
- T-AC-2-6 uniform runner factory. Dependencies: T-AC-2-{1..5}

## Wave 3 — Rewire + rip (mostly sequential)

- T-AC-3-1 `scip-index` ingestion phase. Dependencies: T-AC-1-2,
  T-AC-2-6
- T-AC-3-2 Delete `packages/lsp-oracle` + workspace deps + lock regen.
  Dependencies: T-AC-3-1
- T-AC-3-3 Delete per-lang LSP phases + default-set. Dependencies:
  T-AC-3-1
- T-AC-3-4 Rewire confidence-demote. Dependencies: T-AC-3-1, T-AC-1-3
- T-AC-3-5 Rewire summarize + mcp/confidence. Dependencies: T-AC-1-3
- T-AC-3-6 Rewire cli/analyze. Dependencies: T-AC-3-5
- T-AC-3-7 Delete validate-lsp-oracle + spike-typescript-oracle +
  mise tasks [P after T-AC-3-2]
- T-AC-3-8 Gym scip-factory + corpus/baseline regen. [P after T-AC-3-1]
- T-AC-3-9 CI gym.yml + docs + skills + SPECS/OBJECTIVES.
  Dependencies: T-AC-3-8

## Wave 4 — Repomix as output-side feature (after Wave 3)

Repomix is re-scoped from chunker-replacement to output-side pack
feature. See `research-repomix-ast.yaml` — per-file compressed blobs
cannot carry symbol-level metadata, so the tree-sitter chunker stays.

- T-AC-4-1 `codehub pack` CLI command. Dependencies: T-AC-3-9
- T-AC-4-2 MCP `pack_codebase` tool. Dependencies: T-AC-4-1
- T-AC-4-3 ADR 0004 "Repomix is output-side only". Dependencies: none

## Wave 5 — Validate + Compound

- T-AC-5-1 pnpm run check. Dependencies: T-AC-4-2
- T-AC-5-2 end-to-end on POC sample. Dependencies: T-AC-5-1
- T-AC-5-3 compound lessons. Dependencies: T-AC-5-2

## Agent assignment & model policy

- Wave 1, 2: `general-purpose` sonnet; independent per runner.
- Wave 3 (rewire + rip): `general-purpose` sonnet; rip tasks need the
  orchestrator's hand to regenerate lockfile.
- Wave 4: `general-purpose` sonnet.
- Wave 5 validate: `opus`; compound: orchestrator.
