## OpenCodeHub MCP Tools

This repository has been indexed by OpenCodeHub. When you are working in this
codebase, prefer the following MCP tools over raw file search — they return
graph-aware results grouped by execution flow and include blast-radius risk
tiers.

- `list_repos` — enumerate repos currently indexed on this machine.
- `query` — hybrid BM25 + vector search over symbols, grouped by process.
- `context` — inbound/outbound refs and participating flows for one symbol.
- `impact` — dependents of a target up to a configurable depth, with a risk tier.
- `detect_changes` — map an uncommitted or committed diff to affected symbols.
- `rename` — graph-assisted multi-file rename; dry-run is the default.
- `sql` — read-only SQL against the local graph store with a 5 s timeout.

Run `codehub analyze` after pulling new commits so the index stays aligned
with the working tree. `codehub status` reports staleness.

## Full MCP surface

The full MCP surface is **28 tools** (see `packages/mcp/src/server.ts`);
the 7 listed above are the high-frequency exploration tools. For the
full inventory, use the `/opencodehub-guide` skill.

## AMBIGUOUS_REPO

When two or more repos are indexed on this machine, per-repo tools require
an explicit `repo:` argument and return `AMBIGUOUS_REPO` otherwise.

## Durable lessons

Prior-session architecture lessons live in `.erpaval/INDEX.md` (SCIP edge
conventions, BM25 caveats, SageMaker embedder patterns). Read before
making graph-index or retrieval changes.

## Claude Code plugin

This repo ships a Claude Code plugin at `plugins/opencodehub/` — it
provides `/probe`, `/verdict`, `/owners`, `/audit-deps`, `/rename` slash
commands plus a `code-analyst` subagent and 10 skills. Install via
`codehub init` (writes `.mcp.json` + links the plugin).

## Parse runtime — WASM default, native opt-in

`@opencodehub/ingestion` defaults to the `web-tree-sitter` (WASM) runtime
on both Node 22 and Node 24. To opt into the faster native `tree-sitter`
N-API addon on Node 22 dev boxes, set `OCH_NATIVE_PARSER=1` or pass
`--native-parser` to the `codehub` CLI. Native is not supported on
Node 24 until `node-tree-sitter@0.25.1` lands on npm
(tree-sitter/node-tree-sitter#276).

Kotlin, Swift, and Dart grammars use `.wasm` blobs vendored at
`packages/ingestion/vendor/wasms/` (built from the same grammar sources
pinned in `package.json`). Rebuild via `bash scripts/build-vendor-wasms.sh`
after bumping any of those grammars — requires docker, podman, finch
(aliased as docker), or a local emcc install.

The complexity phase (`packages/ingestion/src/pipeline/phases/complexity.ts`)
still uses native tree-sitter for cyclomatic-complexity metrics. On Node 24
or Node 22 without the opt-in, complexity extraction degrades with a
one-shot stderr warning; all other parsing continues via WASM.
