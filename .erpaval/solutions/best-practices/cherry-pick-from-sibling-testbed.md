---
name: Cherry-pick verified bug fixes from a sibling testbed clone
description: When a sibling/post-filter checkout has authored fix commits with file:line repro coordinates, fetch the sibling and cherry-pick directly — no need to re-author or re-test on upstream
type: best-practices
---

When you maintain a "post-filter testbed" sibling repo for smoke / dogfood
campaigns and you've already authored fix commits there with verified
repros, do not re-write the fixes on upstream. Fetch the sibling as a
local remote and cherry-pick.

**Why:** The fix has already been authored, repro'd, verified. Re-authoring
on upstream loses authorship metadata, doubles review surface, and
introduces drift between what was fixed and what landed. Re-testing
re-validates the same green path. The cherry-pick is provably equivalent
when the file:line coordinates in the fix message match upstream HEAD.

**How to apply:**

1. **Verify file:line parity first.** Each fix in the testbed report
   should cite file paths and line numbers; quickly grep upstream to
   confirm the same lines exist there. Per Bug #2 in OCH 2026-05-10
   campaign: `packages/cli/src/commands/scan.ts:162-171` was identical in
   testbed and upstream — direct cherry-pick worked.
2. **Fetch the sibling as a path remote.** No need to register it
   permanently. One-shot:
   ```bash
   git fetch /efs/lalsaado/workplace/opencodehub.post-filter --no-tags
   ```
   `FETCH_HEAD` now points at the sibling's HEAD; commits referenced by
   short-hash become resolvable.
3. **Cherry-pick in severity order.** HIGH first, MEDIUM next, LOW last.
   Each pick is one commit; do not squash them into a "umbrella fix"
   commit — preserves blame and lets the PR reviewer see one
   self-contained fix per scope.
4. **Re-verify after each pick** with the package-scoped check:
   `pnpm -F @opencodehub/<pkg> test` plus any smoke script the fix
   targets (`bash scripts/smoke-mcp.sh`, `node ... doctor`, etc.).
5. **Prefer one PR for the bundle** when the fixes are small and
   thematically related (a "v1 upstream bug sweep") — reviewer context
   stays coherent. Split only if the bundle exceeds reviewability.

Anti-pattern: re-authoring the fix on upstream and citing the testbed
commit in the body. That loses the original commit's authorship and
makes blame point at the re-author for code that was thought-through
elsewhere. If you need to adapt the fix to upstream divergence, do that
as a follow-up commit on top of the cherry-pick, not a rewrite.

Related: this pairs naturally with the durable lesson "Squash-merge
masks pre-existing repo-wide debt" — run `mise run check` on upstream
BEFORE the cherry-pick to baseline-clean, so any test regression after
the pick is unambiguously attributable to the picked fix.
