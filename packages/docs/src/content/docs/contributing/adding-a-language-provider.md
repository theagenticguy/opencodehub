---
title: Adding a language provider
description: Four steps to wire a new language into the OpenCodeHub ingestion pipeline.
sidebar:
  order: 60
---

OpenCodeHub ships 15 tree-sitter language providers today: TypeScript,
TSX, JavaScript, Python, Go, Rust, Java, C#, C, C++, Ruby, Kotlin,
Swift, PHP, and Dart. Five of them (TypeScript, Python, Go, Rust, Java)
are further upgraded with SCIP indexers for compiler-grade cross-module
edges.

Adding a new language is four steps. The registry is compile-time
exhaustive, so the TypeScript build fails if you forget step three.

## Step 1 — Pin the tree-sitter grammar

Add the grammar as a pinned dependency in `packages/ingestion/package.json`.
Use a concrete semver; do not use `^` or `latest`. Grammars change AST
shapes between versions and a float range will silently break
extraction.

```json title="packages/ingestion/package.json"
{
  "dependencies": {
    "tree-sitter-<lang>": "1.2.3"
  }
}
```

Then `pnpm install` and verify the grammar loads by running the parse
bootstrap tests locally.

## Step 2 — Implement the provider

Create `packages/ingestion/src/providers/<lang>.ts` exporting a
`LanguageProvider` object. The interface lives at
`packages/ingestion/src/providers/types.ts`. Required fields and
methods:

| Member                | Purpose                                                                 |
|-----------------------|-------------------------------------------------------------------------|
| `id`                  | The `LanguageId` string (must already exist in `@opencodehub/core-types`) |
| `extensions`          | File extensions this provider claims                                    |
| `importSemantics`     | `named` / `namespace` / `package-wildcard` (see below)                 |
| `mroStrategy`         | `c3` / `first-wins` / `single-inheritance` / `none` (see below)         |
| `typeConfig`          | `{ structural, nominal, generics }` booleans                            |
| `heritageEdge`        | `"EXTENDS"` / `"IMPLEMENTS"` / `null`                                   |
| `extractDefinitions`  | Emit one record per defined symbol                                      |
| `extractCalls`        | Emit one record per call site                                           |
| `extractImports`      | Parse `import` / `use` / `require` statements                           |
| `extractHeritage`     | Emit inheritance / trait-impl / interface-implements edges              |
| `isExported`          | Predicate: is this definition publicly exported?                        |

Optional hooks improve coverage:

| Member                    | Purpose                                                           |
|---------------------------|-------------------------------------------------------------------|
| `detectOutboundHttp`      | Detect `fetch("/api")`, `requests.get(url)`, `axios.post(url, ...)` |
| `extractPropertyAccesses` | Emit `ACCESSES` edges for `receiver.property` reads/writes        |
| `preprocessImportPath`    | Strip `.js` suffix for TS, resolve `__init__.py`, etc.            |
| `inferImplicitReceiver`   | Name for `this` / `self` inside a method body                     |
| `complexityDefinitionKinds` / `halsteadOperatorKinds` | Enable cyclomatic + Halstead metrics |

### Picking `importSemantics`

- **`named`** — the statement names specific symbols:
  `import { foo } from "bar"` (TypeScript, JavaScript), `import foo.Bar`
  (Java), `use std::io::Read` (Rust), `using System.IO` (C#). Use this
  for most typed languages.
- **`namespace`** — the statement imports a whole module under a name:
  `import os` / `from os import path` (Python). The resolver walks
  `<module>.<symbol>` chains at call sites.
- **`package-wildcard`** — the statement pulls a whole package symbol
  set into scope: `import "fmt"` (Go). Every exported symbol of `fmt`
  becomes directly callable.

Today's breakdown: `package-wildcard` is used by Go; `namespace` is
used by Python; everything else (12 languages) uses `named`.

### Picking `mroStrategy`

- **`c3`** — full C3 linearization. Raises on ambiguity. Used by
  Python (matches CPython's MRO semantics).
- **`first-wins`** — left-to-right source order. Used by TypeScript,
  TSX, JavaScript, and Rust. Fast, predictable, matches how these
  languages' compilers actually resolve.
- **`single-inheritance`** — one `extends` chain plus a set of
  interfaces. Used by Java, C#, Kotlin. The chain walk is cheap; the
  implements set is checked at resolution time.
- **`none`** — no traditional inheritance. Used by Go (composition via
  embedded fields, no `extends`). The method-resolution walker is
  skipped entirely.

If your language is new, pick the strategy that matches its compiler's
actual semantics. Do not invent a fifth option — the four above cover
every mainstream type system.

## Step 3 — Register in the provider registry

Open `packages/ingestion/src/providers/registry.ts` and add your
provider to the `providers` object.

```ts title="packages/ingestion/src/providers/registry.ts"
const providers = {
  typescript: typescriptProvider,
  // ...
  zig: zigProvider,                      // new
} satisfies Record<LanguageId, LanguageProvider>;
```

The `satisfies Record<LanguageId, LanguageProvider>` clause is the
compile-time check. If you add `zig` to the `LanguageId` union in
`@opencodehub/core-types` but forget to register a provider, the
TypeScript build fails with a missing-key error. That is intentional —
the type error is how the registry stays exhaustive.

## Step 4 — Add fixture tests

Under `packages/ingestion/test/fixtures/<lang>/` add source files that
exercise every extractor the provider implements. Use the
`parseFixture` helper from
`packages/ingestion/src/providers/test-helpers.ts`:

```ts title="packages/ingestion/test/providers/<lang>.test.ts"
import { parseFixture } from "../../src/providers/test-helpers.js";
import { <lang>Provider } from "../../src/providers/<lang>.js";

const result = await parseFixture(pool, "<lang>", "sample.<ext>", src);
const defs = <lang>Provider.extractDefinitions({
  filePath: "sample.<ext>",
  captures: result.captures,
  sourceText: src,
});
// assert on defs...
```

Cover at minimum: a top-level function, a class with one method, an
import statement, a call to an imported symbol, and an exported vs.
non-exported symbol. If your language has generics / traits /
interfaces, add a fixture per heritage shape.

The `parseFixture` helper returns a pool-borrowed `ParseCapture` array
that matches exactly what the ingestion pipeline passes in at runtime,
so the assertions you write here mirror production behaviour.

## CI expectations

Once the four steps are in place:

- `mise run lint` — Biome check passes.
- `mise run typecheck` — registry exhaustiveness passes.
- `mise run test` — your fixture tests pass under `pnpm -r test`.
- `mise run banned-strings` — you did not accidentally copy names from
  another project.

If your language has an available SCIP indexer, a follow-up PR can add
it to `packages/scip-ingest/src/runners/` and `.github/workflows/gym.yml`
to upgrade heuristic edges to compiler-grade. That is not required for
shipping the heuristic provider.

## Related files

- `packages/ingestion/src/providers/types.ts` — the `LanguageProvider`
  interface.
- `packages/ingestion/src/providers/registry.ts` — the exhaustive map.
- `packages/ingestion/src/providers/test-helpers.ts` — `parseFixture`.
- `@opencodehub/core-types` — the `LanguageId` union.
