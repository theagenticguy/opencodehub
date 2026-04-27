---
title: Install
description: Install the codehub CLI and MCP server on macOS, Linux, or Windows.
sidebar:
  order: 20
---

## Requirements

- **OS:** macOS, Linux, or Windows (Windows users should prefer WSL; native
  Windows works if you have the MSVC build tools and `node-gyp` dependencies
  for tree-sitter and DuckDB).
- **Node.js:** `>=22.0.0` (Node 22 LTS is the pin in the repo).
- **pnpm:** `>=10.0.0` (the workspace lockfile is generated with 10.33.2).
- **Python 3.12:** only required if you plan to run the evaluation harness
  under `packages/eval`. Not required for the CLI or MCP server.
- **mise:** recommended. It pins Node, pnpm, and Python from the committed
  `mise.toml` in one command.

## Install paths

### Recommended: mise-managed toolchain

```bash title="clone, pin tools, install, build"
git clone https://github.com/theagenticguy/opencodehub
cd opencodehub
mise install
pnpm install --frozen-lockfile
pnpm -r build
```

`mise install` activates the Node 22, pnpm 10.33.2, and Python 3.12 pins
from `mise.toml`. `pnpm install --frozen-lockfile` installs exactly the
lockfile-pinned dependencies. `pnpm -r build` compiles every TypeScript
package so the CLI entrypoint at `packages/cli/dist/index.js` is
runnable.

### Without mise: manual toolchain

If you already manage Node and pnpm another way:

1. Install Node `>=22.0.0` (`nvm install 22`, `fnm install 22`, or from
   [nodejs.org](https://nodejs.org)).
2. Install pnpm `>=10.0.0` (`corepack enable pnpm`, or `npm install -g
   pnpm@10`).
3. Clone and build:

   ```bash
   git clone https://github.com/theagenticguy/opencodehub
   cd opencodehub
   pnpm install --frozen-lockfile
   pnpm -r build
   ```

### From npm

Global npm distribution of `codehub` is not yet published. For now, run
the CLI from a cloned checkout using `node packages/cli/dist/index.js`.
A published `@opencodehub/cli` package is planned.

## Verify the install

After `pnpm -r build` finishes, the CLI entrypoint at
`packages/cli/dist/index.js` should print its help text:

```bash title="verify the CLI is runnable"
node packages/cli/dist/index.js --help
```

Then probe your environment:

```bash title="probe the dev environment"
node packages/cli/dist/index.js doctor
```

`codehub doctor` checks your Node version, pnpm version, native module
bindings for tree-sitter and DuckDB, and writable paths in `~/.codehub/`
and `.codehub/`. It exits non-zero if anything looks off.

## Next

- [Quick start](/opencodehub/start-here/quick-start/) — index this
  repository and run your first MCP call in 5 steps.
- [Your first query](/opencodehub/start-here/first-query/) — walk
  through `query`, `context`, and `impact`.
