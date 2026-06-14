---
name: release-please-single-root-package-cannot-release
description: release-please v17 CANNOT create a release for a single root package with a scoped package-name. `this.component = options.component || normalizeComponent(packageName)` falsy-coerces `component:""`, derives `cli` from `@opencodehub/cli`, and buildRelease's standalone-component check then rejects the component-less release PR (`PR component: undefined does not match configured component: cli`) → release_created=false → npm never publishes. For "one published CLI that bundles N private libs," keep TWO components (root + cli) and use the linked-versions plugin so cli bumps with root on every commit.
metadata:
  type: convention
  category: conventions
tags: [release-please, monorepo, linked-versions, component, npm, publish, single-package, buildRelease]
discovered: 2026-06-11
session: session-f12592
related:
  - tsup-collapse-monorepo-to-single-cli
  - npm-trusted-publisher-matches-entry-workflow-not-reusable
  - release-published-event-needs-pat-or-inline
  - workflow-call-permissions-ceiling
---

# release-please: a single root package with a scoped name cannot create a release

## Symptom

Published npm package stuck at an old version even though tags/commits advance.
release-please run logs, in the "Building releases" phase:

```
✔ Building release for path: .
⚠ PR component: undefined does not match configured component: cli
```

Result: zero candidate releases built, nothing tagged, `release_created=false`,
the `workflow_call` to release.yml never fires, npm never publishes. Downstream
you also see `⚠ There are untagged, merged release PRs outstanding - aborting`
— that is a SYMPTOM (createPullRequests refusing to open a new PR while a merged
`autorelease: pending` PR exists), not the cause.

## Root cause (release-please v17.6.0 source)

`src/strategies/base.ts`: `this.component = options.component || this.normalizeComponent(this.packageName)`.
The `||` (not `??`) **falsy-coerces `component: ""`** away, so a scoped
`package-name: "@opencodehub/cli"` derives component `cli` (Node strategy's
`normalizeComponent` strips the `@scope/`). Then `buildRelease`'s standalone
check (fires only when the PR has a SINGLE release entry) compares the release
PR's branch component (`undefined` — branch `release-please--branches--main`
carries no `--components--` segment) against the derived `cli`. `"" !== "cli"` →
warn + `return` → zero releases.

`include-component-in-tag: false` does NOT help: it only governs TAG naming
(`getComponent`), not the matcher, which uses `getBranchComponent` (ignores that
flag). So you cannot get (clean `vX.Y.Z` tag) + (component-less PR) + (passing
matcher) simultaneously for a single scoped root package. `component: ""` is
provably impossible via the `||`.

## Fix — keep TWO components + linked-versions

With 2 components the aggregate release PR has `releaseData.length === 2`, so the
broken single-entry standalone-component check is SKIPPED entirely. This is why
the 2-component scheme released reliably for 20+ versions and the single-component
collapse broke it.

```jsonc
"packages": {
  ".":            { "package-name": "opencodehub",        "component": "root" },
  "packages/cli": { "package-name": "@opencodehub/cli",   "component": "cli"  }
},
"plugins": [
  { "type": "linked-versions", "groupName": "opencodehub", "components": ["root", "cli"] }
]
```

`linked-versions` solves the ORIGINAL starvation bug (root `.` receives every
commit so it always bumps; the published cli only saw `packages/cli/**` and
starved): it syncs all listed components to the highest version, so any commit
that bumps root bumps cli in lockstep → cli publishes on every release.

## Migration mechanics that bit us

- Manifest must list BOTH components at versions whose **component-format tags
  exist** (`root-v0.8.5`, `cli-v0.7.4`) — release-please uses the manifest for the
  current version but needs a matching tag for the SHA boundary. Seeding a
  version with no matching tag → "No latest release found" → giant-changelog risk.
- linked-versions syncs to the HIGHEST member, so root 0.8.5 + cli 0.7.4 → both
  next bump to 0.8.6. The published cli jumps 0.7.4 → 0.8.6 (forward, npm-valid).
  Accept the number jump; boundary-safety (both tags exist) beats a pretty number.
- Do NOT bootstrap a new tag scheme by hand-creating `vX.Y.Z` tags + GitHub
  Releases: release-please's manual-vs-owned-release reconciliation is fragile,
  AND a `gh release`/`workflow_dispatch` recovery makes `release.yml` the OIDC
  entry workflow → fails the trusted-publisher match (registered for
  `release-please.yml`). See [[npm-trusted-publisher-matches-entry-workflow-not-reusable]].
  Only the automated `release-please.yml → workflow_call → release.yml` chain
  publishes. Recovery must go through that chain.

## Verified

After restoring 2 components + linked-versions: release PR bumped BOTH to 0.8.6,
merge → `release_created=true`, tags `root-v0.8.6`+`cli-v0.8.6`, automated chain
ran `npm publish (OIDC + provenance) => success`, `npm view @opencodehub/cli
version` → 0.8.6 (was stuck at 0.7.4). Confirmed via cache-busted
`npx @opencodehub/cli@latest --version`.
