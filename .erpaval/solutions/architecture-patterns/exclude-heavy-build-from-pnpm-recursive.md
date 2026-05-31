---
name: "Exclude heavy-build packages (docs, e2e fixtures) from pnpm-recursive build/test in non-owner workflows"
description: When a workspace contains a package whose build pulls in heavy tooling (Playwright, headless Chromium, browser binaries), exclude it from `pnpm -r build/test` in workflows that don't own that build — use the dedicated workflow's --filter scope.
type: architecture-patterns
---

The `@opencodehub/docs` Starlight package's `build` script runs
`astro build` which invokes `rehype-mermaid` which boots Playwright +
headless Chromium to render mermaid fences to inline SVG. That
toolchain is intentionally heavy and only required when the docs site
is actually being published.

`pages.yml` installs Chromium with apt deps:
```yaml
- run: pnpm --filter @opencodehub/docs exec playwright install chromium --with-deps
```

Other workflows (CI typecheck, OCH self-scan, release build, publish
dry-run) ran `pnpm -r build` which iterated INTO the docs package
with no Chromium installed. Failure mode:

```
browserType.launch: Executable doesn't exist at
/home/runner/.cache/ms-playwright/chromium_headless_shell-1217/...
```

The error was confusing because the docs build worked LOCALLY (dev had
Chromium cached) and the docs build worked in `pages.yml` (which
explicitly installs it). The non-docs workflows hit the gap.

**Why:** pnpm's recursive flag `pnpm -r <cmd>` defaults to running the
command in every workspace package. Most consumers want this for
"build all the TS, run all the tests" style cross-package checks. But
it's the wrong default for cross-package tasks that don't actually
need the heavy package's output.

**How to apply:**

For every workflow other than the docs publish workflow:

```yaml
- run: pnpm --filter '!@opencodehub/docs' -r build
- run: pnpm --filter '!@opencodehub/docs' -r exec tsc --noEmit
- run: pnpm --filter '!@opencodehub/docs' -r test
```

The `!<name>` syntax negates a pnpm filter. Combined with `-r`, this
applies the command to every workspace EXCEPT the named one. Document
the why in a comment on the line so a future maintainer doesn't undo
it:

```yaml
# Skip @opencodehub/docs — its build runs astro + rehype-mermaid +
# playwright (headless Chromium dep) and is exercised on the
# dedicated `pages.yml` workflow with --with-deps installed.
run: pnpm --filter '!@opencodehub/docs' -r build
```

This pattern generalizes to any "heavy package" that satisfies all of:
- The package builds successfully on its own dedicated workflow.
- The package exports nothing other workspaces consume (no shared
  types, no runtime imports).
- The package's build pulls in browsers, simulators, native binaries,
  large model weights, or any other heavy artifact.

If the package DOES export shared types, narrow the exclusion: build
the types-only entry (`pnpm -r exec tsc --noEmit` works on every
package's `tsconfig.json`, including a hypothetical
`tsconfig.types-only.json`) without invoking the full `build` script.

OCH applied the pattern to: `ci.yml` typecheck + test, `release.yml`
build + publish-dry-run, `och-self-scan.yml` build. `pages.yml` is the
sole owner of the docs build.

## The local-tooling corollary: `mise run check` must mirror the CI filter

(Added 2026-05-30, session-bba601 full-repo sweep.) The original fix only
touched `.github/workflows/*`. The `mise.toml` `build` / `test` /
`typecheck` tasks kept plain `pnpm -r <cmd>` — so `mise run check` (the
documented local gate, and what `CONTRIBUTING.md` tells contributors to
run) was RED on any machine without Playwright's Chromium cached, while CI
was green. The lesson's own line "the docs build worked LOCALLY (dev had
Chromium cached)" is the trap: a *fresh* clone, a CI-like container, or a
new contributor's laptop has no cached browser, so local check silently
diverges from the merge gate. A gate that only passes on the original
author's warm machine is not a gate.

Fix: apply the identical `--filter '!@opencodehub/docs'` exclusion to the
`mise.toml` `build`, `test`, and `typecheck` tasks, and add a dedicated
`docs:build` task that runs `playwright install chromium` first so the
docs site stays buildable locally on demand:

```toml
[tasks."docs:build"]
depends = ["install"]
run = """
pnpm --filter @opencodehub/docs exec playwright install chromium
pnpm --filter @opencodehub/docs build
"""
```

**Rule:** whenever you add a heavy-package exclusion to CI, grep the repo's
task runner (`mise.toml`, `Makefile`, `package.json` scripts, `justfile`)
for the un-excluded `-r` form in the SAME change. CI fidelity is only real
if the local one-command gate runs the same filter. See also
[[parallel-act-subagents-with-shared-git-tree]] for the stale-`dist` /
clean-rebuild discipline that surfaced alongside this during the sweep.
