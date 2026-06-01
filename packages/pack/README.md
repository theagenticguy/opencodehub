# @opencodehub/pack

Deterministic code-pack generator. `generatePack` assembles a 9-item
"bill of materials" (BOM) for a repo plus a manifest, writing every file
into the output directory so the same inputs always produce byte-identical
bytes and the same `pack_hash`.

## Public surface

- `generatePack(opts, internal?)` — assemble and write the BOM + manifest.
- `buildManifest` / `serializeManifest` — manifest construction + `pack_hash`.
- Per-item builders, re-exported for direct use: `buildSkeleton`,
  `buildFileTree`, `buildDeps`, `buildAstChunks`, `buildXrefs`,
  `buildFindings`, `buildLicenses`, `buildReadme`,
  `writeEmbeddingsSidecar`.
- Types: `PackManifest`, `BomItem`, `PackPins`, `DeterminismClass`,
  `PackOpts` (see `src/types.ts`).

## The 9-item BOM

Eight bodies are always written; the Parquet embeddings sidecar is item 7
and is present only when the store has embeddings. The manifest is written
last so a crash mid-run leaves an obviously-incomplete pack.

1. `skeleton.jsonl` — symbol skeleton (functions, classes, modules).
2. `file-tree.jsonl` — file tree with framework labels.
3. `deps.jsonl` — dependency / lockfile slice with exact versions.
4. `ast-chunks.jsonl` — top-N AST-chunked files with byte offsets.
5. `xrefs.jsonl` — SCIP-grounded cross-references (communities + calls).
6. `findings.jsonl` — SARIF findings grouped by severity and rule.
7. `embeddings.parquet` — optional embeddings sidecar (absent when the
   store has no embeddings).
8. `licenses.md` — aggregated dependency LICENSES by tier (BLOCK / WARN /
   OK) plus a `## Notices` section carrying any `NOTICE` / `NOTICE.md` /
   `NOTICES` content found at the repo root.
9. `readme.md` — this BOM's own README, interpolating the manifest and
   restating the determinism contract.

The `manifest.json` (`PackManifest`) lists every written BOM body in
`files[]` (excluding itself and `readme.md`) and carries `pack_hash`.

## Determinism contract

Same `(commit, tokenizer_id, budget_tokens, chonkie_version,
duckdb_version, grammar_commits)` produces a byte-identical pack and the
same `pack_hash`. All file bytes use LF line endings; CRLF and lone-CR
inputs are normalized to LF before chunking and hashing, so two repos
differing only in line-ending style produce the same `pack_hash`.

`determinism_class` records how strong that guarantee is for a given run:

- `strict` — every BOM file is byte-identity reproducible.
- `best_effort` — the tokenizer is a Claude / Anthropic model whose
  tokenization is not guaranteed stable across versions; non-tokenizer
  fields are still byte-identity.
- `degraded` — the AST chunker fell back to a line-split (e.g. tree-sitter
  grammar unavailable) or the embeddings sidecar could not bind the
  temporal store. The pack is still reproducible across two runs of the
  same code path, but cross-environment chunks may differ.
