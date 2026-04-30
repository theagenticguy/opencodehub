---
title: BM25 over a node-id FTS index plus `ORDER BY id ASC` systematically favors synthetic stubs over real nodes
tags: [search, bm25, duckdb, fts, graph, disambiguation, cli-ergonomics]
first_applied: 2026-04-30
repos: [open-code-hub]
---

## The pattern

When you build a full-text index over a nodes table that mixes **real source-code nodes** with **synthetic placeholder / stub nodes** (re-export shims, `<external>` import markers, `<unresolved>` parser fallbacks), two BM25 properties conspire to push the stubs to rank 1 for single-identifier queries:

1. **Field length normalization.** BM25 rewards terms that occupy a larger fraction of the field. A stub node with `id = "CodeElement:<external>:@pkg/name:foo"` and `name = "foo"` has very short `id` / `name` fields. A real node with `id = "Function:packages/pkg/src/impl.ts:foo"` has longer fields with more non-query tokens. Same query → stub scores higher.
2. **Tie-break by `id ASC`.** Kind prefixes like `CodeElement:`, `Const:`, `Property:` sort before `Function:` / `Method:` / `Class:` lexically. Ties from the BM25 ranker collapse onto the stub.

Result: a CLI that does `const target = (await store.search({text, limit: 5}))[0]` will route 60–80% of common symbol queries to a stub with zero outbound/inbound edges. The command looks broken to the user even though the underlying graph is correct.

## Concrete failure we shipped at commit `16939f7`

Benchmarked 14 symbols against ts-morph ground truth. 8 / 14 `codehub context <name>` invocations picked the `CodeElement:<external>:@opencodehub/analysis:<name>` re-export stub instead of the real `Function:packages/analysis/src/<file>.ts:<name>` node. Empty callers, empty callees, real node demoted to `alternateCandidates[0]`.

Contributors to the miss rate:
- Workspace re-exports via `packages/*/src/index.ts` create an external stub per re-exported symbol for every consumer that imports the symbol (`import { foo } from "@opencodehub/analysis"`).
- BM25 treats the stub as a first-class result because it's a real row in the `nodes` table.
- The CLI's disambiguation contract was the bare top-1 score with no kind filter.

## Two independent fixes — apply both

### Fix A — exact-name resolution, filter stubs in SQL

For a single-identifier query (no spaces, no BM25 phrase operators), the user almost certainly wants a precise name match, not a BM25 concept hit. Use a direct `WHERE name = ?` query with stubs excluded in the same clause:

```ts
const rows = await store.query(
  `SELECT id, name, kind, file_path
     FROM nodes
    WHERE name = ?
      ${args.kind ? "AND kind = ?" : ""}
      ${args.filePath ? "AND file_path LIKE ?" : ""}
      AND file_path != '<external>'
      AND kind != 'CodeElement'
    ORDER BY file_path
    LIMIT 25`,
  params,
);
```

Fall back to `store.search({text, limit})` only when this returns zero rows — that preserves true concept-phrase queries like `"mcp stdio server"` which won't match any `name` literally.

### Fix B — three-way resolution outcome

Model resolution as `resolved | ambiguous | not_found`:

- Exactly 1 row → resolve, continue with traversal.
- ≥ 2 rows → emit `{ambiguous: true, candidates: [...]}` and exit 1. Do **not** silently pick one. User invokes with `--file-path` / `--kind` / `--target-uid` to disambiguate.
- 0 rows → BM25 fallback (concept query).

### Fix C — disambiguation flags on the CLI

`--target-uid <id>` (bypass name resolution), `--file-path <hint>` (suffix match), `--kind <kind>`. Mirror them across every command that takes a symbol — asymmetry (impact has them, context doesn't) surprises users.

## Impact

After this three-part fix on the `open-code-hub` monorepo:

- Wrong-target rate: **8 / 14 → 0 / 14**.
- Mean `context` callers F1 (vs labeled truth over 10 targets): **0.31 → 0.73**.
- Mean `context` callees F1: **0.31 → 0.97**.

## Why you can't fix this by tuning BM25 weights

You can lower the score of short-field hits by disabling length normalization (`b = 0` in BM25F) or by weighting `description` more heavily than `id`/`name`. Neither works here:

- Disabling length norm hurts *real* BM25 concept queries — you want short matches to win when the user is searching for a file name, not a stub.
- Weighting `description` heavier assumes stubs lack descriptions. They might carry `"external import: @pkg/name:foo"` — which partial-matches concept queries and creates a new class of noise.

The real disambiguation hint is **kind**. `Function`/`Method`/`Class` are what the user wants for `context`. `CodeElement` and `<external>` paths are internal accounting. Filter them in SQL, don't try to out-weight them.

## When to apply this pattern

- Any CLI / MCP tool that takes a symbol name and walks the graph from it.
- Any disambiguation layer over a full-text index that mixes real and synthetic rows.
- Any command whose default behavior silently picks top-1 out of a ranked list whose ranking function doesn't know about row provenance.

## When NOT to apply

- Pure concept-search commands (`query`, free-text search) where BM25 is the right default. Keep the old path; don't force exact-name.
- Indexes that emit **only** real source nodes (no stubs / re-exports). Length normalization still helps real queries there.
