---
name: "In a parallel multi-package remediation, the gate fails on build-system artifacts, not the fixes"
description: When N agents each fix their own package in parallel on a shared tree and every agent self-reports green, the orchestrator's whole-repo gate still fails — but the failures cluster in build infrastructure (stale dist, biome nested-config in worktrees, local-vs-CI task divergence, a flaky newly-added test), not in the package fixes. Budget orchestrator time for an integration-debugging tail and gate from a clean rebuild.
type: best-practices
---

The 2026-05-30 sweep ran 16 package agents in parallel to fix 44 confirmed
findings (one packet per package, exclusive file ownership). Every agent
self-reported its own package building + testing green. The orchestrator's
whole-repo `mise run check` then failed FOUR times in a row — and not once
on a package's actual fix. The failures were all integration/build-system
artifacts:

1. **Biome v2 nested-config collision.** Locked git worktrees for OTHER
   branches under `.claude/worktrees/*` each carry a root `biome.json`;
   `biome check .` walks into them and dies on "nested root configuration."
   Pre-existing (the BASELINE check failed for this too) but invisible until
   a whole-repo lint ran. Fix: `vcs.useIgnoreFile: true` + a negated include
   `"!!**/.claude/worktrees"` (NOT the deprecated `experimentalScannerIgnores`,
   which runs after config discovery and so doesn't prevent the collision).
   See [[worktree-isolation-pwd-pin-and-biome-exclusion]].

2. **Local gate diverged from CI.** `mise.toml` used plain `pnpm -r build`
   while CI used `pnpm --filter '!@opencodehub/docs' -r build` (the heavy
   Playwright/Chromium docs package). So `mise run check` was red on any
   machine without a cached browser. See the local-corollary section of
   [[exclude-heavy-build-from-pnpm-recursive]].

3. **Stale `dist` + phantom test counts.** Agents edited source and ran
   their own incremental builds; the gate's `tsc -b` + mise `sources/outputs`
   caching produced a `dist` that disagreed with source. A test that passed
   in isolation failed in the gate (and vice versa). Only a clean
   `pnpm -r run clean && build` gave a deterministic answer. See
   [[parallel-act-subagents-with-shared-git-tree]].

4. **A newly-added test was flaky.** An agent's own new SIGKILL-escalation
   test raced (see [[kill-escalation-races-the-exit-handler]]). Self-reported
   green because the agent ran it once on warm dist; failed under the gate's
   ordering. Flaky tests need REPEAT-RUN confirmation (3×), not one green.

## Why this happens

Each agent's world is its own package on a warm, already-built tree. Three
classes of truth live OUTSIDE any single package's view and so no agent can
see them: (a) cross-package build ordering and dist freshness, (b)
repo-root tooling config (biome, mise, tsconfig references), (c)
whole-repo-only checks (lint `.`, the negated-filter gate). A green
self-report is necessary but not sufficient.

## How to apply (orchestrator discipline)

- **Establish the baseline gate result BEFORE dispatching agents** and read
  it correctly — a sub-command's "exit 0" (e.g. install) is not the whole
  check's exit. The baseline here was already red; knowing that reframes
  every later failure as "pre-existing or mine?" instantly. See
  [[squash-merge-masks-pre-existing-debt]].
- **Gate from a clean rebuild**, not incremental, for the authoritative
  pass: `pnpm -r run clean` then `mise run check`. Stale dist is the single
  most common false signal.
- **Budget an integration-debugging tail.** After "all agents reported
  done," expect several gate iterations of pure build-system triage. This is
  normal, not a sign the fixes were bad.
- **Triage each gate failure to source-vs-infrastructure first.** Run the
  failing package's test in isolation: passes alone but fails in gate →
  infrastructure (stale dist / config / ordering); fails alone too → a real
  fix bug. This one question routes the fix.
- **Re-run flaky-looking tests 3×** before declaring them fixed.
- **Fix the pre-existing infra breakage too** (biome worktree, mise/CI
  divergence) rather than working around it — those were latent gate-fidelity
  bugs that would bite the next contributor.
