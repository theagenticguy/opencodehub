---
title: Parallel Act subagents on a shared git tree — interleaving + cherry-pick discipline
tags: [erpaval, act-phase, worktrees, subagents, parallelism, cherry-pick]
session: session-33f24f
---

## Context

Track A of v1-finalize ran 13 ACs. Most ACs spawned a dedicated Act
subagent on an isolated worktree (`isolation: worktree`). Two recurring
behaviors emerged:

1. **Worktrees that branched off `main` instead of `feat/v1-finalize-track-a`.**
   Several agents reported "fast-forwarded to feat/v1-finalize-track-a
   before starting" — the worktree harness defaults the new branch off
   the orchestrator's CURRENT HEAD, but if the orchestrator hasn't
   pushed track-a, the harness picked up `origin/main` instead. Fix:
   the agent's first action is `pwd && git rev-parse --show-toplevel
   && git log --oneline -10` to verify expected commits are in the
   chain. If missing, `git fetch && git merge --ff-only feat/v1-finalize-track-a`.
   Document in the packet's Work log.

2. **Worktree commits landing on the parent branch directly.** Several
   agents committed to the worktree's local branch but their changes
   appeared on `feat/v1-finalize-track-a` because the git dir is shared
   across worktrees. The orchestrator's cherry-pick became a no-op
   (commit already in branch); next cherry-pick of a NEW commit worked
   normally. Net effect: orchestrator must verify branch state before
   AND after each agent completion, not assume cherry-pick is required.

3. **Concurrent worktrees on overlapping packages.** Two agents both
   editing `packages/storage/` produced merge friction even when their
   files didn't overlap because lefthook + biome lock root state. Fix:
   spawn parallel agents on NON-OVERLAPPING package boundaries.
   `mcp/` parallel with `storage/` is fine; `mcp/` parallel with
   `analysis/` is fine; two agents on `storage/` is not.

4. **Stale dist + test reports.** `pnpm -r test` runs `node --test
   ./dist/**/*.test.js`. Type-only changes update `.ts` but leave
   `.js` stale. After every interface-touching commit, rebuild
   (`pnpm -r build`) before trusting test counts. Several agents
   reported phantom failure counts that resolved on rebuild.

## Lesson

For ERPAVal Act phase with parallel subagents on a shared git tree:

1. **Each Act subagent's first action is to verify branch state.**
   Document `git log --oneline -10` in the Work log. If branched off
   `main` instead of the feature branch, fast-forward before editing.

2. **Spawn parallel agents on non-overlapping package boundaries.**
   Worktree isolation does NOT prevent biome / lefthook root-config
   conflicts. Don't spawn 2+ agents on the same package.

3. **The orchestrator's cherry-pick may be a no-op.** Verify branch
   HEAD post-completion via `git log --oneline -3 HEAD`. If the agent's
   reported SHA is already at HEAD, the cherry-pick is redundant — log
   it and move on.

4. **Rebuild before trusting test counts after interface changes.**
   `pnpm -r build && pnpm -r test`. Stale `dist/` produces phantom
   failures.

5. **Watch the test-fixup tail.** When production migrates to a new
   interface (e.g. typed finders), per-test FakeStore mocks need
   migration too. The packet that does the production migration should
   either (a) hoist a shared fake to `<pkg>/src/test-utils.ts` or
   (b) explicitly defer test-fixup as a follow-on packet. Don't let
   it slip silently — the rebuild surfaces 50+ failing tests at once.

## Why this matters

Track A landed 25 commits across 13 ACs in one session via parallel
subagents. The patterns above are what kept the hash-parity invariant
green per-commit and prevented two-week debug sessions on phantom
failures. Future multi-AC tracks (Track C debt sweep, Track D dogfood
polish) inherit these.

## Example

- `feat/v1-finalize-track-a` HEAD `894d477` — 25 commits, all green.
- Two agents on storage/ in parallel produced the AC-A-3 / AC-A-7
  sequencing fix that landed cleanly.
- Mass mcp test-fixup (`a2718d4f4bf486a57`) was a deferred follow-on
  packet because AC-A-6c's per-AC scope didn't include the 17-file
  test mass migration. Right call — the deferred packet had a clean
  scope and landed in one commit (`d67f115`).
- Phantom 79-failure count appeared on first AC-A-6c rebuild;
  resolved on full repo `pnpm -r build`.
