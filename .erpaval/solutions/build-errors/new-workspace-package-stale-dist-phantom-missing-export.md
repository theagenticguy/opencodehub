---
title: New workspace package / export surfaces phantom "no exported member" until clean rebuild
track: bug
category: build-errors
severity: medium
tags: [pnpm, monorepo, tsc, tsbuildinfo, dist, workspace-link, mise-check, diagnostics, erpaval]
modules: [packages/core-types, packages/lsp-tier, packages/pack, packages/scip-ingest]
discovered: session-893add (2026-06-19)
---

# Symptom

After an Act agent adds a NEW export to a workspace package (e.g. `SCIP_UNOFFICIAL_PROVENANCE_PREFIXES` in `@opencodehub/core-types`) or a whole NEW workspace package (`@opencodehub/lsp-tier`), the editor / a fresh `tsc` reports against the CONSUMERS:

```
'"@opencodehub/core-types"' has no exported member named 'SCIP_UNOFFICIAL_PROVENANCE_PREFIXES'
Cannot find module '@opencodehub/lsp-tier' or its corresponding type declarations. [2307]
```

…even though the symbol IS defined and IS barrel-exported (verified with grep), and the agent reports `mise run check` exited 0.

# Root cause

Consumers in the monorepo typecheck against each package's **compiled `dist/` + `*.tsbuildinfo`**, not its `src/`. Two stale-state cases:

1. **New export:** core-types' `dist/` predates the new export. `mise run check` runs `build` BEFORE `test`, so the agent's run was genuinely green at its moment — but any diagnostic taken against the pre-build `dist` (editor LSP, a bare `tsc --noEmit` before the build step) fires a phantom "no exported member."
2. **New package:** a brand-new `@opencodehub/<name>` is not yet linked into the workspace (`pnpm install` not re-run) and/or not yet built, so `[2307] Cannot find module` until `pnpm install` symlinks it and a build emits its `dist`.

Both are stale-state artifacts, NOT real defects.

# Fix / verification protocol

Before trusting OR disbelieving a green/red typecheck after a cross-package export or new-package change:

```bash
find packages -name "*.tsbuildinfo" -delete   # drop stale incremental state
pnpm install --frozen-lockfile                # relink workspace (new package → "20 projects")
mise run check                                # build-then-test from clean; THIS is authoritative
```

- The `pnpm install` "Scope: all N workspace projects" count is a quick confirm a new package linked (it ticks up by one).
- `grep` the definition + barrel re-export to confirm the symbol genuinely exists; if it does and the error persists, it's stale `dist`, not a missing export.

# Why it matters for the orchestrator

In an ERPAVal session this fires as `<new-diagnostics>` streamed from a concurrent/just-finished Act agent. Do NOT commit on the agent's "exit 0" word and do NOT panic at the red diagnostic — run the clean protocol above and use ITS exit code as the gate. Hit twice in one session (T-A-S core-types export, T-A-L new lsp-tier package); both were stale state, both cleared on clean rebuild. Related but distinct: [[tsconfig-project-references-stale-on-package-removal]] (that one is package REMOVAL; this is ADDITION).
