---
title: Lift pure helpers to the deepest shared workspace dependency to break future cycles
tags: [monorepo, dependency-graph, refactoring, workspace-cycles]
session: session-e1d819
---

## Context

`classifyDependencies` (license tier classification, ~30 LOC pure
function) lived in `packages/mcp/src/tools/license-audit.ts`.
`packages/pack/src/licenses.ts` (M5-5 BOM body) needed it. But
`@opencodehub/mcp` already depends on `@opencodehub/pack` via the
`pack_codebase` MCP tool wrapper — a `pack → mcp` import would create
a `mcp → pack → mcp` cycle. T-W2-3 (commit 9d8d570) lifted the function
into `@opencodehub/analysis`, which both `mcp` and `pack` already depend
on, in a single mechanical chore commit.

## Lesson

When a pure helper in package A is needed by package B, and a `B → A`
import would create a cycle, lift the helper to the **deepest shared
dependency** in the workspace dep graph (the LCA in package-import
terms). Procedure:

1. Identify the LCA package by walking up imports from both A and B
   (`pnpm why @opencodehub/<dep>` or visual inspection of
   `package.json` workspace deps).
2. Move the function + supporting types **byte-identical** — preserve
   every comment, signature, regex (in this case `COPYLEFT_PATTERN
   = /^(GPL|AGPL|SSPL|EUPL|CPAL|OSL|RPL)/`).
3. Re-export from the destination package's barrel (`index.ts`) at the
   alphabetically-correct position to match existing convention.
4. Replace local impl in package A with `import { fn } from "@org/lca"`.
   Do **not** retain a re-export shim — direct imports are cleaner and
   prevent future "should I import from A or LCA?" drift.
5. Move tests to the LCA package; keep the original package's test if
   it covers integration via the imported symbol.
6. Commit scope: `chore(<lca-pkg>):` (cross-package symbol moves are
   chores, not features).

## Why

The alternative — path-importing from `packages/<pkg>/src/...` or
hardcoding a `.js` import — works but cements the cycle, blocks future
tree-shaking, and creates two ways to call the same function. Lifting
to the LCA preserves the dep graph as a DAG and gives every future
consumer one canonical import path. The 30-LOC mechanical lift takes
~1 hour and unblocks the downstream feature with zero behavior change.
