---
title: SCIP ingest must resolve callees from DEFINITION occurrences, not first call sites
tags: [scip, ingestion, graph, call-graph, impact, correctness]
first_applied: 2026-04-30
repos: [open-code-hub]
---

## The pattern

When ingesting a SCIP index into a local code graph, map each caller→callee
SCIP edge to local graph nodes using **two independent lookups**:

- **Caller node**: the innermost OCH node enclosing `(edge.document, edge.callLine)`. Robust because `deriveEdges` already filters to function-like symbols and the caller's enclosing range is the call site.
- **Callee node**: the innermost OCH node enclosing the callee's **definition site** — `(defDoc, defLine)` from a full pre-scan of the SCIP index for `symbolRoles & SCIP_ROLE_DEFINITION` occurrences.

Build a `symbolDef: Map<scipSymbol, {file, line}>` once per SCIP index, then join.

## What breaks when you skip the pre-scan

A tempting shortcut is to use the callee's **first seen call site** as a proxy for its definition — because call sites are cheaper to enumerate from the edge list itself. That is wrong.

Concrete failure mode we shipped to prod at commit `16939f7` and caught via benchmark:

- `isTestPath` is defined at both `packages/analysis/src/impact.ts:65` and `packages/ingestion/src/pipeline/phases/processes.ts:545`.
- SCIP symbol strings for the two are globally unique — the indexer gets it right.
- First-call-site heuristic: `defByScipSymbol[scipSymbol]` = first `{document, callLine}` pair pulled from the edge stream. That pair is by definition a **reference**, not a definition.
- `findEnclosingNodeId(callSiteDoc, callSiteLine)` then returned the function *containing the call*, not the function being called. 32 out of 34 inbound edges for `analysis/impact.ts:isTestPath` routed to the wrong target node.
- Downstream: `impact --direction up --depth 3` reported 83 reachable nodes vs ground-truth 3 (27.7× over-report). Blast radius was `CRITICAL` on a symbol whose real blast radius is `LOW`.

Fixing the shortcut dropped the monorepo edge count from 102 k → 97.9 k — ~4 k fabricated edges eliminated.

## The correct shape

```ts
// packages/scip-ingest/src/derive.ts
export function buildSymbolDefIndex(
  index: ScipIndex,
): ReadonlyMap<string, { file: string; line: number }> {
  const defs = new Map<string, { file: string; line: number }>();
  for (const doc of index.documents) {
    for (const occ of doc.occurrences) {
      if (!(occ.symbolRoles & SCIP_ROLE_DEFINITION)) continue;
      if (!occ.symbol) continue;
      if (defs.has(occ.symbol)) continue; // first-seen definition wins
      defs.set(occ.symbol, { file: doc.relativePath, line: occ.range.startLine });
    }
  }
  return defs;
}
```

Then in the phase:

```ts
const derived = deriveIndex(index);
const symbolDef = buildSymbolDefIndex(index);
emitEdges(ctx, nodesByFile, derived.edges, symbolDef, reason, existingKeys);
```

Inside `emitEdges`:

```ts
const def = symbolDef.get(e.callee);
if (!def) continue; // external / stdlib / absent typings — drop
const toId = findEnclosingNodeId(nodesByFile, def.file, def.line);
if (!toId) continue;
```

## Why this is robust

- **Globally unique symbol strings.** SCIP symbols include scheme + manager + package + version + descriptor. Two same-named functions in different files cannot collide.
- **Full-index pre-scan is linear.** One pass over `index.documents[*].occurrences[*]` — the same data you already parse.
- **First-seen definition is safe.** Ambient redeclarations, `.d.ts` shims, and overloads all land inside the same function body's enclosing range; picking any of them and then calling `findEnclosingNodeId` routes to the same OCH node.
- **Missing-def = external.** If a symbol has no DEFINITION anywhere in the index, the callee lives outside the repo (stdlib / vendored dep). Dropping those edges is the right behavior — they cannot be attributed to a local node.

## Regression test shape

```ts
it("keeps two same-named functions distinct in the def index", () => {
  const index = makeIndexWithTwoFoos(); // distinct SCIP symbols, different files
  const defs = buildSymbolDefIndex(index);
  assert.equal(defs.get(fooSymA)!.file, "packages/a/src/x.ts");
  assert.equal(defs.get(fooSymB)!.file, "packages/b/src/y.ts");
  assert.notEqual(fooSymA, fooSymB);
});
```

## Related contract

The `confidence=1.0` + `reason startsWith "scip:<indexer>@<v>"` oracle contract from `scip-replaces-lsp.md` is unchanged. This fix only affects *which node* each SCIP edge lands on — not its confidence, reason, or type.

## When this does not apply

- Single-file SCIP indexes (no cross-file name collisions possible). You can skip `buildSymbolDefIndex` and rely on intra-doc `findDefinition` — but at that point you're just doing `deriveEdges`. No harm in always running the map.
- Tree-sitter / AST-only pipelines that don't have globally unique symbol strings. Those need a different resolver (the three-tier walker).
