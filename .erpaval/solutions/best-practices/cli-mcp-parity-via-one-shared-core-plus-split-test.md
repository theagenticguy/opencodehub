---
name: cli-mcp-parity-via-one-shared-core-plus-split-test
description: To give a capability true CLI<->MCP parity in OCH, BOTH surfaces must call one shared @opencodehub/analysis core function with structurally identical query args — never reimplement logic per surface. The CLI emits the raw camelCase result via JSON.stringify; the MCP tool recases a PARTIAL set of keys to snake_case (top-level + impacted_subgraph/cost_attribution interiors only; nested array elements + verdict stay camelCase). A cross-package test importing cli/src from mcp/src breaks the MCP package rootDir — so SPLIT the parity proof: CLI test asserts --json deep-equals the raw pack (passthrough), MCP test asserts toStructured recases losslessly (recase-back == raw). Also: adding a tool trips the server.test.ts roster contract (EXPECTED_TOOL_NAMES + length assertion) by design — bump both.
metadata:
  type: best-practice
  category: best-practices
tags: [cli, mcp, parity, change-pack, rootdir, tool-roster, contract-test, snake-case]
discovered: 2026-06-14
session: session-6afa8d
related:
  - tokenizer-id-is-provenance-not-an-encoder
---

# CLI<->MCP parity: one shared core + a split parity test

## The pattern that gives parity

Parity is NOT "two surfaces that happen to format the same." It is: both the CLI
command (`packages/cli/src/commands/X.ts`) and the MCP tool
(`packages/mcp/src/tools/X.ts`) delegate to ONE exported
`@opencodehub/analysis` (or `pack`) core function, passing structurally
identical query args. The cleanest exemplar is `detect_changes` →
`runDetectChanges`. Copy it. The core is the single source of truth; the
surfaces only resolve args, open a store, and format.

Surface conventions to match:
- CLI: commander v15, per-command `--json` that does `console.log(JSON.stringify(result, null, 2))` (raw camelCase, no reshaping). Reuse `pack.verdict.exitCode` (0|1|2) so CI gates match `codehub verdict`.
- MCP: `withStore` + `withNextSteps` + `stalenessFromMeta` + `toolErrorFromUnknown`, registered in `server.ts`, NO `outputSchema`. The structuredContent uses a PARTIAL snake_case recasing — only the top-level keys plus the interiors of nested objects the tool explicitly recases; array element objects and pass-through objects (e.g. the verdict) stay camelCase. Document the exact map.

## The split parity test (the non-obvious part)

A single test that imports BOTH `cli/src/...` and the MCP tool from inside the
mcp package fails `tsc` with TS6059/TS6307: `cli/src/*` is not under the mcp
package's `rootDir`. Don't fight it. Split the proof so each half lives in its
own package and together they're airtight:

- **CLI package test**: assert `--json` output deep-equals the analysis result
  fixture → proves the CLI is a pure passthrough (no reshaping).
- **MCP package test**: assert `mcpToCamel(toStructured(fixture))` deep-equals
  the fixture → proves the recasing is LOSSLESS (drops no field, mis-spells no
  key). Export `toStructured` from the tool module so the test can call it.

Pure passthrough + lossless recasing of the SAME core output ⇒ identical values
on both surfaces. Drive both hermetically via the `_`-prefixed seams
(`_openStore`/`_runChangePack` on the CLI; the analysis core is deterministic and
fails-open on a fake store) — no git, no DB, no process spawn.

## The roster contract will fail — that's intentional

`packages/mcp/src/server.test.ts` pins `EXPECTED_TOOL_NAMES` (sorted) AND
`assert.equal(registered.length, N)`. Registering a new tool makes both fail.
This is the guard against a tool silently dropping out of `buildServer`. Adding
a tool means: add the wire-name to `EXPECTED_TOOL_NAMES` and bump the length.
Also sweep for stale "N tools" counts in CLAUDE.md / AGENTS.md / docs prose
(those are not gated but go stale).

## Why this matters

Per-surface logic drifts the moment one side gets a fix the other doesn't. One
shared core makes drift structurally impossible; the split test makes the
serialization layer (the only place they CAN diverge) provably equivalent
without violating the package boundary.
