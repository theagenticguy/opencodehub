# @opencodehub/pack

Deterministic code-pack generator. `generatePack` assembles a 9-item
"bill of materials" (BOM) for a repo plus a manifest, writing every file
into the output directory so the same `(commit, tokenizer, budget, pins)`
always produce a **byte-identical pack** and the same `pack_hash`.

## Why byte-identity: a stable prompt-cache prefix

A byte-identical pack is a reusable cache prefix — second and later calls
read it at 0.1× input cost; grep round-trips mutate the prompt every turn,
invalidating the `messages` level, so they never cache.

That is the headline value of this package. A pack placed as a stable
context block is a **100%-identical byte prefix** the model can replay from
cache. The mechanics that make this pay off (Anthropic prompt caching, as
of June 2026):

- **Cache read = 0.1× the input rate** (90% cheaper); **cache write = 1.25×**
  on the 5-minute TTL, **2.0×** on the 1-hour TTL.
- **Match is on the longest 100%-identical byte prefix** and invalidates at
  the first differing byte. The cache hierarchy is `tools → system →
  messages`: a change at one level invalidates that level **and everything
  after it**, with a 20-block lookback.
- **Minimum cacheable prefix is 1,024 tokens on Opus 4.8** (Sonnet 4.6 =
  1,024; Haiku 4.5 = 4,096; Bedrock minimums differ). A pack smaller than
  ~1,024 tokens will not cache at all on Opus 4.8.
- **At most 4 `cache_control` breakpoints** per request — place them at the
  ends of the most-stable spans so the longest prefix is cache-eligible.
- **1M context is flat-rate** on Opus 4.8 / 4.7 / 4.6 and Sonnet 4.6 (no
  long-context input premium), so a large stable prefix is cheap to keep
  resident.

**Honest caveat:** the *first* call pays the 1.25× / 2.0× cache-**write**
premium. Caching is a win on the **second and later** reuse of the same
byte-identical prefix — not on the first call, and only on a pack that
clears the 1,024-token Opus-4.8 minimum.

This is why the BOM is emitted **most-stable-first** (see below): the
items least likely to differ commit-to-commit lead, so the longest possible
byte prefix stays cache-eligible across runs.

## Public surface

- `generatePack(opts, internal?)` — assemble and write the BOM + manifest.
- `buildManifest` / `serializeManifest` — manifest construction + `pack_hash`.
- Per-item builders, re-exported for direct use: `buildSkeleton`,
  `buildFileTree`, `buildDeps`, `buildLicenses`, `buildXrefs`,
  `buildAstChunks`, `buildFindings`, `buildReadme`,
  `writeEmbeddingsSidecar`.
- Types: `PackManifest`, `BomItem`, `PackPins`, `DeterminismClass`,
  `PackOpts` (see `src/types.ts`).

## The 9-item BOM (most-stable-first)

The BOM is emitted **most-stable-first** so the longest leading byte prefix
is cache-eligible: the items least likely to change commit-to-commit lead,
and the volatile items (ast-chunks, findings, embeddings sidecar) trail.
Eight bodies are always written; the Parquet embeddings sidecar is present
only when the store has embeddings. The manifest is written last so a crash
mid-run leaves an obviously-incomplete pack.

1. `skeleton.jsonl` — symbol skeleton (functions, classes, modules).
   Most stable: changes only on symbol add / remove / rename.
2. `file-tree.jsonl` — file tree with framework labels. Changes only on
   file-set churn (add / remove / move).
3. `deps.jsonl` — dependency / lockfile slice with exact versions. Changes
   only on a dependency bump.
4. `licenses.md` — aggregated dependency LICENSES by tier (BLOCK / WARN /
   OK) plus a `## Notices` section carrying any `NOTICE` / `NOTICE.md` /
   `NOTICES` content found at the repo root. Derived from `deps`, so it is
   roughly as stable.
5. `xrefs.jsonl` — SCIP-grounded cross-references (communities + calls).
   Shifts with the call graph and community detection.
6. `ast-chunks.jsonl` — top-N AST-chunked files with byte offsets.
   Volatile: token-budget- and tokenizer-sensitive.
7. `findings.jsonl` — SARIF findings grouped by severity and rule.
   Volatile: changes with every scanner run.
8. `embeddings.parquet` — optional embeddings sidecar (absent when the
   store has no embeddings). Most volatile — emitted last.
9. `readme.md` — this BOM's own README, interpolating the manifest and
   restating the determinism contract.

The `manifest.json` (`PackManifest`) lists every written BOM body in
`files[]` (excluding itself and `readme.md`) and carries `pack_hash`. The
`files[]` array preserves this most-stable-first emission order, so the
order is part of the `pack_hash` preimage.

## Determinism contract

Same `(commit, tokenizer_id, budget_tokens, chonkie_version,
duckdb_version, grammar_commits)` produces a byte-identical pack and the
same `pack_hash` — which is precisely what makes the pack a reusable cache
prefix. All file bytes use LF line endings; CRLF and lone-CR inputs are
normalized to LF before chunking and hashing, so two repos differing only
in line-ending style produce the same `pack_hash`.

`determinism_class` records how strong that guarantee is for a given run —
and therefore how durable the cache-prefix claim is:

- `strict` — every BOM file is byte-identity reproducible. The cache-prefix
  guarantee is full: the same inputs replay the same bytes every run.
- `best_effort` — the tokenizer is a Claude / Anthropic model whose
  tokenization is not guaranteed stable across versions; non-tokenizer
  fields are still byte-identity. The cache-prefix claim is weaker here:
  a tokenizer-version bump can drift the `ast-chunks` bytes and break the
  prefix, so a `best_effort` pack is a less durable cache anchor than a
  `strict` one.
- `degraded` — the AST chunker fell back to a line-split (e.g. tree-sitter
  grammar unavailable) or the embeddings sidecar could not bind the
  temporal store. The pack is still reproducible across two runs of the
  same code path, but cross-environment chunks may differ.
