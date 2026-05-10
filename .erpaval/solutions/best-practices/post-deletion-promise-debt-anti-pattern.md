---
name: "Post-deletion-promise debt: deleting an asset with a promise to spin it up elsewhere creates load-bearing orphans"
description: When a milestone-PR deletes an in-tree asset (docs site, package, fixture) with the explicit intent to recreate it elsewhere, the recreation almost never happens. The deleted asset's last build keeps serving and silently rots.
type: best-practices
---

OCH PR #53 (commit `4431b53`) deleted `packages/docs/` Starlight site
under T-M2-3 with the body line:

> `packages/docs` removed from monorepo (moved to separate repo;
> `docs/adr/` at root stays)

`theagenticguy/opencodehub-docs` was never created. Six milestones
shipped without docs coverage. The site at
`https://theagenticguy.github.io/opencodehub/` was still serving the
May 1 build — Pages does not auto-tear-down when its feeding workflow
is removed; the last successful deploy keeps serving until something
overwrites it. End users hitting the old URL got six-week-old prose
("28 tools", "DuckDB-default", "Node 20+"). Caching at search engines
amplified the problem.

**Why:** PR deletion of an asset feels like cleanup; the user perceives
"that's done." The "we'll recreate in a separate repo" promise lives
in the PR body, which gets archived, never re-encountered. The
recreation is an unscheduled task with no owner. The deleted-but-still-
serving artifact is invisible in the working tree — `git log` shows
the deletion is final, but the URL is alive.

**How to apply:**

- **If you're going to move an asset out, make the recreation a
  blocking task on the same PR or its immediate follow-up.** Open the
  follow-up PR (even as a draft) before merging the deletion. A
  draft-PR is harder to forget than a comment in a PR body.
- **If the asset has a public surface (URL, npm, registry listing),
  redirect or sunset it explicitly.** For Pages: the deletion PR
  should also empty the published artifact (`echo "Moved to ..." >
  index.html` or push a redirect-only build). For npm: `npm deprecate`.
  For registries: file a removal/migration ticket.
- **Add a "promised" field to the deletion PR's checklist.** "We
  promised to recreate `<thing>` at `<location>` by `<date>`." The
  date forces a follow-up.
- **For docs specifically: prefer in-monorepo over "separate repo"
  unless you have a specific reason.** A docs site that lives in
  `packages/docs/` or `apps/docs/` shares CI, lockfile, license sweep,
  Dependabot, banned-strings, and PR review with the code it documents.
  A separate repo is its own project to maintain — typically only
  worth it for white-label or cross-product docs.

When you do encounter a post-deletion-promise debt situation: restore
from `git show <deletion-commit>^ -- <path>` is the fastest path. The
working scaffold is in history; only the content needs refreshing
against current reality.

Pattern observed: 2026-05-04 deletion (PR #53) → 2026-05-10 restoration
(PR #87). Six days of silent rot. Restoration via `git checkout
4431b53^ -- packages/docs/ .github/workflows/pages.yml` recovered 56
files in under a second.
