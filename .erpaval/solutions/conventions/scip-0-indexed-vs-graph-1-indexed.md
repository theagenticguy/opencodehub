---
title: SCIP range lines are 0-indexed; OCH graph node startLine is 1-indexed
tags: [scip, ingestion, off-by-one, graph, tree-sitter]
first_applied: 2026-04-30
repos: [open-code-hub]
---

## The contract

Two different line-numbering conventions meet at the SCIP→OCH boundary:

| Side | Source | Indexing |
|---|---|---|
| SCIP | `Occurrence.range.startLine` from the decoded `.scip` protobuf | **0-indexed** |
| OCH graph | `nodes.start_line` / `nodes.end_line` populated from tree-sitter `startPosition.row + 1` | **1-indexed** |

Anywhere the ingest maps a SCIP line into an OCH-graph line lookup, add
`+1`:

```ts
// packages/ingestion/src/pipeline/phases/scip-index.ts emitEdges
const fromId = findEnclosingNodeId(nodesByFile, e.document, e.callLine + 1);
// ...
const toId   = findEnclosingNodeId(nodesByFile, calleeDef.file, calleeDef.line + 1);
```

`calleeDef.line` here is `occ.range.startLine` stamped into
`buildSymbolDefIndex`'s map — also 0-indexed.

## How it silently breaks without the `+1`

The failure is **asymmetric** and therefore sneaky:

- **Caller side** (call expression inside a function body): the SCIP
  call line is 10–100 lines deep inside the enclosing function's
  1-indexed span. Being off by one still lands inside the span. Edge
  resolves correctly by accident.
- **Callee side** (callee's DEFINITION location): SCIP records the
  DEFINITION occurrence on the **identifier line** of the symbol
  declaration (e.g. real line 113 `export async function computeVerdict(`
  arrives as SCIP line 112). The 1-indexed Function node starts at
  line 113. Lookup at line 112 falls just above the node span.
  `findEnclosingNodeId` returns `undefined`, the edge is silently
  dropped.

In `open-code-hub` at commit `16939f7`, this off-by-one alone dropped
~2,200 of ~2,600 recoverable SCIP CALLS edges — ~85% loss — with no
error, warning, or log. Graph SCIP-CALLS count was 416 with the bug,
2,665 with `+1` applied.

## Diagnostic pattern

If `codehub impact --direction up` reports 0 reachable nodes for a
real function call site, and

```sql
SELECT confidence, reason FROM relations
WHERE to_id = '<target>' AND type = 'CALLS'
```

shows only `confidence=0.5 reason=global` edges (the tree-sitter
heuristic tier) with no `reason LIKE 'scip:%'` row, the SCIP edge is
either:

1. Not being emitted by `deriveEdges` (scope/filter problem — check
   `innermostEnclosing` and `isFunctionLike`).
2. Being emitted but dropped by `emitEdges` because one of:
   - **Callee has no DEFINITION anywhere** (external / stdlib / absent
     typings — correct drop).
   - **Cross-package descriptor mismatch** (`src/*.ts` def vs
     `dist/*.d.ts` ref — see `scip-monorepo-dist-src-alias.md`).
   - **Off-by-one in `findEnclosingNodeId`** — this file.

To isolate, instrument with a small uv script that `parseScipIndex` + 
`deriveIndex` + `buildSymbolDefIndex`, then for each derived edge
check whether `symbolDef.get(e.callee)` resolves and whether
`findEnclosingNodeId(nodesByFile, callLine+1)` returns a node. Inspect
the OCH `nodes` table for the file to sanity-check the span.

## Regression test

A unit test in `derive.test.ts` can't catch this — it's a boundary
between `scip-ingest` (which correctly reports SCIP's 0-indexed values)
and `ingestion/phases/scip-index.ts` (which must translate). Add a test
in `scip-index.test.ts` (or a smoke test) that:

1. Builds a `nodesByFile` map with one Function node at `startLine: 10,
   endLine: 20`.
2. Builds a derived edge with `callLine: 14` (SCIP 0-indexed; real line 15).
3. Calls `emitEdges` and asserts one `CALLS` edge is written from a
   caller at the expected node.

Without the `+1`, the edge fails to write — catches future regressions.

## When this does not apply

- Inside `scip-ingest` itself, where both sides are SCIP-native and
  0-indexed. The `+1` belongs at the OCH boundary, not inside the
  library.
- If OCH graph node coordinates ever change to 0-indexed (they're tied
  to tree-sitter's `row` plus 1 — check `providers/ts-shared.ts` and
  the tree-sitter query files before assuming).
