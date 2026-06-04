---
title: Collapse a publish-many TS monorepo into one bundled CLI with tsup
tags: [tsup, esbuild, monorepo, npm, publish, bundling, workers, piscina, wasm, release-please, collapse]
modules:
  - packages/cli/tsup.config.ts
  - packages/cli/package.json
  - packages/cli/tsconfig.test.json
  - packages/cli/src/commands/doctor.ts
  - .release-please-config.json
first_applied: 2026-06-04
session: session-a99b0c
track: knowledge
category: architecture-patterns
---

# Collapse a publish-many TS monorepo into one bundled CLI with tsup

## Context

OpenCodeHub published **17 npm packages** (one CLI + 16 libraries), all plain
`tsc -b`, no bundler. Goal: publish only `@opencodehub/cli`, inlining the 14
internal libs into its tarball. Motivation was operational, not cosmetic — see
the "why this matters" section. The collapse went green end-to-end (9/9
global-install gates) but only after solving five coupled problems esbuild does
NOT handle for you.

## The recipe that works

`packages/cli/tsup.config.ts`:

```ts
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "parse-worker": "../ingestion/src/parse/parse-worker.ts",        // worker → own chunk
    "embedder-worker": "../ingestion/src/pipeline/phases/embedder-worker.ts",
  },
  format: ["esm"], platform: "node", target: "node20",
  splitting: true, clean: true, dts: false,
  // NO shims: true  — see gotcha 2
  external: [/^[^.]/],                 // externalize EVERY bare import …
  noExternal: [/^@opencodehub\//],     // … except our own workspace libs (inline them)
  async onSuccess() { /* cp vendor/wasms, plugin-assets, ci-templates, config, java → dist/ */ },
})
```

## The five things esbuild will NOT do for you

1. **Workers are not followed.** esbuild does not rewrite
   `new Worker(new URL("./w.js", import.meta.url))` or piscina `filename:` — it
   leaves the string verbatim, resolved at runtime against the EMITTED file. So
   every worker must be a **named `entry`** that emits a sibling chunk
   (`dist/parse-worker.js`) at the path the pool's `import.meta.url` expects.
   `splitting: true` keeps shared code in `chunk-*.js` instead of duplicating it
   into each worker.

2. **`external: [/^[^.]/]` beats an explicit allowlist** — and you must drop
   `shims: true`. Externalize every bare import (anything not starting with `.`)
   and bundle only `@opencodehub/*` via `noExternal`. An explicit native-only
   `external` list let esbuild wander into a transitive dep's optional-plugin
   `require()` graph (`@cyclonedx/cyclonedx-library` → `require("xmlbuilder2")` /
   `require("libxmljs2")`) and hard-fail. But `/^[^.]/` also matches tsup's own
   injected `esm_shims.js` absolute path → "cannot be marked as external". Fix:
   drop `shims: true` (native ESM uses `import.meta.url` directly).

3. **Assets that load via `import.meta.url` are not copied.** esbuild's
   file/copy loaders only fire on `import`-ed assets. The WASM grammars,
   plugin-assets, ci-templates, scanner config TOML, and the COBOL JVM bridge
   are walk-up-resolved at runtime, so copy them in `onSuccess` and make the
   resolvers **walk up looking for a sentinel** (e.g. `vendor/wasms/manifest.json`)
   rather than a fixed `../../` offset — the offset shifts when code is inlined.

4. **Tests don't ship in the bundle.** tsup emits only the entrypoints, so the
   38 `*.test.ts` files vanish from `dist/` and `node --test` silently finds
   zero tests (a green-looking regression). Add a `tsconfig.test.json` that
   `tsc`-compiles the full `src` tree to a **gitignored `dist-test/`**, and point
   the `test` script there. Asset-dependent tests (`init`, `ci-init`) must
   resolve assets from the source-of-truth (`plugins/opencodehub`,
   `src/commands/ci-templates`) since `dist-test/` has no copied assets.

5. **Deliberately-hidden dynamic imports must become static.** Code that wrote
   `const s = "@opencodehub/mcp"; await import(s)` to dodge the build-time graph
   now points at a package that won't exist post-collapse. Convert to a static
   `import`. Same for `import.meta.resolve("@opencodehub/sarif")` probes in
   `doctor.ts` — replace with a liveness check on a statically-imported symbol
   (`typeof mergeSarif === "function"`). See [[doctor-probe-drift-after-rip-and-replace]].

## Package wiring

- The 14 internal libs → `private: true` (not published) and moved to the CLI's
  **devDependencies** (tsup needs them at build time to inline from their `dist`).
- The CLI's runtime `dependencies` = exactly the third-party set the bundle
  imports (derive it: `cat dist/*.js | grep -oE '(from |import\()"[^"]+"'` →
  filter bare specifiers), PLUS any subprocess-spawned bins
  (`@sourcegraph/scip-*`) that won't appear in the import scan but are resolved
  via `createRequire` at runtime.
- `release-please`: drop the 16 private packages from `packages` + manifest;
  remove the `node-workspace` plugin (no inter-package version sync needed).
- Add every newly-static workspace import to the CLI's `tsconfig.json`
  `references` (e.g. `../mcp`) or composite incremental builds break.

## Why this matters

The collapse is not cosmetic. It eliminates the entire
[[workspace-tarball-pack-all-publishables]] bug class (published-graph-vs-local
divergence is impossible with one package), and cuts the npm trusted-publisher
toil from 17 manual passkey-gated web-UI saves to 1 (see
[[npm-trusted-publisher-matches-entry-workflow-not-reusable]]). The shipped
tarball was 2.7 MB compressed / 27 MB unpacked (25 MB is the required vendored
WASM grammars, unchanged), with **0 nested `@opencodehub` dirs** — full inlining
confirmed.

## Related

- [[doctor-probe-drift-after-rip-and-replace]] — doctor's resolve-by-package
  probes are the canonical thing that breaks on any rip/collapse.
- [[workspace-tarball-pack-all-publishables]] — the bug class this collapse kills.
- [[exclude-heavy-build-from-pnpm-recursive]] — sibling concern: docs/Astro is
  still excluded from `-r build`.
