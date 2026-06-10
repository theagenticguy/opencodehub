---
title: Stale orphaned *.test.js in dist/ fails after a source test is renamed/removed
track: bug
category: test-failures
module: packages/ingestion
component: tsup/tsc build + node --test glob
severity: medium
tags: [stale-dist, node-test, build-prune, orphan-artifact, false-failure]
symptoms:
  - "node --test reports a file-level failure like `not ok N - dist/parse/wasm-runtime.test.js`"
  - "SyntaxError: The requested module './X.js' does not provide an export named 'Y'"
  - "The failing test has NO corresponding src/**/*.test.ts source file anymore"
  - "Failure reproduces on a clean HEAD with all working-tree changes stashed"
root_cause: |
  The build compiles src/ into dist/ but does NOT prune dist/ first. When a
  *.test.ts source is renamed or deleted (or a symbol it imported is removed),
  the previously-compiled *.test.js lingers in dist/. The test command globs
  `node --test "./dist/**/*.test.js"`, so it picks up the orphan and runs it
  against the current (incompatible) compiled modules → import/SyntaxError.
  This is NOT a logic failure and is unrelated to whatever you just changed.
resolution_type: code-fix
applies_when:
  - "A node --test failure points at a dist/ file with no matching src .test.ts"
  - "The error is an import/export SyntaxError, not an assertion failure"
  - "It reproduces with your changes stashed (i.e. on clean HEAD)"
---

# Fix

First, attribute it: stash your changes and rebuild — if it still fails, it's
pre-existing, not yours.

```bash
git stash push -u -- packages/
pnpm --filter @opencodehub/<pkg> build && node --test packages/<pkg>/dist/**/relevant.test.js
git stash pop
```

Then clear the orphan with a clean rebuild (the build does not prune dist/):

```bash
pnpm --filter @opencodehub/<pkg> run clean && pnpm --filter @opencodehub/<pkg> build
```

Detect orphans programmatically (dist test with no source):

```bash
for f in $(find packages/<pkg>/dist -name '*.test.js'); do
  src="packages/<pkg>/src/${f#packages/<pkg>/dist/}"; src="${src%.js}.ts"
  [ -f "$src" ] || echo "ORPHAN: $f"
done
```

Durable follow-up: make the build prune `dist/` (or orphaned `*.test.js`) before
compiling so `node --test`'s glob can't resurrect a deleted test.

# Why this matters

Without attribution you can burn an entire Validate phase "fixing" a failure you
never caused, or — worse — wave it off as flaky and ship a real regression next to
it. The stash-and-reproduce step is the cheap discriminator. Relates to
[[tsup-collapse-monorepo-to-single-cli]] (the same dist/ globbing surface) and the
general tsc-incremental-cache trap: never trust dist/ after a source rename without
a clean rebuild.
