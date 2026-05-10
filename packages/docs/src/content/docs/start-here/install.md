---
title: Install
description: Install the codehub CLI and MCP server on macOS, Linux, or Windows.
sidebar:
  order: 20
---

## Requirements

- **OS:** macOS, Linux, or Windows (Windows users should prefer WSL; native
  Windows works if you have the MSVC build tools and `node-gyp` dependencies
  for the optional native tree-sitter addon).
- **Node.js:** Node 22 (with the optional native tree-sitter path) or
  Node 24 (WASM-only). The default parse runtime is `web-tree-sitter`
  on both versions; native is opt-in via `OCH_NATIVE_PARSER=1`.
- **pnpm:** `>=10.0.0` (the workspace lockfile is generated with 10.33.2).
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

`mise install` activates the Node 22, pnpm 10.33.2, and Python 3.12 pins
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

1. Install Node 22 or Node 24 (`nvm install 22`, `fnm install 22`, or
   from [nodejs.org](https://nodejs.org)). Node 24 is supported via the
   default WASM parse runtime; Node 22 supports both WASM and the
   opt-in native N-API addon.
2. Install pnpm `>=10.0.0` (`corepack enable pnpm`, or `npm install -g
   pnpm@10`).
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

`codehub doctor` checks your Node version, pnpm version, native-module
bindings (DuckDB and the optional native tree-sitter addon), and
writable paths in `~/.codehub/` and `.codehub/`. It exits non-zero if
anything looks off.

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

| Variable | Default | Effect |
|---|---|---|
| `OCH_NATIVE_PARSER` | unset | Set to `1` on Node 22 to opt into the native tree-sitter N-API addon. Leave unset to use the WASM default. |
| `CODEHUB_STORE` | unset | `lbug` (force the graph-database backend), `duck` (force the legacy DuckDB single-file layout), or unset (auto-probe — the graph-database backend when `@ladybugdb/core` is importable, otherwise DuckDB). |
| `OCH_VERBOSE` | unset | Set to `1` to surface the storage-backend probe advisory in non-TTY environments. |

See [Configuration](/opencodehub/reference/configuration/) for the full
inventory.

## Next

- [Quick start](/opencodehub/start-here/quick-start/) — index this
  repository and run your first MCP call in 5 steps.
- [Your first query](/opencodehub/start-here/first-query/) — walk
  through `query`, `context`, and `impact`.
