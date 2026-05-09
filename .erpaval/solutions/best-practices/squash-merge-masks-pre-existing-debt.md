---
name: Squash-merge can mask pre-existing repo-wide debt that per-commit gating did not surface
description: A multi-commit feature track whose per-commit `mise run check` was green can still leave the post-squash main failing because lint-rule, transitive-dep, or test-sequence interactions only manifest at the merge boundary
type: feedback
---

A long-running feature branch lands as one squash commit on main. Per-commit
`mise run check` was clean across all 26 of the branch's commits AND on the
final pre-merge HEAD. The next branch cut from main hits `mise run check` and
gets a non-zero exit on rules the previous branch never tripped.

This was observed on 2026-05-09: Track A merged via squash from
`feat/v1-finalize-track-a` (commit 81f9855). Track B cut a fresh branch from
that main, ran `mise run check`, and immediately failed on 6 biome v2 lint
errors (`noNonNullAssertion` in `derive.test.ts`, `noConsole` +
`noTemplateCurlyInString` in `sagemaker-embedder.parity.test.ts`) plus 3
"unused suppression" warnings on stale `biome-ignore lint/correctness/useYield`
comments. None of these errors were in Track A's diff; all of them existed on
main before Track A landed.

**Why it happens:**

1. **Lint rule activation is not deterministic across rebuilds.** Track A
   bumped a transitive dep that pulled in newer biome rules (or relaxed a
   `useYield` rule that retroactively flagged old suppressions as unused).
   Per-commit gating inside Track A had the *old* rule set during early
   commits and the *new* rule set during late commits — but each individual
   commit's check ran against its own rule set, so each was self-consistent.
   The post-squash main has the LATEST rule set against the WHOLE tree,
   exposing lint debt that no individual commit owned.
2. **Test-sequence interactions across packages.** A new polyglot scanner
   (detect-secrets) triggered cli `selectScanners` test failures because
   `selectScanners` consumed `ALL_SPECS` whose order changed. Catalog tests
   in `packages/scanners/` updated their assertions; cli tests did not, and
   the cross-package coupling was invisible inside Track B's package-level
   diff.
3. **Squash commit messages drop the bisect granularity** that would have
   localised the rule-set change to a specific commit.

**Why:** v1.0 finalize ships as four sequential PRs (A → C → B → D per
`pr-split-analysis.md`). Each branch cuts from the prior squash. If each
branch only validates its own diff, debt accumulates across the merge
boundary and the team loses the per-commit U1/U6 invariant guarantee at the
PR-graph level even though it holds inside each PR.

**How to apply:**

- **First action on a fresh branch from main**: run `mise run check` BEFORE
  starting work, not at the end. If it fails, fix it in commit 1 of the new
  branch with a clear "main-debt sweep" message; mention which prior PR's
  squash exposed it.
- When deleting a `biome-ignore` comment that biome v2 reports as "unused
  suppression", verify the underlying rule actually no longer fires (run the
  empty-pattern code through biome locally) — don't just delete the
  suppression and hope.
- When adding a new polyglot P1 catalog entry that flows through
  `ALL_SPECS`, search every test file (not just `*/catalog.test.ts`) that
  asserts a specific scanner-id list — `cli/src/commands/scan.test.ts`'s
  `selectScanners` is the recurrent miss.
- For the next finalize PR (Track C, Track D), expect the same pattern:
  cut from the prior squash, immediately run `mise run check`, sweep first.
- The compound version of this rule belongs upstream of ERPAVal: a `mise`
  task `mise run check:branch-start` could codify the sweep so it isn't
  optional.
