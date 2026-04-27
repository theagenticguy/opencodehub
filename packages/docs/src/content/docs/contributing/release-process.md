---
title: Release process
description: How release-please turns your Conventional Commits into a versioned release and CHANGELOG.md.
sidebar:
  order: 40
---

OpenCodeHub releases are automated by
[release-please](https://github.com/googleapis/release-please). You do not
tag, you do not edit `CHANGELOG.md`, you do not hand-write release notes.
You write Conventional Commits on feature branches, merge them into `main`,
and a bot opens the release PR for you.

This page explains how that works, where the configuration lives, and what
you need to know when your change lands in a release.

## The pipeline

1. You merge a PR into `main`. Each commit on `main` is a Conventional
   Commit (see [Commit conventions](/opencodehub/contributing/commit-conventions/)).
2. `.github/workflows/release-please.yml` runs on every push to `main` and
   calls `googleapis/release-please-action@v4`.
3. The action reads every commit since the last release tag and decides on
   a version bump using the `changelog-sections` map in
   `.release-please-config.json`.
4. It opens (or updates) a single release PR titled
   "chore(root): release N.N.N". The PR body is the generated changelog.
5. When a maintainer merges that PR, the action cuts git tags, generates
   `CHANGELOG.md` entries, and creates a GitHub Release.

Because the repo uses `separate-pull-requests: false`, the whole monorepo
moves in a single release PR covering all versioned packages. The
`node-workspace` plugin (with `updatePeerDependencies: true`) keeps
cross-package versions and peer ranges consistent.

## Versioned vs. unversioned packages

`.release-please-config.json` declares 10 versioned packages. They each
get their own `package-name` and their own tag.

| Package                    | Tag prefix                     |
|----------------------------|--------------------------------|
| `@opencodehub/analysis`    | `@opencodehub/analysis-vN.N.N` |
| `@opencodehub/cli`         | `@opencodehub/cli-vN.N.N`      |
| `@opencodehub/core-types`  | `@opencodehub/core-types-vN.N.N` |
| `@opencodehub/embedder`    | `@opencodehub/embedder-vN.N.N` |
| `@opencodehub/ingestion`   | `@opencodehub/ingestion-vN.N.N` |
| `@opencodehub/mcp`         | `@opencodehub/mcp-vN.N.N`      |
| `@opencodehub/sarif`       | `@opencodehub/sarif-vN.N.N`    |
| `@opencodehub/scanners`    | `@opencodehub/scanners-vN.N.N` |
| `@opencodehub/search`      | `@opencodehub/search-vN.N.N`   |
| `@opencodehub/storage`     | `@opencodehub/storage-vN.N.N`  |

Plus the root component `opencodehub` tagged as `root-vN.N.N`.

Four packages are intentionally unversioned: `@opencodehub/gym`,
`@opencodehub/scip-ingest`, `@opencodehub/summarizer`, and the Python
`packages/eval` harness. They ride along with the monorepo version but do
not publish tags of their own. The gym and eval are harness code, not
product. `scip-ingest` and `summarizer` are internal dependencies with no
external consumer at v1.0 — they will start versioning once a public
contract exists.

## Changelog sections

`.release-please-config.json` controls which Conventional Commit types
show up in `CHANGELOG.md`:

| Type       | Section         | Visible? |
|------------|-----------------|----------|
| `feat`     | Features        | Yes      |
| `fix`      | Bug Fixes       | Yes      |
| `perf`     | Performance     | Yes      |
| `revert`   | Reverts         | Yes      |
| `docs`     | Documentation   | Yes      |
| `refactor` | Refactoring     | Yes      |
| `test`     | Tests           | Hidden   |
| `build`    | Build System    | Hidden   |
| `ci`       | CI              | Hidden   |
| `chore`    | Chores          | Hidden   |
| `style`    | Style           | Hidden   |

Hidden sections still land in git history and still trigger a patch bump
— they just do not appear in the release notes.

## Tags

`include-v-in-tag: true` means every tag is `vN.N.N`, not `N.N.N`. Tag
format: `<package-name>-v<semver>` (e.g. `@opencodehub/cli-v0.4.2`) plus
a root tag `root-v0.4.2`.

## Breaking changes on 0.x

While OpenCodeHub sits on `0.x.y`, a `feat!` or `BREAKING CHANGE:`
footer bumps the **minor** version, not the major. That is intentional:
the 0.x prefix signals "not yet stable" and we want the freedom to break
things without forcing a 1.0 → 2.0 stampede.

After the first 1.0.0 release, the same signals bump the major version.
See the breaking-change section in
[Commit conventions](/opencodehub/contributing/commit-conventions/#breaking-changes-on-0x).

## What you do when your PR lands

Nothing. release-please watches `main`. When you merge, the release PR
updates automatically. If your PR is a `fix` on top of a pending release
PR, the PR title and body refresh to include your fix. If yours is the
first commit since the last release, a new release PR is opened.

If you are the maintainer about to cut a release:

1. Check CI on the release PR is green.
2. Verify the changelog reads correctly — if a `feat!` is missing from
   "Features" or a `BREAKING CHANGE:` footer was not picked up, fix the
   offending commit via a follow-up commit with the right prefix rather
   than editing release-please's output.
3. Merge the release PR. Tags, `CHANGELOG.md`, and the GitHub Release
   are produced in one push.

## Related files

- `.release-please-config.json` — the config described above.
- `.release-please-manifest.json` — release-please's state file. Do not
  hand-edit.
- `.github/workflows/release-please.yml` — the workflow that runs the
  action.
- [Commit conventions](/opencodehub/contributing/commit-conventions/) —
  what your commits need to look like to drive all of the above.
