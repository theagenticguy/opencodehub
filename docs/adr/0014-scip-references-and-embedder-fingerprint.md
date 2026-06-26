# ADR 0014 — SCIP REFERENCES + TYPE_OF emission and embedder-fingerprint refusal

**Status**: Accepted (still in force)
**Date**: 2026-05-09
**Supersedes**: none
**Superseded by**: none

> Note (2026-06-26): the embedder-fingerprint mechanism this ADR introduced
> — persist `embedder_model_id`, refuse mismatched queries via
> `assertEmbedderCompatible` — is unchanged and is precisely what guards the
> later embedding-model swap from `gte-modernbert-base` (768-dim) to
> `F2LLM-v2-80M` (320-dim). The `gte-modernbert-base` / `768` references
> below are the contemporaneous examples; the dim/model are now 320 /
> `f2llm-v2-80m/*` but the decision and the comparator are identical. The
> `store_meta` storage substrate referenced here (DuckDB) was later replaced
> per [ADR 0019](./0019-single-file-sqlite-storage.md); the column and
> semantics carried over to `store.sqlite` verbatim.

## Context

Two unrelated holes in v1.0 finalize, both routing through a shared one-time graphHash content delta. They land in a single ADR per spec.md§Q7 because the fixture-regeneration cost is paid once.

### Hole A — Embedder rebuild-on-switch silent corruption (AC-C-3)

The `embeddings` table on disk is populated by ONE specific embedder at index time. The currently-shipped store_meta schema (`packages/storage/src/schema-ddl.ts:172-183`) records `schema_version, last_commit, indexed_at, node_count, edge_count, stats_json, cache_hit_ratio, cache_size_bytes, last_compaction` — but NOT which embedder produced the vectors.

Failure mode: an operator runs `codehub analyze` with the local ONNX `gte-modernbert-base/fp32` embedder, then later runs `codehub query` with `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` set to a SageMaker `gte-modernbert-base` deployment. Both embedders publish 768-dim vectors, so the dim guard at `bindParam(stmt, idx, vectorBuffer)` does not fire. The vector subspaces are NOT identical — different fp32/quantization, different post-processing pipelines, different L2-normalisation cutoffs — so cosine-similarity retrieval silently misranks.

There is no test suite that catches this; there is no error envelope at the query path.

### Hole B — SCIP REFERENCES + TYPE_OF unwired (AC-C-5)

`packages/scip-ingest/src/derive.ts` already correctly:
- Emits CALLS edges via `deriveEdges` for function-like SCIP occurrences (`derive.ts:128-152`).
- Collects `is_implementation → IMPLEMENTS` and `is_type_definition → TYPE_OF` rows into `derived.relations` via `collectRels` (`derive.ts:184-199`).

But:
- `packages/ingestion/src/pipeline/phases/scip-index.ts:245-252` consumes `derived.edges` (CALLS) and ignores `derived.relations` entirely. IMPLEMENTS and TYPE_OF reach the graph zero times even though the data is parsed.
- `derive.ts:136` filters non-call SCIP occurrences out of `deriveEdges` with `if (!isFunctionLike(occ.symbol)) continue;` — so non-call references (an identifier reading a class field, importing a type, accessing a constant) never produce REFERENCES edges either.
- `RelationType` at `packages/core-types/src/edges.ts:3-27` lists `REFERENCES` (position 21) but does NOT list `TYPE_OF`. The append-only rule at `edges.ts:29-32` requires new relation types to be appended at the end — `TYPE_OF` lands at position 25.

The combined effect: every existing OCH index understates the call/reference graph by ~3 edge classes, and the `RelationType` union is missing one of the two heritage relations SCIP exposes.

## Decision

### A — Persist embedder modelId; refuse mismatched queries

1. Add `embedder_model_id TEXT` column to `store_meta` (DuckDB) and the matching `STRING` field to the `StoreMeta` graph-db NODE TABLE.
2. `Store.setMeta(meta)` writes the currently-active embedder's `Embedder.modelId`.
3. `Store.getMeta()` returns the persisted value via the new `StoreMeta.embedderModelId?: string` field.
4. At query time (cli `runQuery`, MCP `runQuery`), read `meta.embedderModelId`, compare to `embedder.modelId`:
   - Equal → proceed.
   - Persisted is `undefined` (pre-AC-C-3 store) → proceed; the operator is trusted to know what they indexed.
   - Mismatch + force flag set → proceed.
   - Mismatch + no force flag → refuse. CLI prints to stderr and `process.exit(2)` per E-C-3. MCP returns a `EMBEDDER_MISMATCH` envelope via `toolError` per the same hint string.
5. Frozen remediation hint string lives in `packages/embedder/src/fingerprint.ts` as `EMBEDDER_MISMATCH_HINT`. Both surfaces import it so the message can never drift.
6. CLI `--force-backend-mismatch` flag and MCP `force_backend_mismatch` tool input give the operator an override path. Default `false`.

The `assertEmbedderCompatible(persistedModelId, currentModelId, force)` helper lives in `@opencodehub/embedder` so cli + mcp share one comparator.

### B — Emit IMPLEMENTS, TYPE_OF, REFERENCES from SCIP

