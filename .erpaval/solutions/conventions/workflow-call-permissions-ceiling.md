---
title: "GitHub Actions: top-level permissions cap every job's permissions, including workflow_call'd ones"
tags:
  - github-actions
  - permissions
  - workflow_call
  - oidc
  - npm
  - trusted-publishing
  - id-token
modules:
  - .github/workflows/release-please.yml
  - .github/workflows/release.yml
severity: high
created: 2026-05-15
session: session-569b82
track: bug
category: conventions
---

# GitHub Actions: top-level `permissions:` is a hard ceiling

## Symptom

`release.yml`'s `npm-publish` job declared `id-token: write` at the job
level. Trusted publisher relationships were configured correctly on
npmjs.com for all 17 packages. Yet every release attempt failed with:

```
Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE: Failed token exchange request
with body message: Unknown error (status code 404)
```

The run log's permissions block showed:
```
GITHUB_TOKEN Permissions
  Contents: read
  Metadata: read
```

Note: `id-token: write` missing from the actual granted set despite being
declared in the YAML.

## Root cause

GitHub Actions evaluates permissions as a hierarchy:

1. The **top-level** `permissions:` block in the workflow file is a
   **ceiling** — every job's permissions are a subset of this set.
2. A job's `permissions:` block can only narrow what's already in the
   top-level set; it cannot grant permissions the top level didn't grant.

`release-please.yml` had:
```yaml
permissions:
  contents: read   # top-level ceiling = read-only on contents
```

Then declared on the `release` job that fans out to `release.yml`:
```yaml
release:
  permissions:
    contents: write
    id-token: write
    actions: read
    security-events: write
  uses: ./.github/workflows/release.yml
```

The job's declarations are **silently ignored** for any permission not
already in the top-level set. The runner grants only the intersection —
which for `id-token` is empty, so OIDC token exchange fails.

This affects `workflow_call` calls too: the called workflow's permissions
inherit from the calling workflow's top-level ceiling, not the called
workflow's own top-level ceiling.

## Fix

Set the top-level `permissions:` block to be the **union** of every
permission any job (including transitively-called ones) needs. Each job
then narrows to its own least-privilege subset.

```yaml
# Top-level: the ceiling — must include every permission used by ANY job,
# including workflows called via `uses: ./.github/workflows/X.yml`.
permissions:
  contents: write
  id-token: write
  pull-requests: write
  actions: read
  security-events: write

jobs:
  release-please:
    permissions:
      contents: write
      pull-requests: write
    # ...
  release:
    permissions:
      contents: write
      id-token: write
      actions: read
      security-events: write
    uses: ./.github/workflows/release.yml
```

Scorecard's Token-Permissions check still passes: each per-job block is
least-privilege within the ceiling, which is what the check actually
verifies.

## How to apply

When you see "OIDC token exchange failed 404" or "id-token permission
not granted" with the YAML clearly declaring `id-token: write`, check:

1. The TOP-LEVEL `permissions:` block at the workflow's root.
2. If there's a calling workflow (workflow_call), check its top-level too.
3. If either is missing the required permission, add it. The ceiling is
   the union; per-job blocks narrow.

## Why this matters

Easy to miss because the YAML LOOKS correct. The job-level declaration
matches docs and intuition. The error message is at the npm-side
(`status code 404`), not "permission denied", which sends you down a
trusted-publisher-misconfiguration rabbit hole. The actual root cause is
upstream of the call site, in the calling workflow's ceiling.

Diagnostic: read the FIRST few lines of the failing job's log — the
"GITHUB_TOKEN Permissions" group lists exactly what was granted. If your
expected permission isn't listed, the ceiling is the culprit.

## Related

- Scorecard Token-Permissions check rationale:
  https://github.com/ossf/scorecard/blob/main/docs/checks.md#token-permissions
- GitHub Actions reusable-workflow permissions docs:
  https://docs.github.com/en/actions/sharing-automations/reusing-workflows#access-and-permissions

## Related lessons

- [[release-published-event-needs-pat-or-inline]] — the OTHER permission
  issue release.yml had: `release: published` events don't fire downstream
  workflows when triggered by the default GITHUB_TOKEN. The `workflow_call`
  pattern works around it; this lesson is about the permissions caveat
  introduced by that workaround.
