---
title: Resolve milestone-old spec drifts inline with the implementing commit, not as a separate fix
tags: [spec-discipline, drift-resolution, commit-hygiene, ears]
session: session-e1d819
---

## Context

Spec 005 was authored before Wave 1 commits ratified its M5/M6 surface.
By the time Wave 2 started, four drifts existed (explore-delta.yaml
`drifts.drift_1..4`):

- drift_1: spec named `chonkie-ts@^0.3.0`; impl had `chonkie@^0.3.0`
  (and ultimately `@chonkiejs/core@^0.0.9` was correct)
- drift_2: spec called for `IGraphStore.listNodes()`; method didn't exist
- drift_3: spec said "extend AGENTS.md with `choices[]`"; that already shipped
- drift_4: spec said "reuse license_audit MCP logic"; that path cycled

All four were resolved at Gate 0 by amending the spec wording inline as
part of the commit that implemented the fix (e.g., 77f37c3 amended
AC-M5-1 wording while switching the chonkie package; 9d8d570 amended
AC-M5-5 wording while lifting `classifyDependencies`).

## Lesson

When a spec drift is ≥ 1 milestone old and the implementation has already
committed to a different reality, **amend the spec inline as part of the
implementing commit**. Do not separate spec-fix from implementation:

1. Catch drifts during the explore-delta pass (or Gate 0 of the next
   wave). List them with `where / what / reason / action_options /
   recommend` keys in `explore-delta.yaml` so the orchestrator confirms
   the resolution before Plan.
2. The implementing commit message body cites the spec line being
   amended ("Amends spec 005 AC-M5-5: reads `chonkie` → `@chonkiejs/core`").
3. The diff includes both the code change AND the spec edit. Reviewers
   see the drift resolved and ratified in one atomic step.
4. Never carry an open drift across milestones. Either accept-and-amend
   or revert-to-spec — the only forbidden state is "spec says X, code
   does Y, no decision recorded".

## Why

Separate "spec-fix" commits decouple from the reasoning that justified
the change; future readers see a spec edit with no obvious driver.
Inline amendment ratifies the drift at the point of decision, keeps the
spec executable, and prevents Plan from re-litigating settled choices.
The four-drift batch in this session resolved cleanly because every
drift had an `action_options` block with a `recommend`, so Gate 0 was
a four-line confirmation rather than a fresh design discussion.
