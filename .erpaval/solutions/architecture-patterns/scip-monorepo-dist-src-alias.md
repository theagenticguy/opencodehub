---
title: SCIP symbol-def index must alias `src/*.ts` defs under `dist/*.d.ts` in a TS monorepo
tags: [scip, ingestion, graph, monorepo, typescript, types, cross-package]
first_applied: 2026-04-30
repos: [open-code-hub]
---

## The pattern

In a pnpm/yarn workspace TypeScript monorepo where each package declares
`"types": "./dist/<name>.d.ts"` in its `package.json`, scip-typescript
emits SCIP symbol strings with **two different descriptor shapes for the
same logical symbol**, depending on where the occurrence appears:

- **Intra-package refs + defs** (both sides inside `@opencodehub/foo`):
  descriptor carries `src/<path>.ts`.
- **Cross-package refs** (`@opencodehub/bar` importing from
  `@opencodehub/foo`): descriptor carries `dist/<path>.d.ts` — because the
  compiler resolves the import through the package's published type root.

Example in `open-code-hub`:

```
DEF (in analysis):  scip-typescript npm @opencodehub/analysis 0.1.0 src/`verdict.ts`/computeVerdict().
REF (from mcp):     scip-typescript npm @opencodehub/analysis 0.1.0 dist/`verdict.d.ts`/computeVerdict().
```

If a symbol-def index keys only on the raw SCIP symbol string, cross-
package refs fail to resolve to their defs. In this repo the effect was
dropping ~8,500 of ~11,900 derived SCIP CALLS edges — dominated by every
inter-package function call.

## The fix

In `buildSymbolDefIndex`, for every DEFINITION occurrence whose
descriptor carries `src/<p>.ts`, also register the same `{file, line}`
under the alias where the descriptor is rewritten to `dist/<p>.d.ts`.

```ts
const SRC_TO_DIST_DESCRIPTOR = / src\/((?:[^`\s]+\/)*)`([^`]+)\.ts`/;

function toDistAlias(symbol: string): string | null {
  const rewritten = symbol.replace(
    SRC_TO_DIST_DESCRIPTOR,
    " dist/$1`$2.d.ts`",
  );
  return rewritten === symbol ? null : rewritten;
}
```

Then inside the loop:

```ts
defs.set(occ.symbol, site);
const alias = toDistAlias(occ.symbol);
if (alias && !defs.has(alias)) defs.set(alias, site);
```

The leading ` ` anchors the rewrite to the descriptor field (5th space-
separated field of a non-local SCIP symbol), so internal `src/` substrings
that might appear elsewhere in the symbol are not rewritten. The rewrite
also handles nested directory segments (`src/tools/shared.ts` →
`dist/tools/shared.d.ts`) via the greedy `(?:[^\`\s]+\/)*` capture.

## Why this is safe

- SCIP symbol strings include `<package-name> <version>`, so the aliased
  `dist/<p>.d.ts` key in `@opencodehub/analysis@0.1.0` can only match a
  ref from the same package-version. No cross-package collision risk.
- First-seen semantics preserved via `if (!defs.has(alias))`.
- Only `src/<p>.ts → dist/<p>.d.ts` is aliased. No reverse alias —
  definitions are always authored in `src/`, so there's no legitimate
  `dist/*.d.ts` DEFINITION occurrence to rewrite backward.

## Accompanying off-by-one: SCIP ranges are 0-indexed

`Occurrence.range.startLine` from `@opencodehub/scip-ingest`'s parsed
SCIP is 0-indexed. OCH graph node `startLine` / `endLine` values are
1-indexed (tree-sitter `startPosition.row + 1`). When passing a SCIP
range line into `findEnclosingNodeId(nodesByFile, file, line)`, you
MUST add 1:

```ts
const fromId = findEnclosingNodeId(nodesByFile, e.document, e.callLine + 1);
const toId   = findEnclosingNodeId(nodesByFile, calleeDef.file, calleeDef.line + 1);
```

Without the `+1`, **caller** lookups still usually work (call sites land
well inside function bodies), but **callee** lookups fail systematically
— SCIP records the callee's DEFINITION on the identifier line, which is
typically the function's declaration line, and 0-indexed means that's
line-1 vs the 1-indexed node span start. `findEnclosingNodeId` returns
`undefined` (the line-1 position is just above the function body),
edges are silently dropped.

In this repo the `+1` fix lifted graph SCIP CALLS count from 416 → 2,665.

## Regression test pattern

```ts
it("aliases a src-shape def under its dist-shape cross-package descriptor", () => {
  const scheme = "scip-typescript npm @opencodehub/analysis 0.1.0";
  const src = `${scheme} src/\`verdict.ts\`/computeVerdict().`;
  const dist = `${scheme} dist/\`verdict.d.ts\`/computeVerdict().`;
  const index = makeIndexWith(src, "packages/analysis/src/verdict.ts", 112);
  const defs = buildSymbolDefIndex(index);
  const hit = defs.get(dist);
  assert.equal(hit?.file, "packages/analysis/src/verdict.ts");
  assert.equal(hit?.line, 112);
});
```

Also test a nested-path case (`src/tools/shared.ts` ↔ `dist/tools/shared.d.ts`)
to exercise the greedy directory-segment capture.

## When this does not apply

- Single-package repos with no `dist/` type root. Symbols only carry one
  shape; aliasing is a no-op.
- Monorepos that set `"types": "./src/<name>.ts"` — uncommon but possible.
  In that case intra-package and cross-package refs all use `src/` and
  no aliasing is needed.
- Non-TypeScript SCIP indexers (scip-python, scip-go, rust-analyzer).
  Each has its own descriptor conventions and may not have this
  `src`/`dist` split. Verify per-language before generalizing.

## Related contracts preserved

- `SCIP_CONFIDENCE = 1.0` and `reason startsWith "scip:<indexer>@<v>"`
  are unchanged. Alias fix only affects which in-repo node each edge
  lands on, not the oracle contract.
- See `scip-replaces-lsp.md` for why SCIP is the oracle edge source in
  the first place.
- See `scip-callee-definition-site.md` for the prior-session fix that
  replaced the first-call-site heuristic with `buildSymbolDefIndex` —
  which is where this alias fix plugs in.
