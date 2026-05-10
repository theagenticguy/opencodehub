---
title: Dev loop
description: Tools, install commands, and the mise task catalogue for local development.
sidebar:
  order: 20
---

The local dev loop is three commands once your toolchain is in place. This
page covers the toolchain pins, the full `mise` task catalogue, and when
to reach for the long-running `check:full` and `acceptance` targets.

## Toolchain pins

| Tool   | Version      | How it gets installed                     |
|--------|--------------|-------------------------------------------|
| Node   | 22 (>=22.0.0) | `mise.toml` — matches root `engines.node` |
| pnpm   | 10.33.2      | `mise.toml` + `packageManager` field      |
| Python | 3.12         | `mise.toml` — only needed for `packages/eval` |
| uv     | latest       | `mise.toml` — Python package manager       |

The Python venv for the eval harness is auto-created by `mise` via this
stanza in `mise.toml`:

```toml title="mise.toml"
[env]
_.python.venv = { path = "packages/eval/.venv", create = true }
```

You do not need `pyenv`, `nvm`, `direnv`, or a hand-rolled venv. `mise`
activates tools and environment variables when you `cd` into the repo.

## Three-command dev loop

```bash title="Daily loop"
mise install                          # once per machine or after mise.toml changes
pnpm install --frozen-lockfile        # once per pnpm-lock.yaml change
mise run check                        # every time you want to know if your branch is green
```

`mise run check` runs lint, typecheck, test, and the banned-strings sweep
in a single chain and stops on the first failure. The equivalent
`pnpm run check` is wired to the same task.

## Individual checks

Run one gate at a time when you want a faster loop:

```bash
mise run lint               # Biome check across packages/**/src, packages/**/test, scripts
mise run typecheck          # tsc --noEmit across every workspace package
mise run test               # pnpm -r test (each package's `test` script)
mise run banned-strings     # scripts/check-banned-strings.sh
```

## Heavier gates

```bash
mise run check:full         # check + licenses + osv
mise run acceptance         # 15 Definition-of-Done gates (soft: 7, 10, 11)
mise run smoke:mcp          # boot MCP server over stdio, assert tools/list
mise run test:eval          # Python eval harness (pytest under uv)
mise run gym                # SCIP-indexer differential gym vs. frozen baseline
```

`check:full` adds the license allowlist (`license-checker-rseidelsohn`) and
the `osv-scanner` vulnerability scan against `pnpm-lock.yaml`. CI runs both
on every PR.

`acceptance` is the full v1.0 Definition-of-Done. Some gates are soft —
they log but do not block — because they depend on optional binaries
(semgrep, embedder weights) or measure timings on the local machine.

## Full task catalogue

Every task in `mise.toml`:

| Task                     | Purpose                                                                 |
|--------------------------|-------------------------------------------------------------------------|
| `install`                | `pnpm install --frozen-lockfile`                                       |
| `install:update`         | `pnpm install` — allows the lockfile to update                         |
| `install:eval`           | `uv sync` inside `packages/eval`                                       |
| `bootstrap`              | `install` + `install:eval`                                             |
| `build`                  | `pnpm -r build` across every package                                   |
| `build:cli`              | Build only `@opencodehub/cli`                                          |
| `build:clean`            | Clean + full rebuild                                                   |
| `clean`                  | `pnpm -r clean`                                                        |
| `clean:all`              | Clean + delete `node_modules` everywhere                               |
| `cli:link`               | `pnpm link --global` — expose `codehub` system-wide for dev            |
| `cli:unlink`             | Reverse of `cli:link`                                                  |
| `cli:pack`               | Produce a distributable tarball of the CLI                             |
| `cli:install-global`     | Install the packed tarball globally with pnpm                          |
| `cli:uninstall-global`   | Remove the globally installed `codehub`                                |
| `test`                   | `pnpm -r test`                                                         |
| `test:eval`              | Python eval harness (`uv run pytest`)                                  |
| `lint`                   | `biome check .`                                                        |
| `lint:fix`               | `biome check --write .`                                                |
| `format`                 | `biome format --write .`                                               |
| `typecheck`              | `pnpm -r exec tsc --noEmit`                                            |
| `banned-strings`         | `scripts/check-banned-strings.sh`                                      |
| `licenses`               | License allowlist check (prod deps, private packages excluded)         |
| `osv`                    | `osv-scanner scan source --lockfile pnpm-lock.yaml`                    |
| `sarif:validate`         | Validate emitted SARIF against the Zod schema                          |
| `check`                  | `lint` + `typecheck` + `test` + `banned-strings`                       |
| `check:full`             | `check` + `licenses` + `osv`                                           |
| `acceptance`             | 15 v1.0 DoD gates (`scripts/acceptance.sh`)                            |
| `smoke:mcp`              | Boot the MCP server over stdio and assert `tools/list`                 |
| `commit`                 | Commitizen-guided Conventional Commit prompt                           |
| `envinfo`                | Print tool versions for bug reports                                    |
| `gym`                    | SCIP-indexer differential gym run                                      |
| `gym:baseline`           | Lock a new baseline manifest                                           |
| `gym:replay`             | Bit-exact replay of a frozen manifest                                  |
| `gym:refresh-expected`   | Refresh corpus `expected:` lists from the current manifest             |
| `analyze`                | `codehub analyze` against the current repo                             |
| `status`                 | `codehub status`                                                       |
| `mcp`                    | Start the stdio MCP server                                             |

## Lefthook hooks

`lefthook install` (run once after `pnpm install`) wires three hooks:

| Hook        | Runs                                                    |
|-------------|---------------------------------------------------------|
| `pre-commit` | Biome autofix on staged `.ts/.tsx/.js/.jsx/.json/.jsonc` + banned-strings sweep |
| `commit-msg` | `commitlint --edit` on the draft message                |
| `pre-push`   | `tsc --noEmit` across packages + `pnpm -r test`         |

The pre-push hook is the last safety net before CI picks up your branch.
If it fails on a supposedly-unrelated test, see [Tenets](/opencodehub/contributing/overview/#tenets):
we fix it, we do not skip it.

## When to run `acceptance`

Before opening a PR that touches any of:

- The analyze pipeline (`packages/ingestion`, `packages/analysis`).
- Storage (`packages/storage`).
- The MCP server (`packages/mcp`).
- The graph-hash contract (anything that could affect determinism).
- `scripts/check-banned-strings.sh` or the CI workflows.

Otherwise `mise run check` is enough locally; CI will run the full matrix.
