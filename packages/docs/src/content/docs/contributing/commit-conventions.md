---
title: Commit conventions
description: Conventional Commits grammar, scopes, and breaking-change rules for OpenCodeHub.
sidebar:
  order: 30
---

OpenCodeHub follows [Conventional Commits](https://www.conventionalcommits.org/).
The commit log on `main` is the input to `release-please` — malformed
messages break version bumps, changelog generation, and release notes. So
we enforce the grammar three times: `lefthook` at `commit-msg`, the
`commitlint` GitHub Action on every PR, and `release-please` itself.

## Grammar

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

- Lowercase type.
- Scope is a single workspace package name or a meta-scope.
- Subject is imperative, ≤ 72 chars, no trailing period.
- Body wraps at 100 cols. Explain *why*, not *what* — the diff tells you
  *what*.
- Footers are standard (`BREAKING CHANGE:`, `Refs: #123`, `Signed-off-by: ...`).

If you are unsure of the type or scope:

```bash title="Interactive Conventional Commit prompt"
pnpm run commit
```

That wraps Commitizen and walks you through type, scope, subject, body,
and breaking-change flags.

## Types

| Type       | Use for                                                                | In changelog?        |
|------------|------------------------------------------------------------------------|----------------------|
| `feat`     | New user-facing capability (CLI flag, MCP tool, indexer, etc.)        | Yes — "Features"     |
| `fix`      | Bug fix                                                                | Yes — "Bug Fixes"    |
| `perf`     | Performance improvement with no behaviour change                       | Yes — "Performance"  |
| `revert`   | Revert an earlier commit                                               | Yes — "Reverts"      |
| `docs`     | Documentation-only change (this site, READMEs, ADRs, comments)         | Yes — "Documentation"|
| `refactor` | Internal reshuffle, no behaviour change                                | Yes — "Refactoring"  |
| `test`     | Adding or fixing tests                                                 | Hidden                |
| `build`    | Build system, dependency bumps, package metadata                       | Hidden                |
| `ci`       | CI workflow change                                                     | Hidden                |
| `chore`    | Housekeeping that fits nowhere else                                    | Hidden                |
| `style`    | Formatting only — Biome runs on pre-commit, so this is rare            | Hidden                |
| `release`  | Release-please-authored commits only (do not use by hand)              | —                    |

"Hidden" means the commit is still enforced and still shows up in the
git log — it just does not appear in `CHANGELOG.md`. See
`.release-please-config.json` for the source of truth on which sections
are visible.

## Scopes

Workspace-package scopes map 1:1 to `packages/<scope>/`:

| Scope         | Package                             |
|---------------|-------------------------------------|
| `analysis`    | `@opencodehub/analysis`             |
| `cli`         | `@opencodehub/cli` (bin: `codehub`) |
| `core-types`  | `@opencodehub/core-types`           |
| `embedder`    | `@opencodehub/embedder`             |
| `gym`         | `@opencodehub/gym`                  |
| `ingestion`   | `@opencodehub/ingestion`            |
| `mcp`         | `@opencodehub/mcp`                  |
| `sarif`       | `@opencodehub/sarif`                |
| `scanners`    | `@opencodehub/scanners`             |
| `scip-ingest` | `@opencodehub/scip-ingest`          |
| `search`      | `@opencodehub/search`               |
| `storage`     | `@opencodehub/storage`              |
| `summarizer`  | `@opencodehub/summarizer`           |

Meta-scopes cover cross-cutting changes:

| Meta-scope | Use for                                                   |
|------------|-----------------------------------------------------------|
| `deps`     | Dependency bumps not tied to one package                  |
| `ci`       | `.github/workflows/*.yml` changes                         |
| `docs`     | `packages/docs/**` or top-level Markdown                  |
| `repo`     | Root-level repo files (`.gitignore`, `mise.toml`, etc.)   |
| `release`  | Release-please-authored PRs only                          |

## Breaking changes on 0.x

OpenCodeHub is pre-1.0. The breaking-change rule is version-dependent:

- **On 0.x:** `feat!` and a `BREAKING CHANGE:` footer both bump the
  **minor** version (0.4.2 → 0.5.0).
- **After 1.0.0:** the same signals bump the **major** version.

The `!` form is the short one:

```
feat(mcp)!: drop the `cypher` tool; use `sql` instead
```

The footer form is equivalent and plays nicer with long explanations:

```
feat(mcp): switch to SCIP-backed references

BREAKING CHANGE: the `lsp-unconfirmed` reason suffix is now
`scip-unconfirmed`. Consumers that pattern-match on the old suffix
must update.
```

Use either form, not both.

## Enforcement

| Layer              | Tool                                   | Trigger                |
|--------------------|----------------------------------------|------------------------|
| Local, pre-commit  | `lefthook` + `commitlint --edit`       | `commit-msg` hook      |
| PR                 | `.github/workflows/commitlint.yml`     | Every PR commit        |
| Release            | `release-please` action on push-to-main | New commit on `main`   |

If commitlint rejects your message locally, re-run `git commit` with a
fixed message — do not `--no-verify`. The tenet applies: every failure
is a blocker.
