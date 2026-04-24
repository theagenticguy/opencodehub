# Contributing to OpenCodeHub

## IP hygiene

OpenCodeHub is a clean-room implementation. Do not copy code from any
PolyForm, BSL, Commons Clause, GPL, or AGPL source.

CI enforces:
- Permissive-license allowlist (Apache-2.0 / MIT / BSD / ISC / CC0 / BlueOak / 0BSD) on all transitive deps
- Banned-strings grep over all tracked source (see `scripts/check-banned-strings.sh`)
- `osv-scanner` vulnerability scan on the lockfile

## Development loop

```bash
mise install
pnpm install --frozen-lockfile
mise run check        # lint + typecheck + test + banned-strings
```

## Commit messages — Conventional Commits are required

All commits on `main` must follow [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

- **Types**: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`, `release`.
- **Scopes**: the workspace package (`cli`, `ingestion`, `mcp`, …) or meta-scope (`deps`, `ci`, `docs`, `repo`, `release`).
- **Breaking changes**: append `!` after the type or add a `BREAKING CHANGE:` footer. While on `0.x.y` these bump the minor; after `1.0.0` they bump the major.

Use the interactive prompt if you're unsure:

```bash
pnpm run commit   # wraps commitizen — prompts for type, scope, subject, body
```

Enforcement:
- Local: `lefthook` runs commitlint on `commit-msg` — malformed messages are rejected before they land.
- CI: `.github/workflows/commitlint.yml` validates every commit on a PR.
- Releases: `release-please` reads the commit log on `main` and opens a versioned release PR automatically. Merging it cuts the tag, generates `CHANGELOG.md`, and publishes the release.

## Commit hooks

`lefthook install` wires:
- `pre-commit`: biome + banned-strings
- `commit-msg`: commitlint
- `pre-push`: typecheck + test

## Pull requests

1. Fork + branch
2. `pnpm run check` green locally
3. PR against `main`
4. All CI jobs green: lint, typecheck, test (Linux/macOS/Windows), banned-strings, licenses, osv, sarif-validate, commitlint, CodeQL

## Adding a new language provider

1. Add the tree-sitter grammar to `packages/ingestion/package.json` with a pinned version
2. Implement `LanguageProvider` in `packages/ingestion/src/providers/<lang>.ts`
3. Register it in `packages/ingestion/src/providers/registry.ts` (TypeScript will fail the build if missing)
4. Add fixture tests in `packages/ingestion/test/fixtures/<lang>/`

## Tenets

- Determinism is non-negotiable — identical inputs must yield identical graph-hash
- Offline-first — `codehub analyze --offline` must open zero sockets
- Clean-room IP hygiene — when in doubt, ask
