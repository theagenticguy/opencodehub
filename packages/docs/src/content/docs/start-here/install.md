---
title: Install
description: Install the codehub CLI and MCP server on macOS, Linux, or Windows.
sidebar:
  order: 20
---

## Requirements

- **OS:** macOS, Linux, or Windows. WSL is recommended on Windows for
  parity with the Linux dev path, but native Windows now works without
  the MSVC build chain because OpenCodeHub does no native compilation
  at install time.
- **Node.js:** Node ≥24.15. The store is Node's built-in `node:sqlite`
  (`DatabaseSync`, enabled by default at that version) and the parse
  runtime is `web-tree-sitter` (WASM) — there is no native opt-in (ADR 0015).

## Supported platforms

OpenCodeHub installs with **zero native compilation and zero native
storage bindings** — the store is Node's built-in `node:sqlite` and the
parse runtime is WASM (ADR 0019). There is no per-platform prebuilt to
match, so **every platform is supported**:

| Platform | Supported |
|---|---|
| macOS arm64 (Apple Silicon) | ✅ |
| macOS x64 (Intel) | ✅ |
| Linux x64 (glibc — Debian/Ubuntu/RHEL) | ✅ |
| Linux arm64 (glibc) | ✅ |
| Windows x64 | ✅ |
| Windows arm64 | ✅ |
| Linux musl (Alpine) | ✅ |

There is no unsupported-platform failure mode: `npm install -g
@opencodehub/cli` plus Node ≥24.15 is the whole install. Any base
image works, including Alpine/musl (`node:24-alpine`) and Windows-on-ARM,
because nothing compiles and no native binding has to load.
- **pnpm:** `>=11.0.0` (the workspace lockfile is generated with 11.1.0).
- **Python 3.12:** optional, only used by auxiliary tooling (the
  harness packages do not ship as runtime dependencies). Not required
  for the CLI or MCP server.
- **mise:** recommended. It pins Node, pnpm, and Python from the committed
  `mise.toml` in one command.

## Install paths

### Recommended: mise-managed toolchain

```bash title="clone, pin tools, install, build, link"
git clone https://github.com/theagenticguy/opencodehub
cd opencodehub
mise install
pnpm install --frozen-lockfile
pnpm -r build
mise run cli:link          # puts `codehub` on your PATH
```

`mise install` activates the Node 24, pnpm 11.1.0, and Python 3.12 pins
from `mise.toml`. `pnpm install --frozen-lockfile` installs exactly the
lockfile-pinned dependencies. `pnpm -r build` compiles every TypeScript
package so the CLI entrypoint at `packages/cli/dist/index.js` is
runnable. `mise run cli:link` wraps `pnpm link --global` inside
`packages/cli/` so `codehub` resolves from any directory; remove with
`mise run cli:unlink`.

If you would rather install a packed tarball instead of a pnpm symlink
(useful in CI images, devcontainers, or when pnpm's global link
conflicts with another tool), run `mise run cli:install-global`
instead — it builds the CLI, runs `pnpm pack`, and installs the
tarball globally.

### Without mise: manual toolchain

If you already manage Node and pnpm another way:

1. Install Node ≥24.15 (`nvm install 24`, `fnm install 24`, or
   from [nodejs.org](https://nodejs.org)). The store uses the built-in
   `node:sqlite` and parsing uses `web-tree-sitter` (WASM) — there is no
   native parser and no opt-in (ADR 0015).
2. Install pnpm `>=11.0.0` (`corepack enable pnpm`, or `npm install -g
   pnpm@11`).
3. Clone, build, and link:

   ```bash
   git clone https://github.com/theagenticguy/opencodehub
   cd opencodehub
   pnpm install --frozen-lockfile
   pnpm -r build
   pnpm --filter @opencodehub/cli link --global
   ```

### From npm

Global npm distribution of `codehub` is not yet published. For now,
link (or install the packed tarball) from a cloned checkout as shown
above. A published `@opencodehub/cli` package is planned.

## Verify the install

After `mise run cli:link` (or `pnpm --filter @opencodehub/cli link
--global`) finishes, `codehub` should be on your `PATH`:

```bash title="verify the CLI is runnable"
codehub --help
```

Then probe your environment:

```bash title="probe the dev environment"
codehub doctor
```

`codehub doctor` checks your Node version, pnpm version, the built-in
`node:sqlite` module (an import plus a WAL round-trip — there is no
native storage binding to probe, and parsing is WASM-only), and writable
paths in `~/.codehub/` and `.codehub/`. It exits non-zero if anything
looks off.

:::note[Fallback for unlinked checkouts]
If you cannot or will not link the CLI (locked-down CI images, a
throwaway clone, etc.), every `codehub <subcommand>` in these docs
works as `node packages/cli/dist/index.js <subcommand>` from the
checkout root. Same arguments, same behaviour. For example:

```bash
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js doctor
```
:::

## Optional environment toggles

Storage has no toggle: the whole index lands in one
`.codehub/store.sqlite` file (WAL mode) via the built-in `node:sqlite`,
written on every `analyze`, with no backend-selection env var and no
native binding (ADR 0019). Parsing has no toggle either:
`web-tree-sitter` (WASM) is the only runtime (ADR 0015).

| Variable | Default | Effect |
|---|---|---|
| `OCH_VERBOSE` | unset | Set to `1` to surface the one-shot advisory the CLI emits when a removed legacy parser env var is still set, in non-TTY environments. |

See [Configuration](/opencodehub/reference/configuration/) for the full
inventory.

## Next

- [Quick start](/opencodehub/start-here/quick-start/) — index this
  repository and run your first MCP call in 5 steps.
- [Your first query](/opencodehub/start-here/first-query/) — walk
  through `query`, `context`, and `impact`.
