# Determinism contract — auditor reference

Ground truth for the `codehub-code-pack` skill. Cite this file when
the user disputes a `packHash` mismatch, when a CI determinism gate
fails, or when a future contributor proposes adding a non-deterministic
emitter to `@opencodehub/pack`. All requirements below are excerpted
verbatim from `.erpaval/specs/005-m5-m6/spec.md` and
`.erpaval/ROADMAP.md` — do not paraphrase.

## Source — ROADMAP §M5: 9-item code-pack BOM (verbatim)

> **9-item code-pack BOM** (byte-identical given same commit,
> tokenizer, budget):
>
> 1. `manifest.json` — pack_hash, commit SHA, tokenizer ID, schema version, counts
> 2. PageRank-ranked symbol skeleton
> 3. File tree with framework labels
> 4. Dependency graph / lockfile slice (exact versions)
> 5. Top-N AST-chunked files with byte offsets
> 6. SCIP-grounded cross-refs (community clusters + call graph)
> 7. Optional embeddings sidecar (`.parquet`)
> 8. Salient docstrings / SARIF findings by severity + rule
> 9. LICENSES / NOTICES + README.md + full determinism contract

## Source — Spec 005 §M5 ubiquitous requirements (verbatim)

> - **U1**: `graphHash` byte-identity invariant MUST hold before and
>   after every M5+M6 commit — existing `DuckDbStore` / `GraphDbStore`
>   parity suite stays green.
> - **U2**: `pack_hash` byte-identity invariant — same
>   `(commit, tokenizer, budget, chonkie_version, duckdb_version,
>   grammar_commits)` → same `pack_hash`. Verified by a determinism
>   suite.
> - **U3**: No tracked source file MUST introduce banned literals.
>   `bash scripts/check-banned-strings.sh` MUST exit 0 post-commit.
> - **U4**: `mise run check` MUST exit 0 after every commit.
> - **U5**: Every new package MUST carry `@opencodehub/<name>` naming,
>   Apache-2.0 license, `type: module`, `tsc --noEmit` clean.
> - **U6**: No LLM calls outside `@opencodehub/summarizer`.
> - **U7**: Every MCP tool and CLI output MUST remain deterministic
>   (alpha-sort, lex-stable tiebreak) — preserves the existing
>   group-query convention at `group-query.ts`.

## Source — Spec 005 §M5 event-driven requirements (verbatim)

> - **E-M5-1**: When a user runs `codehub code-pack <repo> --budget <N>`,
>   the CLI MUST produce a directory containing all 9 BOM items plus
>   `manifest.json` at `<repo>/.codehub/packs/<pack_hash>/`.
> - **E-M5-2**: When `pack_codebase` MCP tool is called with a pack-id
>   arg, it MUST route through `@opencodehub/pack`, not `repomix`. The
>   legacy repomix path stays available under an `--engine repomix`
>   opt-in flag for one milestone, then removes in M7.
> - **E-M5-3**: When `codehub code-pack` is called twice on the same
>   `(commit, tokenizer, budget)`, every file under the output
>   directory MUST be byte-identical on second run (cmp -s).
> - **E-M5-4**: When the BOM is written, `manifest.json` MUST include
>   `{commit, repo_origin_url, tokenizer_id, determinism_class,
>   budget_tokens, grammar_commits, chonkie_version, duckdb_version,
>   files[], pack_hash}` with
>   `pack_hash = sha256(canonicalJson(all-other-fields))`.
> - **E-M5-5**: When PageRank is computed, it MUST be at request time
>   from the loaded `KnowledgeGraph` (per ROADMAP §Target package
>   layout — "`@opencodehub/analysis` — request-time queries (PageRank,
>   blast, impact)"), NOT at index time in `materialize.ts`. The
>   dead-code `pagerank()` call at `materialize.ts:231` MUST be
>   removed in the same commit that lifts the function.

## Source — Spec 005 §M5 state-driven requirements (verbatim)

> - **S-M5-1**: While `@chonkiejs/core` fails to install or load
>   (native-binding unavailable on CI platform), `@opencodehub/pack`
>   MUST degrade to a line-split fallback and stamp
>   `determinism_class: degraded` in the manifest — NOT silently emit
>   byte-different output claiming strict determinism.
> - **S-M5-2**: While `tokenizer_id` names a Claude model, the
>   manifest MUST set `determinism_class: best_effort` and the BOM
>   verifier MUST warn when asked to check byte-identity against such
>   a pack.
> - **S-M5-3**: While the target repo has no embeddings computed, BOM
>   item #7 (Parquet sidecar) MUST be absent entirely (not an empty
>   file) and `manifest.files[]` MUST NOT list a path to it.

