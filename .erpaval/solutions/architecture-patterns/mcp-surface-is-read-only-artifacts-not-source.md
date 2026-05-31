---
name: "The MCP surface is read-only: tools may write artifacts, never a user's source"
description: OpenCodeHub's MCP tools must never edit a user's source files. readOnlyHint=false is allowed ONLY for tools that write derived artifacts (SARIF, code-packs, contract registries under .codehub/); destructiveHint=true (source mutation) is forbidden. The rename + remove_dead_code tools were removed under this rail. Pin the invariant in a server contract test, not just prose.
type: architecture-patterns
---

(2026-05-31, session-bba601.) The user's standing rule: **no source-mutating
tools on the MCP surface, period.** An AI agent talking to OpenCodeHub over
stdio MCP can read the graph, search, analyze blast radius, scan, pack — but it
cannot reach through the MCP server to rewrite the user's `.ts`/`.py` files.
Refactors are planned/verified via read-only analysis and applied by the human
(or the agent's own editor), never by an OpenCodeHub tool.

This is distinct from Roadmap rail #2 ("stdio MCP only — no HTTP"). That rail is
about transport; this is about *capability*. Both hold simultaneously.

## The annotation distinction that matters

MCP tool annotations have two flags that are easy to conflate:

- `readOnlyHint: false` — "this tool writes *something*." TRUE for artifact
  writers too: `scan` (writes SARIF to `.codehub/`), `pack_codebase` (writes a
  code-pack to an output dir), `group_sync` (writes a contract registry to
  `~/.codehub/groups/`). These are FINE — they emit derived outputs, never edit
  source.
- `destructiveHint: true` — "this tool mutates/destroys user-authored content."
  This is the one the rail forbids. Only `rename` (rewrote source to apply a
  symbol rename) and `remove_dead_code` (deleted source ranges via
  `fs.writeFileAtomic`) carried it. Both were removed.

So when auditing the surface, "find write tools" via `readOnlyHint: false`
OVER-captures — it flags the harmless artifact writers. The precise query for
"does any tool violate the read-only-source rail" is `destructiveHint: true`.
Grep both, then split by *what each writes* (a `.codehub/` artifact or an output
dir → keep; a path under the user's source tree → rip).

## Pin it in a contract test, not prose

Prose drifts. The durable guard is a server test that:
1. enumerates `_registeredTools` and asserts the exact name set (so a dropped or
   re-added tool fails the assertion), and
2. asserts NO registered tool has `destructiveHint === true`, plus explicit
   `assert.equal(tools["rename"], undefined)` / `remove_dead_code` undefined so
   re-adding either one fails loudly.

See `packages/mcp/src/server.test.ts` (`registers exactly the expected
read-only tool set`) and `tools/annotations.test.ts` (`no source-mutating tool
is registered; non-read-only tools only write artifacts`).

## Removal surface (for the next "rip a tool" task)

A tool isn't just its `tools/<name>.ts` + registration. The full surface:
- the tool module + its `.test.ts` (rename had no own test — it was covered in
  `run-smoke.test.ts` and the analysis-layer `rename.test.ts`; grep, don't assume).
- the `register*Tool` import + call in `server.ts`.
- the `run*` re-export in the package `index.ts` (public API).
- the analysis-bridge wrapper (`callRun*`) + any now-orphaned imports it pulled
  (`createNodeFs`/`FsAbstraction` became unused once `callRunRename` went).
- the underlying analysis logic IF it's tool-exclusive (`analysis/rename.ts` +
  its `index.ts` export + its types in `types.ts`). CHECK shared helpers first:
  `analysis/dead-code.ts` stayed because `classifyDeadness` backs the surviving
  read-only `list_dead_code`; `fs.ts`/`git.ts` stayed (shared with staleness +
  detect-changes). Only delete what's exclusive.
- every count + inventory in docs/skills (here: 20 files — CLAUDE/AGENTS/README/
  SPECS, tool-catalog.json `tool_count`, the guide skill inventory, decision
  matrices, example prompts) and any skill whose premise WAS the tool (the
  `opencodehub-refactoring` skill was rename-centric → reframed to analysis-only,
  not deleted, because read-only refactoring guidance is still valuable).

Related: [[rip-superseded-subsystem-record-the-gap]] (same investigate-then-rip
discipline) and [[no-spec-coordinate-leakage-into-source]] (the count-drift
class of doc debt a tool removal creates).