1. Append `TYPE_OF` at position 25 of `RelationType` and `RELATION_TYPES` per the append-only rule. The schema-shape stays append-stable; `graphHash` for content that does NOT include TYPE_OF stays byte-identical.
2. Widen `derive.ts:136` to also emit a `REFERENCES` `DerivedEdge` for non-call SCIP occurrences whose symbol has a DEFINITION elsewhere AND is not an `SCIP_ROLE_IMPORT`-only occurrence.
3. Add a sibling `emitRelations` call in `scip-index.ts` that consumes `derived.relations` and writes IMPLEMENTS + TYPE_OF graph edges using the same caller→callee join shape as `emitEdges`. Both joins use `buildSymbolDefIndex` for callee resolution, per the `scip-callee-definition-site` lesson; both add `+1` at the SCIP→OCH boundary, per the `scip-0-indexed-vs-graph-1-indexed` lesson.
4. Regenerate `packages/ingestion/src/pipeline/incremental-determinism.test.ts` fixtures one time. Document this in the commit message as the expected one-time content delta.
5. Extend `packages/storage/src/graph-hash-parity.test.ts` with a fixture variant exercising IMPLEMENTS + TYPE_OF + REFERENCES; assert cross-adapter parity holds.

## Consequences

### graphHash impact

- **Hole A (embedder fingerprint)** is graphHash-NEUTRAL. `graphHash` (`packages/core-types/src/graph-hash.ts:44-69`) hashes ONLY `(nodes, edges)` — `store_meta` is not part of the input. Adding a `store_meta` column does not change any per-commit hash.
- **Hole B (SCIP edges)** is graphHash-CONTENT-DELTA. The first index run after merge produces additional edges (REFERENCES + IMPLEMENTS + TYPE_OF) that did not previously exist. Every existing OCH index will yield a different graphHash on next `codehub analyze`. This is documented as a v1.0 minor bump (schema-shape preserved via append-only; only content changes).

### Cross-track sequencing

This ADR is shared with AC-C-3 (Hole A) and AC-C-5 (Hole B). They land in the same Track C PR; the fixture regen runs once for both.

### Migration cost

For Hole A, existing stores have `embedder_model_id IS NULL`. On next `Store.open` an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` runs cheaply; the `setMeta` call after the next `codehub analyze` populates the value. Until then, the query-time refusal sees `meta.embedderModelId === undefined` and passes — no false-positive refusals on existing stores.

For Hole B, every existing store needs a `codehub analyze --force` to pick up the new edges. That is the same posture as every prior schema-content delta in OCH (e.g. the M3+M6 IGraphStore split landed under the same minor-bump rule).

### Forward compatibility

`EMBEDDER_MISMATCH` is added to `ErrorCode` at `packages/mcp/src/error-envelope.ts`. Existing clients that do not enumerate the union ignore it; existing clients that DO enumerate the union pick up the new code on rebuild. No on-wire breaking change.

## Alternatives considered

### Hole A
- **Embed dim alone, not modelId.** Dim collisions (768 = 768) are exactly the failure mode this ADR addresses. Rejected.
- **Hash the first vector against a known canary string.** More complex, more storage, indistinguishable from "different post-processing pipelines" cases that produce identical canaries by accident. Rejected.
- **Force re-index on EVERY embedder env-var change.** Too aggressive for SageMaker→ONNX fallbacks during dev. The override flag exists for that case.

### Hole B
- **Insert TYPE_OF mid-union next to IMPLEMENTS.** Violates W-A-2 + the `edges.ts:29-32` append-only comment. Would break every existing graphHash on every existing OCH index, even for content with no IMPLEMENTS / TYPE_OF / REFERENCES. Rejected.
- **Split AC-C-5 into a sibling PR after Track C.** Considered in `pr-split-analysis.md` Option (b). Rejected because the fixture-regeneration cost would be paid twice (once for the v1.0 finalize hash bump that ships SCIP REFERENCES, once for the next ADR adding TYPE_OF). Bundling them is cheaper.

## Validation

- `mise run check` exits 0 on the Track C branch.
- `pnpm --filter @opencodehub/storage test` parity green (DuckDb leg + skip-clean GraphDb leg on dev box without `@ladybugdb/core` binding).
- `pnpm --filter @opencodehub/embedder test` covers `assertEmbedderCompatible` 5 cases.
- `pnpm --filter @opencodehub/scip-ingest test` covers REFERENCES emission + IMPLEMENTS/TYPE_OF collectRels.
- `pnpm --filter @opencodehub/ingestion test` regenerates incremental-determinism fixtures.
- ROADMAP constraint U1 (graphHash byte-identity per commit) holds for all content that does not exercise the new edge kinds; for content that does, the new fixture variant proves cross-adapter parity.

## References

- `packages/embedder/src/fingerprint.ts` — `assertEmbedderCompatible`,
  the frozen `EMBEDDER_MISMATCH_HINT` string.
- `packages/scip-ingest/src/derive.ts` — REFERENCES emission and the
  `is_implementation`/`is_type_definition` collector.
- `packages/ingestion/src/pipeline/phases/scip-index.ts` — `emitEdges`
  and the new `emitRelations` sibling.
- `packages/core-types/src/edges.ts` — append-only `RelationType`
  union; `TYPE_OF` lands at position 25.
- `docs/adr/0011-graph-db-backend.md` — `IGraphStore` precedent.
- `docs/adr/0013-m7-default-flip-and-abstraction.md` — M7 LadybugDB
  default flip.
