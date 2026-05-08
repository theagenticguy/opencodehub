---
title: Worktree isolation — pin pwd at task start and exclude worktrees from biome v2
tags: [worktrees, biome, lefthook, ci, agent-isolation]
session: session-e1d819
---

## Context

Two distinct worktree pitfalls hit M5 Wave 2:

1. T-W2-3 was provisioned as `isolation: worktree` but the agent edited
   files in the main repo before catching that its worktree base was at
   `ed3950f` (M3/M4) instead of `feat/v1-m5-m6` HEAD `86e295b`. Recovery
   required `git stash` + `git stash pop`.
2. Validation `mise run check` failed at the `lint` step because biome v2
   recursively traversed `.claude/worktrees/agent-*/biome.json` files and
   detected 10 nested `"root": true` configs — even though the worktrees
   are gitignored. Scoped lint (`pnpm exec biome check packages/`) exits 0.

## Lesson

**At every worktree task start, byte-pin location and base SHA**:

```bash
pwd                                         # confirm worktree path, not main
git rev-parse --show-toplevel               # toplevel matches pwd
git rev-parse HEAD                          # matches expected base SHA
git status                                  # confirm clean tree
```

If any of these mismatch the task packet's expected state, halt and
re-provision. Editing in the wrong tree wastes the isolation guarantee.

**Biome v2 traverses gitignored worktrees by default.** `gitignore`
alone is **not** sufficient. Two viable fixes:

- (a) Scope CI/lefthook biome invocations to tracked source paths:
  `pnpm exec biome check packages/ scripts/` (not bare `.`). This is
  the workaround used in this session.
- (b) Add an explicit exclusion in `biome.json`:
  `"files": { "experimentalScannerIgnores": ["**/.claude/worktrees/**"] }`.
  This is the durable fix; ship it the next time `biome.json` is touched.

Inside a worktree, prefer `git -C <worktree>` for git ops over `cd
<worktree> && git ...` — the harness's per-bash-call cwd reset makes
`-C` the only reliable form across multi-step sequences.

## Why

Worktrees buy you parallel-agent isolation only if the agent actually
operates inside its own tree. A wrong-pwd edit breaks the cherry-pick
contract and pollutes the main branch with WIP. Pinning pwd takes 4
bash calls and costs nothing.

Biome v2's "scan everything" default treats `.claude/worktrees/` as
ordinary source. The gitignore-is-enough assumption (true for git, npm,
pnpm) does not extend to biome v2. Either scope the invocation or add
the explicit exclusion — but document the choice so the next contributor
with sibling worktrees doesn't burn an hour on a phantom CI failure.
