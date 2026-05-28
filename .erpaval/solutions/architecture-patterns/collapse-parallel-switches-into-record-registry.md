---
name: collapse-parallel-switches-into-record-registry
description: When 2+ functions each switch over the same closed union (one switch per derived attribute), collapse them into a single `Record<Union, Entry>` registry. tsc enforces exhaustiveness the same way `noFallthroughCasesInSwitch` did, the functions become one-line lookups, and ONE table-driven test pins every (key, attribute) pair — strictly better coverage than the transitive phase tests the switches relied on.
metadata:
  type: architecture-pattern
  category: architecture-patterns
tags: [refactor, typescript, exhaustiveness, test-consolidation, scip, simplification]
discovered: 2026-05-28
session: session-88b46e
related:
  - storage-list-nodes-over-scattered-sql
  - typed-finders-replace-raw-sql-in-consumers
---

# Collapse parallel switches into a `Record<Union, Entry>` registry

## The smell

Several functions, each a `switch` over the SAME closed string-literal union, each returning a different derived attribute:

```ts
function scipLangToOchLang(k: IndexerKind): string { switch (k) { case "clang": return "c"; ... } }
function kindToTool(k: IndexerKind): string { return k === "rust" ? "rust-analyzer" : `scip-${k}`; }
function kindToProvenance(k: IndexerKind): ScipIndexerName { switch (k) { ... } }
```

When you add a language you must remember to touch N switches. The switches drift independently, and the only thing keeping them honest is `noFallthroughCasesInSwitch` per-function — which catches a missing case but not a wrong-but-present one.

## The collapse

One registry, one entry per union member, one field per former switch:

```ts
interface LangEntry { readonly ochLang: string; readonly tool: string; readonly provenance: ScipIndexerName | null; }
const LANG_REGISTRY: Record<IndexerKind, LangEntry> = {
  typescript: { ochLang: "typescript", tool: "scip-typescript", provenance: "scip-typescript" },
  clang:      { ochLang: "c",          tool: "scip-clang",      provenance: "scip-clang" },
  "cobol-proleap": { ochLang: "cobol", tool: "scip-cobol-proleap", provenance: null },
  ...
};
function scipLangToOchLang(k: IndexerKind) { return LANG_REGISTRY[k].ochLang; }
```

Adding a language is now ONE row that the compiler forces you to fully populate.

## Why `Record<Union, Entry>` is the right shape

- **Exhaustiveness is preserved, not lost.** `Record<IndexerKind, LangEntry>` is a compile error if a union member is missing OR if you add a key not in the union — the exact guarantee `noFallthroughCasesInSwitch` gave each switch, now in one place.
- **A wrong attribute is now visible.** All three attributes for a kind sit on one line, so "clang maps to c but scip-clang" is reviewable at a glance instead of spread across three functions 30 lines apart.
- **Honest nulls beat placeholder lies.** One switch arm (`cobol-proleap` → provenance) had been returning `"scip-typescript"` purely to satisfy exhaustiveness, with a comment admitting it was never called for that kind. In the registry that becomes `provenance: null` + a throw at the lookup if ever reached — the type now tells the truth.

## Test consolidation — the real win

The three switches had ZERO direct unit tests; they were covered transitively by phase integration tests. The collapse lets you add ONE table-driven test that pins the FULL mapping:

```ts
const EXPECTED: Record<IndexerKind, ExpectedEntry> = { /* all 10 kinds × 3 fields */ };
it("maps every IndexerKind to {ochLang, tool, provenance}", () => {
  for (const [kind, expected] of Object.entries(EXPECTED) as [IndexerKind, ExpectedEntry][])
    assert.deepEqual(LANG_REGISTRY[kind], expected);
});
it("has exactly one entry per IndexerKind", () => {
  assert.deepEqual(Object.keys(LANG_REGISTRY).sort(), Object.keys(EXPECTED).sort());
});
```

The `Record<IndexerKind, ExpectedEntry>` annotation on the FIXTURE makes the test itself exhaustive — adding a kind without updating the fixture is a compile error in the test. Two test blocks now cover what zero direct tests covered before: **strictly better coverage, minimal test count.** Export the registry (or a `lookup(kind)` accessor) for the test; keep it out of the package's public `index.ts`.

## How to apply

1. Spot 2+ functions switching over the same union. The more attributes, the bigger the win.
2. Define `interface Entry` with one field per former switch. Use `| null` for attributes that genuinely don't apply to some members — don't invent a placeholder value.
3. `const REGISTRY: Record<Union, Entry> = { ... }`. Let tsc force completeness.
4. Replace each function body with `REGISTRY[k].field` (throw on `null` if the field is non-optional for real callers).
5. Add ONE table-driven test with a `Record<Union, Expected>` fixture. Delete any now-redundant per-attribute assertions.
6. Preserve EXACT outputs for every union member — this is a mechanical refactor, not a behavior change. Diff the old switch arms against the new rows one-for-one.

## When NOT to do this

- If the switches have per-case SIDE EFFECTS (not just return values) — a registry of data can't hold control flow. Keep the switch or use a registry of functions only if that's genuinely cleaner.
- If the union is open / frequently extended by external packages — a `Record` over a local union won't capture members defined elsewhere.

## Linked

- [[storage-list-nodes-over-scattered-sql]] — same "collapse N call sites into one typed thing" family.
- [[typed-finders-replace-raw-sql-in-consumers]] — same family on the storage side.
- PR #143 — the IndexerKind collapse (3 switches → 1 registry, +R15 placeholder fix).