## Source — Spec 005 §M5 unwanted-behavior requirements (verbatim)

> - **W-M5-1**: `@opencodehub/pack` MUST NOT call any LLM (enforced
>   by the existing `scripts/check-banned-strings.sh`-style audit +
>   a new `no-bedrock-outside-summarizer` test).
> - **W-M5-2**: `codehub code-pack` MUST NOT emit writer metadata
>   (DuckDB `created_by`, chonkie writer tags) as top-level fields in
>   `manifest.json` — all tool-version pins live in a single
>   `pins: {}` nested object so the BOM schema is stable across tool
>   upgrades.
> - **W-M5-3**: `codehub code-pack` MUST NOT use tolerance-based
>   PageRank convergence — fixed iterations only.
> - **W-M5-4**: CRLF files on Windows checkouts MUST NOT produce a
>   different `pack_hash` than LF on Linux — ingest normalizes to LF
>   before hashing content.

## packHash construction algorithm

The exact preimage shape that produces `packHash`:

1. Compute `fileHash = sha256_hex(raw_bytes)` for every emitted BOM
   file (items 2-9 from the contract above). CRLF files are
   normalized to LF **at ingest** before hashing content (per W-M5-4)
   — the on-disk bytes after normalization are the bytes that get
   hashed.
2. Construct the manifest object with `packHash: ""` as a placeholder
   and `files[]` populated with `{kind, path, fileHash}` rows in the
   order they appear in `BomItem.kind` (the type union enumerates a
   stable order).
3. Serialize the manifest to RFC 8785-shaped canonical JSON (sorted
   keys, no whitespace, no trailing newline). All tool-version pins
   live in a single nested `pins: {}` object (per W-M5-2) — the
   top-level `manifest.json` schema does not carry writer metadata.
4. `packHash = sha256_hex(canonicalJson(manifest_with_packHash_omitted))`.
5. Replace the placeholder. Write `manifest.json` with `packHash` set
   and `files[]` unchanged. The wire form serializes camelCase TS
   fields to snake_case keys (`pack_hash`, `determinism_class`,
   `repo_origin_url`, `tokenizer_id`, `budget_tokens`, `schema_version`)
   per `packages/pack/src/manifest.ts:84-90`.

The reference implementation is `packages/pack/src/manifest.ts` (the
`buildManifest()` helper). The serializer reuses
`packages/core-types/src/graph-hash.ts` `writeCanonicalJson` per the
spec context note ("OCH's existing `graphHash` helper is already the
right pattern").

## Determinism class triage

The manifest's `determinism_class` (snake_case on disk, `determinismClass`
in TS) takes one of three values. Each maps to a state-driven
requirement above.

| Class | Trigger | Requirement |
|-------|---------|-------------|
| `strict` | None of the degraded triggers fire | U2 holds in full: same `(commit, tokenizer, budget, chonkie_version, duckdb_version, grammar_commits)` → same `pack_hash`. |
| `best_effort` | `tokenizer_id` resolves to a Claude model | S-M5-2 — verifier MUST warn callers checking byte-identity. |
| `degraded` | `@chonkiejs/core` native binding fails to load | S-M5-1 — line-split fallback used; pack still self-consistent locally but not portable. |

## Determinism suite location

The byte-identity test suite lives at
`packages/pack/src/pack-determinism.test.ts` (delivered by T-W3-3 in
this same M5 wave). It runs `generatePack` twice against a fixture
repo, computes `cmp -s` over every output file, and asserts manifest
`pack_hash` equality. CI gates on this suite.

When debugging a `pack_hash` drift:

1. Re-run with `engine: "pack"` and capture both manifests.
2. Compare `pins` first — a chonkie or duckdb upgrade in node_modules
   is the most common cause.
3. Compare `files[i].file_hash` row-by-row — the first mismatch
   identifies which BOM emitter is non-deterministic.
4. Inspect the offending emitter under `packages/pack/src/` (one
   module per BOM item: `manifest.ts`, `skeleton.ts`, `file-tree.ts`,
   `deps.ts`, `ast-chunker.ts`, `xrefs.ts`, `embeddings-sidecar.ts`,
   `findings.ts`, `licenses.ts`, `readme.ts`).
