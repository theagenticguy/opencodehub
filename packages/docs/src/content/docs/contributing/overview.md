---
title: Contributing overview
description: Start here before you open a pull request against OpenCodeHub.
sidebar:
  order: 10
---

Welcome. OpenCodeHub is an Apache-2.0 code-intelligence graph plus MCP server
for AI coding agents. The project lives on a permissive, OSS-only stack and
makes a hard promise about determinism and offline-first behaviour — so the
contribution bar is specific, not generic.

This page is the table of contents for contributors. Read it first, then work
through the page that matches what you want to do.

## What we ship, and what we will not

The primary product is the `codehub` CLI plus the stdio MCP server that
agents call over JSON-RPC. The scope is captured in
[OBJECTIVES.md](https://github.com/theagenticguy/opencodehub/blob/main/OBJECTIVES.md):

- Graph-aware context (callers, callees, processes, blast radius) in one
  MCP tool call.
- Apache-2.0 end to end, with every transitive runtime dep on the
  permissive allowlist.
- Local, offline-capable, deterministic index.
- Fifteen tree-sitter languages, with SCIP indexers upgrading five of
  them (TypeScript, Python, Go, Rust, Java) to compiler-grade edges.

Explicit non-goals:

- No hosted service. DuckDB is embedded and the MCP server is a stdio
  process.
- No Rust port before we can measure it is needed (see
  [ADR 0002](/opencodehub/architecture/adrs/)).

Contributions that pull the project toward either non-goal will be sent
back — kindly, but sent back.

## Who benefits from a contribution

Three audiences benefit from most changes:

1. **Agents.** Anything that makes tool responses richer, more structured,
   or less ambiguous (typed errors, `next_steps`, `_meta` envelopes) helps
   automated agent loops.
2. **Contributors.** Anything that shortens the dev loop, fixes flaky
   tests, or documents a sharp edge helps the next person too.
3. **End users running the CLI.** Speed, offline robustness, and better
   defaults show up here.

If a change does not pay off for at least one of these three, it probably
does not belong.

## Where to start

If you are looking for an easy first ticket:

- **Add or fix a language-provider fixture.** Every provider under
  `packages/ingestion/src/providers/` is backed by fixtures in
  `packages/ingestion/test/fixtures/<lang>/`. More fixtures means more
  extraction bugs caught. See
  [Adding a language provider](/opencodehub/contributing/adding-a-language-provider/).
- **Doc improvements.** This site lives in `packages/docs/`. Fix a
  typo, tighten a rationale, add a diagram, link a missing ADR.
- **MCP tool polish.** Every tool lives under
  `packages/mcp/src/tools/<tool>.ts`. `next_steps`, error envelopes, and
  response shapes all evolve in small PRs.

## Read before you write code

- [Dev loop](/opencodehub/contributing/dev-loop/) — `mise install`,
  `pnpm install --frozen-lockfile`, `mise run check`, the full task
  catalogue.
- [Commit conventions](/opencodehub/contributing/commit-conventions/) —
  Conventional Commits are required; commitlint runs locally and in CI.
- [Release process](/opencodehub/contributing/release-process/) — how
  release-please turns your commits into a version bump.
- [IP hygiene](/opencodehub/contributing/ip-hygiene/) — the clean-room
  rule, the license allowlist, the banned-strings sweep.
- [Adding a language provider](/opencodehub/contributing/adding-a-language-provider/) —
  four steps, compile-time enforced.
- [Testing](/opencodehub/contributing/testing/) — Node test runner, the
  Python eval harness, the MCP smoke test, the acceptance gates.

The canonical short form of these rules lives in
[CONTRIBUTING.md](https://github.com/theagenticguy/opencodehub/blob/main/CONTRIBUTING.md).
These pages expand the rationale.

## Tenets

These three are non-negotiable. They are reproduced verbatim from
`CONTRIBUTING.md`:

- **Determinism is non-negotiable** — identical inputs must yield identical
  graph-hash.
- **Offline-first** — `codehub analyze --offline` must open zero sockets.
- **Clean-room IP hygiene** — when in doubt, ask.

The deeper rationale lives in
[Architecture / Determinism](/opencodehub/architecture/determinism/) and
[IP hygiene](/opencodehub/contributing/ip-hygiene/).
