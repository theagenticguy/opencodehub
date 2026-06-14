---
name: npm-trusted-publisher-matches-entry-workflow-not-reusable
description: npm OIDC trusted publishing matches the "Workflow filename" against the ENTRY workflow that initiated the run, NOT the reusable workflow where `npm publish` actually executes. If release.yml is invoked via `workflow_call` from release-please.yml, you must register release-please.yml as the trusted publisher — registering release.yml silently 404s the OIDC token exchange and falls back to an unauthenticated (failing) publish.
metadata:
  type: convention
  category: conventions
tags: [release, npm, oidc, trusted-publishing, github-actions, workflow-call, provenance]
discovered: 2026-05-28
session: session-88b46e
related:
  - release-published-event-needs-pat-or-inline
  - vendored-artifact-bump-must-revendor-in-same-pr
  - release-please-single-root-package-cannot-release
  - workflow-call-permissions-ceiling
---

# npm trusted publisher matches the ENTRY workflow, not the reusable one

## The symptom

npm publish via OIDC trusted publishing fails with:

```
WARN Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE: Failed token exchange request ... (status code 404)
📦 @opencodehub/scanners@0.2.0 → https://registry.npmjs.org/
ERR E404 404 Not Found - PUT https://registry.npmjs.org/@opencodehub%2fscanners - Not found
```

The 404 on the **token exchange** is the tell: the OIDC claim npm received didn't match any configured trusted publisher, so pnpm got no token, fell back to an unauthenticated publish, and the `PUT` 404'd.

## Root cause

npm matches the trusted-publisher "Workflow filename" against the **workflow that initiated the run** (`workflow_ref` / the entry workflow), NOT the workflow that contains the `npm publish` command. npm's own docs call this out: *"Some workflows use `workflow_call` to invoke other workflows that run `npm publish`... validation checks the calling workflow's name instead of the workflow that actually contains the publish command."*

This repo's release flow is:

```
push:main → release-please.yml   (ENTRY workflow — what npm sees in the OIDC claim)
              └─ uses: ./.github/workflows/release.yml   (workflow_call → reusable)
                    └─ npm-publish job runs `pnpm -r publish --provenance`
```

So the OIDC claim carries `release-please.yml`. The trusted publisher was registered for `release.yml` (where publish *runs*) → no match → 404.

## Why it was invisible

The ONLY release.yml runs that ever published successfully were `workflow_dispatch` (manual) — because a manual dispatch makes `release.yml` itself the entry workflow, which matched the registration. Every automated `push → release-please → workflow_call` run silently failed to publish. Result: npm sat on `@opencodehub/cli@0.4.0` while the repo had long since tagged 0.5.x. Check this whenever "the tags exist but npm is behind."

## The fix

Register the **entry** workflow as the trusted publisher filename:

```
npm package → Settings → Trusted Publisher → Workflow filename:
  release.yml   ✗  (where publish runs)
  release-please.yml   ✓  (what triggers the run)
```

Also required (npm enforces it): `id-token: write` on BOTH the parent job (the `release` job in release-please.yml that does `uses: ./.github/workflows/release.yml`) AND the child (the npm-publish job in release.yml). This repo already had both.

## Operational pain to plan for

- Trusted-publisher config is **web-UI only**, no API/CLI, and **passkey/2FA-gated per save**. With N packages it's N manual saves. This monorepo has **17 publishable packages** (`packages/*` minus `docs`, which is `private: true`), so it's 17 saves. Do them back-to-back to ride the authenticator's warm-credential window.
- **Each package has exactly one trusted publisher** — no org-level or account-level setting applies to all at once. Changing the filename means re-saving all 17.
- Tradeoff: registering `release-please.yml` means a manual `workflow_dispatch` of `release.yml` (entry = release.yml) will STOP matching. The automated flow is the one that matters, so that's the right trade; treat manual dispatch as admin-only.
- **Corollary discovered 2026-06-11 (the no-recovery-path trap):** registering ONLY `release-please.yml` means there is **no working manual recovery** when the automated chain fails to publish. If release-please's `release_created` comes back false (e.g. it aborts with "untagged, merged release PRs outstanding" after a tag-scheme change), you cannot rescue the release by `gh release create` (entry = release.yml → `release: published` → OIDC 404) NOR by `workflow_dispatch` of release.yml (entry = release.yml → 404). Both manual paths carry `release.yml` as the entry and fail the trusted-publisher match. The fix: **register BOTH `release-please.yml` AND `release.yml`** as trusted publishers for the package. After collapse this is only ONE package (`@opencodehub/cli`), so it's 2 saves total — cheap insurance that makes `workflow_dispatch`-based recovery work. Symptom that you're in this trap: tag + GitHub Release exist for the version, but `npm view <pkg> version` is behind and every manual republish 404s on the OIDC token exchange.

## Why not just add a PAT instead?

A `RELEASE_PLEASE_PAT` would let release-please cut a release that fires `release: published`, making `release.yml` the entry workflow (matching the old registration). But that reintroduces a long-lived token this repo deliberately removed (see [[release-published-event-needs-pat-or-inline]] — the `workflow_call` design exists precisely to avoid the PAT). For an OIDC-only, Sigstore + SLSA-L3 repo, fixing the npm registration is the hardening-preserving choice; the PAT is a regression.

## Linked

- [[release-published-event-needs-pat-or-inline]] — the sibling decision: why the flow uses `workflow_call` (no PAT) in the first place. THIS lesson is the npm-side consequence of that choice.
- npm docs: https://docs.npmjs.com/trusted-publishers
- Session 2026-05-28: diagnosed during the v0.6.2 → v0.6.3 release recovery.
