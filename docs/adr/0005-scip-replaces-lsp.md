# ADR 0005 — SCIP replaces LSP; repomix is output-side only

- Status: accepted
- Date: 2026-04-26
- Authors: @theagenticguy + Claude
- Branch: `feat/scip-replaces-lsp`

## Context

Through ADRs 0001–0004, OpenCodeHub ran four long-running language
servers (pyright, typescript-language-server, gopls, rust-analyzer) via
the `@opencodehub/lsp-oracle` package to upgrade tree-sitter heuristic
edges with compiler-grade references. This layer:

- totalled ~10.6k LOC of client + 4 per-language ingestion phases;
- required shipping pyright / typescript-language-server binaries
  as npm deps (transitive install cost + supply-chain surface);
- made indexing a stateful, long-running operation driven by
  per-symbol JSON-RPC roundtrips;
- required ~2.5k LOC of gym harness, CI, and docs to validate.

Two adjacent technologies matured to the point where they obsolete
this design:

1. **SCIP** (https://scip-code.org) — Sourcegraph's precise-code-intel
   format, with first-class indexers for TypeScript, Python, Go, Rust
   (via `rust-analyzer scip`), and Java. Each indexer runs once per
   repo and emits a single `.scip` protobuf file. No daemon, no
   stateful client, no per-symbol roundtrips.
2. **repomix** 1.14 — a CLI that emits a single AST-compressed snapshot
   of a repo suitable for dropping into an LLM context window.

## Decision

### SCIP replaces LSP, end to end

- `@opencodehub/lsp-oracle` is deleted.
- The four per-language LSP ingestion phases
  (`lsp-python / lsp-typescript / lsp-go / lsp-rust`) collapse into a
  single `scip-index` phase in
  `packages/ingestion/src/pipeline/phases/scip-index.ts`.
- A new workspace package `@opencodehub/scip-ingest` owns the SCIP
  protobuf reader, derive-graph logic, and per-language indexer
  runners. It is a dependency of `ingestion` and `gym`.
- Oracle-edge provenance switches from
  `{pyright,typescript-language-server,gopls,rust-analyzer}@<version>`
  to `scip:<indexer>@<version>`. The constant `SCIP_PROVENANCE_PREFIXES`
  replaces `LSP_PROVENANCE_PREFIXES` in `@opencodehub/core-types`
  (the old name is kept as an alias for one release).
- The `+lsp-unconfirmed` reason suffix is renamed to
  `+scip-unconfirmed`. `confidence-demote`, `summarize`, MCP's
  confidence-breakdown helper, and the analyze-CLI auto-cap all
  depend only on the new prefix list and the single `scip-index` phase
  name.
- The gym's replay harness (`packages/gym/src/scip-factory.ts`)
  reimplements the `LspClientLike` surface on top of
  `@opencodehub/scip-ingest`: `start()` runs the indexer once (or
  reuses a cached `.scip`) and builds an in-memory occurrence +
  definition index; the three query methods answer from that index
  without re-decoding.

### Repomix is output-side only

We considered leaning on `repomix --compress` as a replacement for the
tree-sitter chunker in `packages/ingestion/src/parse` and
`packages/ingestion/src/pipeline/phases/embeddings.ts`. We rejected
that plan after a sourced deep-dive (see
`.erpaval/sessions/session-f8a300bc/research-repomix-ast.yaml`).

The rejection turns on four blockers:

1. **Repomix `--compress` produces per-file text blobs, not
   symbol-level chunks.** It discards the
   `startLine / endLine / symbolName / nodeType` metadata that our
   `parse` phase turns into Function/Method/Class nodes and into
   CALLS / IMPORTS / EXTENDS / IMPLEMENTS / DEFINES edges. Replacing
   the chunker would blow up graph extraction.
2. **Coverage gap.** Repomix compress omits `tsx` (folded into
   `typescript`) and `kotlin`. OpenCodeHub lists both as first-class
   languages.
3. **Tokenizer mismatch.** Repomix counts tokens with `o200k_base`
   (GPT-4o); our embedder is `gte-modernbert-base`. Budget math
   wouldn't line up.
4. **Determinism.** Our cache keys derive from
   `(contentSha, grammarSha, pipelineVersion)`. Repomix exposes no
   grammar sha, so cache invalidation becomes lossy.

Repomix is therefore scoped to an output-side surface:

- `codehub pack` CLI command (`packages/cli/src/commands/pack.ts`),
- `pack_codebase` MCP tool (`packages/mcp/src/tools/pack-codebase.ts`).

Agents that want a broad repo snapshot call `pack_codebase`; agents
that want structural answers still call `query / context / impact`.

## Consequences

### Positive

- Net –12k LOC across the feature branch (lsp-oracle delete +
  4 phases + Python spike + validate script, minus the
  scip-ingest package, scip-index phase, scip-factory, and ADR).
- Indexing is no longer stateful. One indexer invocation per
  language, one `.scip` file on disk, pure-function decode.
- Smaller node_modules (pyright + typescript-language-server go away).
- Cross-repo references become tractable the moment we wire up a
  SCIP-merge step: symbol strings are already globally unique across
  indexers.

### Negative / follow-ups

- The gym's legacy corpus YAMLs (`packages/gym/corpus/**/*.yaml`) and
  baselines (`packages/gym/baselines/*`) were captured against the
  old LSP clients. They still load and still drive the SCIP replay
  harness, but their per-case expected result sets need regeneration
  against scip-typescript / scip-python / scip-go / rust-analyzer /
  scip-java. That regeneration is a follow-up; failures today are
  content-level, not structural.
- `.github/workflows/gym.yml` still caches gopls / pyright / etc.
  Retargeting the matrix to cache scip-* binaries is a follow-up.
- ADR 0003 (gopls ↔ Go pin ADR) is now obsolete and should be
  superseded by an ADR pinning scip-* indexer versions.

### Neutral

- Tree-sitter grammars stay. Parse / structure / accesses / cross-file /
  mro / complexity / markdown all continue to drive off tree-sitter
  — that's the heuristic tier SCIP upgrades.

## References

- POC: `/tmp/scip-poc/scip-graph-poc` (SCIP → DuckDB → NetworkX).
- EARS spec: `.erpaval/specs/001-scip-replaces-lsp/spec.md`
- Research: `.erpaval/sessions/session-f8a300bc/research-scip-indexers.yaml`,
  `research-repomix-ast.yaml`
- Supersedes parts of ADR 0003 (CI pins for LSP servers).
