---
name: release-published events from default GITHUB_TOKEN do not fire downstream workflows
description: A workflow listening on `release: [published]` will not run automatically when release-please-action creates the release with the default GITHUB_TOKEN — inline the asset-attach in release-please.yml instead, gated on `steps.release.outputs.release_created`
type: knowledge
tags: [github-actions, release-please, release-published, github-token, sbom, code-pack, ci]
session: session-85faf1
ac: AC-D-4
related:
  - npm-trusted-publisher-matches-entry-workflow-not-reusable
  - workflow-call-permissions-ceiling
  - release-please-single-root-package-cannot-release
---

## Context

Track D's AC-D-4 needed to attach a `codehub code-pack` artifact to every GitHub release. The spec offered two options: (a) extend `release-please.yml`, or (b) ship a separate `code-pack-release.yml` listening on `release: [published]`. Existing `sbom.yml` already uses option (b). Option (b) seemed cleaner — workflow-per-concern.

Research surfaced a critical GitHub Actions safety rule documented in both the release-please-action README and the GitHub Actions docs:

> When you use the repository's `GITHUB_TOKEN` to perform tasks, events triggered by the `GITHUB_TOKEN` will not create a new workflow run.

Implication: when `googleapis/release-please-action@v5` runs with the default `GITHUB_TOKEN` (which it does by default — no PAT configured) and creates a release, that release's `published` event does NOT fire any other workflow. The downstream workflow only runs on:

- a manual UI publish,
- `workflow_dispatch:`, or
- `gh release create` invoked by a real user / PAT-authenticated automation.

This means option (b) silently never runs in normal automated releases. The sbom.yml in this repo was working only by accident — every published release was a manual `workflow_dispatch:` or UI-triggered run, never the natural release-please flow.

## Lesson

When attaching artifacts to a release that release-please publishes:

1. **Inline the asset-attach steps in `release-please.yml`**, gated on `steps.release.outputs.release_created`. This is the pattern the upstream release-please-action README recommends. Example:

   ```yaml
   - uses: googleapis/release-please-action@v5
     id: release
     with: {...}

   - if: ${{ steps.release.outputs.release_created }}
     uses: actions/checkout@v6
     with: { fetch-depth: 0 }

   - if: ${{ steps.release.outputs.release_created }}
     run: <build artifact>

   - if: ${{ steps.release.outputs.release_created }}
     env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
     run: gh release upload "${{ steps.release.outputs.tag_name }}" artifact.tar.gz --clobber
   ```

2. **The alternative is a `repo`-scoped Personal Access Token** (`RELEASE_PLEASE_PAT`) passed to `release-please-action`. The PR open / release create runs under the PAT's identity, and the resulting `release: published` event then fires downstream workflows. This adds secret-management cost but lets you keep one workflow per concern.

3. **Audit existing `release: [published]` workflows in any repo using release-please-action with default GITHUB_TOKEN.** They are silent no-ops in the natural release flow. In this repo, `sbom.yml` is one such workflow and is flagged for a follow-on PR.

## Why this matters

The bug is silent — every release looks fine until someone notices the release page is missing the artifact. The first symptom is usually a customer asking "where's the SBOM?" months after the release. Detection costs more than the fix.

For Track D, inlining was a one-step pattern shift; the alternative would have been a release that ships `release-please-action` updates with a code-pack artifact attached IF AND ONLY IF the release was triggered manually — exactly the failure mode I was being paid to prevent.

## Carry-forward

- Migrate `sbom.yml` to the same inline pattern (1-line workflow change). Out of scope for Track D; flagged as adjacent debt in the PR.
- When future tracks add new release artifacts, default to the inline pattern.

## References

- Research artifact: `.erpaval/sessions/session-85faf1/research-track-d.md§7`
- Implementation: PR #75 commit `1ab82a6` (`.github/workflows/release-please.yml`)
- GitHub docs: <https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow>
