# EARS spec — SCIP replaces LSP

Branch: `feat/scip-replaces-lsp`
Session: `session-f8a300bc`
Date: 2026-04-26

## Context

OpenCodeHub today relies on four long-running LSP clients (pyright,
typescript-language-server, gopls, rust-analyzer) managed by
`@opencodehub/lsp-oracle` to upgrade tree-sitter heuristic edges with
compiler-grade references. The LSP layer totals ~10.6k LOC across
`packages/lsp-oracle` and the four per-language ingestion phases, plus
~2.5k LOC of gym harness, corpus fixtures, CI workflow, and
documentation that assumes LSP framing.

We are replacing this entire layer with SCIP (https://scip-code.org).
SCIP indexers run once per language at index time and emit a single
`.scip` protobuf file per language. We then load those files into the
existing DuckDB graph store, preserving the
`confidence=1.0 + reason-prefix` oracle-edge contract that downstream
`confidence-demote`, `summarize`, `mcp/confidence`, and
`cli/analyze` consumers depend on.

Tree-sitter grammars stay for parsing (scan/parse/structure/accesses/
cross-file/mro/complexity/markdown phases are untouched).

**Repomix decision (revised after AST deep-dive, see
`research-repomix-ast.yaml`).** Repomix `--compress` emits a single
compressed text blob per file (signatures + class headers + imports
joined with a `⋮----` separator), NOT a symbol-level chunker. It
discards the `startLine/endLine/symbol-name/nodeType` metadata that
our parse phase turns into Function/Method/Class nodes and
CALLS/IMPORTS/EXTENDS/IMPLEMENTS/DEFINES edges. It also uses a
GPT-4o tokenizer that does not match our `gte-modernbert-base`
embedder budget, and omits tsx + kotlin from compress coverage.

Verdict: **keep the tree-sitter chunker for per-symbol embeddings and
graph extraction.** Repomix is repositioned as an *output-side*
feature — a `codehub pack` command and an MCP-side `pack_codebase`
re-export — not a replacement for the input-side chunker. The
simplification ratio claim (~10x reduction) does not hold for the
chunker; the real reduction comes from ripping LSP (≥10.6k LOC).

## Architecture

```
+-- Source tree
|
|   Existing (unchanged)
|   - scan -> profile -> structure -> markdown -> parse -> ...
|             ... -> accesses        (tree-sitter heuristic tier)
|
+-- NEW: scip-index phase
|     +-- detects languages
|     +-- invokes per-language SCIP indexers in parallel
|     |     scip-typescript / scip-python / scip-go
|     |     rust-analyzer scip / scip-java
|     +-- writes .opencodehub/scip/<lang>.scip files
|     +-- loads every .scip via @bufbuild/protobuf (vendored scip_pb.ts)
|     +-- emits CodeRelation edges with
|            reason = "scip:<indexer>@<version>"
|            confidence = 1.0
|
+-- confidence-demote  (rewired to SCIP_PROVENANCE_PREFIXES)
+-- summarize / mcp-confidence / cli-analyze (rewired)
```

## Actors

- `analyze` CLI user (local dev or CI)
- `mcp` agent consumer (Claude Code, Cursor, etc.)
- `gym` replay evaluator

## EARS requirements

### Ubiquitous (U)

- **U-1.** OpenCodeHub MUST produce compiler-grade call, reference, and
  implementation edges for TypeScript, JavaScript, Python, Go, Rust, and
  Java source files without running any language server.
- **U-2.** OpenCodeHub MUST persist oracle-edge provenance as a
  `reason` prefix of the form `scip:<indexer>@<version>` (e.g.
  `scip:scip-typescript@0.4.0`).
- **U-3.** `confidence-demote` MUST treat any relation whose `reason`
  begins with a member of `SCIP_PROVENANCE_PREFIXES` AND whose
  `confidence == 1.0` as an oracle edge.
- **U-4.** Tree-sitter parsing (scan/parse/structure/accesses/cross-file/
  mro/complexity/markdown phases) MUST remain functionally unchanged.

### Event-driven (E)

- **E-1.** WHEN `codehub analyze` runs AND the repo contains source
  files in {TS, JS, Python, Go, Rust, Java}, THE SYSTEM SHALL execute
  the corresponding SCIP indexer(s) and write
  `.opencodehub/scip/<lang>.scip`.
- **E-2.** WHEN a `.scip` file is produced, THE SYSTEM SHALL decode it
  using `@bufbuild/protobuf` + the vendored `scip_pb.ts` bindings and
  derive `caller -> callee` edges from occurrence-containment.
- **E-3.** WHEN the SCIP phase produces an edge that duplicates a
  tree-sitter heuristic edge by `(from, type, to, step)`, THE graph
  store SHALL retain the higher-confidence SCIP edge (dedup already in
  `KnowledgeGraph.addEdge`).
- **E-4.** WHEN `codehub analyze --offline` is set AND a required SCIP
  indexer binary is missing, THE SYSTEM SHALL SKIP that language with a
  single-line warning (parity with today's LSP skip path) — no network
  install attempts.

### State-driven (S)

- **S-1.** WHILE a SCIP indexer is running, THE SYSTEM SHALL stream
  progress events to the same `ProgressEvent` bus used by every other
  phase.
- **S-2.** WHILE a language's SCIP index already exists on disk AND
  mtime > newest source-file mtime, THE SYSTEM SHALL skip re-indexing
  unless `--force-reindex` is passed.

### Optional feature (O)

- **O-1.** WHERE `scip-java` is installed, THE SYSTEM SHALL emit Java
  SCIP edges. WHERE scip-java is not installed, THE SYSTEM SHALL skip
  Java indexing silently.
- **O-2.** WHERE `repomix` is on PATH, the embedder/search pipeline MAY
  use `repomix --style json` output for chunking instead of the current
  tree-sitter-derived chunker.

### Unwanted behaviour (UB)

- **UB-1.** The SCIP phase MUST NOT spawn long-running language-server
  subprocesses, MUST NOT open LSP JSON-RPC over stdio, and MUST NOT
  depend on `@opencodehub/lsp-oracle`.
- **UB-2.** The SCIP phase MUST NOT execute arbitrary build scripts on
  an untrusted workspace by default — for `scip-java` and
  `rust-analyzer scip` the analyze CLI SHALL require
  `--allow-build-scripts` unless already set in `codehub.config`.
- **UB-3.** Deleting `@opencodehub/lsp-oracle` MUST NOT leak broken
  imports elsewhere; `pnpm -r build` SHALL pass.

### Performance (P)

- **P-1.** For the repo's own TypeScript source tree (~120k LOC),
  end-to-end `analyze` wall time SHOULD NOT regress more than 20% vs
  today's tree-sitter-only path (today excludes LSP by default — we
  compare against the baseline tree-sitter-only measurement in
  `packages/gym/baselines/performance.json`).

## Acceptance criteria (AC)

Parallel-safe markers: `[P]`. Dependencies as `Dependencies: AC-X-Y`.

### Wave 1 — Foundation

- **AC-1-1** `packages/scip-ingest` package exists with
  `@bufbuild/protobuf` + vendored `scip_pb.ts`, a `parseScipIndex(buf)`
  that returns `{documents, external_symbols}`, and a
  `deriveCallEdges(documents)` that returns the caller/callee/doc/call_line
  tuples (port of `ingest.py`). `pnpm -r build` passes. Test proves
  ingest of the POC `calcpkg.scip` yields the known edge set. [P]
- **AC-1-2** `packages/scip-ingest/src/materialize.ts` computes
  `reach_forward`, `reach_backward`, `scc`, `node_metrics` (port of
  `materialize.py`) using `graphology` (already a workspace dep) and
  inserts derived tables into DuckDB via `@opencodehub/storage`. Test
  proves blast-radius ranking on the POC graph. Dependencies: AC-1-1.
- **AC-1-3** `SCIP_PROVENANCE_PREFIXES` added to
  `packages/core-types/src/lsp-provenance.ts` (kept filename; rename
  export to `PROVENANCE_PREFIXES` and ship both `SCIP_*` + legacy
  `LSP_*` as aliases for a clean rip). Tests updated. [P]

### Wave 2 — Per-language indexer runners

- **AC-2-1** `packages/scip-ingest/src/runners/typescript.ts` detects
  `tsconfig.json` / `package.json`, shells `scip-typescript index
  --output <out>`, returns path + tool version. [P, after AC-1-1]
- **AC-2-2** `packages/scip-ingest/src/runners/python.ts` detects
  `pyproject.toml` / `setup.py` / `requirements.txt`, shells
  `scip-python index . --project-name=<name> --output <out>`. [P]
- **AC-2-3** `packages/scip-ingest/src/runners/go.ts` detects
  `go.mod`, shells `scip-go --output <out>`. [P]
- **AC-2-4** `packages/scip-ingest/src/runners/rust.ts` detects
  `Cargo.toml`, shells
  `rust-analyzer scip <root> --output <out> --exclude-vendored-libraries`. [P]
- **AC-2-5** `packages/scip-ingest/src/runners/java.ts` detects
  `pom.xml` / `build.gradle*` / `build.sbt`, shells
  `scip-java index --output <out>`. [P]
- **AC-2-6** `packages/scip-ingest/src/runners/index.ts` exposes a
  uniform `runIndexer(lang, projectRoot, outDir, opts) -> {scipPath, tool, version}`
  signature with a `Promise.all`-friendly fan-out. Dependencies: AC-2-1
  through AC-2-5.

### Wave 3 — Pipeline rewire + rip

- **AC-3-1** New ingestion phase
  `packages/ingestion/src/pipeline/phases/scip-index.ts`. Runs after
  `accesses`, before `confidence-demote`. Fans out runners by detected
  languages (from `profile` phase output), loads each `.scip`, emits
  CodeRelation edges with `reason: "scip:<indexer>@<ver>"` and
  `confidence: 1.0`. Emits skip events for missing indexers. Tests
  cover happy path + skip. Dependencies: AC-1-2, AC-2-6.
- **AC-3-2** Delete `packages/lsp-oracle` entirely. Remove workspace
  dep from `packages/ingestion/package.json` and
  `packages/gym/package.json`. Remove tsconfig references. Regenerate
  `pnpm-lock.yaml`. Dependencies: AC-3-1.
- **AC-3-3** Delete
  `packages/ingestion/src/pipeline/phases/lsp-{python,typescript,go,rust}.ts`
  and their tests. Remove from `default-set.ts`. Dependencies: AC-3-1.
- **AC-3-4** Rewire `confidence-demote.ts`: swap `LSP_*_PHASE_NAME`
  deps for `SCIP_INDEX_PHASE_NAME`; accept SCIP_PROVENANCE_PREFIXES.
  Rename `+lsp-unconfirmed` suffix to `+scip-unconfirmed`. Update
  tests. Dependencies: AC-3-1, AC-1-3.
- **AC-3-5** Rewire `summarize.ts` (trust filter, line 55 + 401) and
  `packages/mcp/src/tools/confidence.ts` (`hasLspProvenance`) to
  SCIP_PROVENANCE_PREFIXES. Update tests. Dependencies: AC-1-3.
- **AC-3-6** Rewire `packages/cli/src/commands/analyze.ts` +
  `packages/cli/src/index.ts`: rename `lspConfirmedCallableCount` to
  `scipConfirmedCallableCount`; switch provenance check. Update help
  text. Dependencies: AC-3-5.
- **AC-3-7** Delete `scripts/validate-lsp-oracle.ts`,
  `scripts/spike-typescript-oracle.py`,
  `packages/lsp-oracle/reference/` (deleted with package). Remove
  `mise.toml` tasks `test:lsp-integration` + `validate:lsp-oracle`.
  Update remaining task descriptions. [P after AC-3-2]
- **AC-3-8** Rewrite `packages/gym/src/lsp-factory.ts` to
  `scip-factory.ts` mapping `(lang) -> scip runner`. Update
  `runner.ts` / `cli.ts` / `index.ts` / `runner.test.ts` to consume
  the new factory. Regenerate corpus baselines. Update
  `packages/gym/README.md` and per-language corpus READMEs. [P after AC-3-1]
- **AC-3-9** Rewrite `.github/workflows/gym.yml` to cache scip-*
  binaries and run a SCIP-indexer matrix in place of the LSP matrix.
  Update `docs/adr/0003-ci-toolchain-pins.md` (or supersede with a new
  ADR). Update `plugins/opencodehub/skills/opencodehub-guide/SKILL.md`
  and `opencodehub-impact-analysis/SKILL.md`. Update `OBJECTIVES.md`,
  `SPECS.md`. Dependencies: AC-3-8.

### Wave 4 — Repomix as output-side pack feature

- **AC-4-1** New `codehub pack` CLI command in `packages/cli`: shells
  `npx repomix@<pin> --style xml --compress --output <path>` scoped to
  the current repo, prints the output path + directory-token summary.
  Dependencies: AC-3-9.
- **AC-4-2** `packages/mcp` re-exposes `pack_codebase` as an MCP tool
  (delegating to repomix) for agents that want a single-blob repo
  snapshot. Same output, different transport. Dependencies: AC-4-1.
- **AC-4-3** `packages/embedder` chunker is UNCHANGED — tree-sitter
  per-symbol chunks remain the input-side path. Document the decision
  (ADR 0004) with the blocker list from `research-repomix-ast.yaml`.
  Dependencies: none.

### Wave 5 — Validation + compound

- **AC-5-1** `pnpm run check` (lint + typecheck + test + banned-strings)
  passes end-to-end. Dependencies: AC-4-2.
- **AC-5-2** `codehub analyze` on the POC `sample/calcpkg` Python
  project produces the same node_metrics as the POC DuckDB pipeline
  (golden-file comparison, allowing only version-string drift in
  `reason`). Dependencies: AC-5-1.
- **AC-5-3** Lessons extracted to `.erpaval/solutions/` per
  compound.md. Dependencies: AC-5-2.

## Non-goals

- Cross-repo SCIP merging (single-repo in this pass).
- New MCP tools.
- Removing tree-sitter grammars (stay for parse/structure/accesses).
- Shipping a hosted SCIP-indexer-as-a-service.
- C#/C/C++/Ruby/Kotlin/Swift/PHP/Dart SCIP coverage — those remain
  tree-sitter-only (SCIP indexers don't exist yet for all of them).

## Rollback plan

Keep a tagged commit `pre-scip-rip` on `main` before the feature
branch merges. Rollback = `git revert` of the merge commit; the
`.opencodehub/scip/` cache dir is discarded without affecting the
tree-sitter baseline.
