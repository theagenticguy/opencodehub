---
name: tsconfig project references go stale on package removal
description: When deleting a workspace package in a pnpm+TS monorepo, also remove its entry from the root tsconfig.json references array; stale references hide until a filtered `pnpm -r` run puts the root in scope.
type: project
---

When a package is removed from a TypeScript monorepo (pnpm + composite
project references), the root `tsconfig.json` `references` array does
NOT auto-update. The stale entry sits dormant until something actually
runs `tsc` from the repo root — at which point it blows up with
`TS6053: File '<path>' not found`.

**What made this hide for a long time:**

Unfiltered `pnpm -r exec tsc --noEmit` walks every workspace package
and invokes tsc in their scopes. Each package-level tsconfig extends
the base and has its own explicit `files` or `include` — the root
tsconfig is never read. So a stale project reference at the root is
invisible.

The failure surfaces the moment you change invocation patterns:

- Switching to a filter like `pnpm -r --filter='!@opencodehub/docs' exec tsc`
  still includes the repo root in the scope (pnpm treats the root as a
  workspace member when it has scripts). Now tsc is invoked at the
  root too, which reads the root tsconfig, which chokes on the stale
  reference.
- Running `tsc --build` at the root (as opposed to per-package) also
  exposes it immediately.

Seen on 2026-05-01: SCIP-replaces-LSP migration (commit `6e1227…`)
deleted `packages/lsp-oracle` but left `{ "path": "./packages/lsp-oracle" }`
in the root tsconfig. The drift was invisible for 8 days across many
CI runs, surfaced only after a filter change in `.github/workflows/ci.yml`
added `--filter='!@opencodehub/docs'` to the typecheck step.

**Why:** pnpm recursive commands include the repo root as an implicit
scope member; package-level tsc invocations never read root tsconfig;
so the only way to notice is either a root-level tsc or a root-scoped
pnpm invocation. The monorepo ran neither until this week.

**How to apply:**

1. When deleting a package, grep for references before the commit:
   `grep -rn "packages/<name>" tsconfig*.json packages/*/tsconfig*.json`.
2. Fix root `tsconfig.json` in the same commit that removes the
   package.
3. If a CI step starts failing with `TS6053` after unrelated changes,
   check for stale project references before chasing the surface
   cause — the new invocation pattern probably exposed old debt.

Related repo convention: `packages/` is the workspace root (per
`pnpm-workspace.yaml`). Anything removed from there needs tsconfig,
`pnpm-workspace.yaml`, `package.json` workspaces, and (sometimes)
`mise.toml` task updates.
