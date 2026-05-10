---
title: Determinism contract
description: Identical inputs produce byte-identical graph hash. Why it matters and how we test it.
sidebar:
  order: 40
---

OpenCodeHub makes one load-bearing promise to agents and humans alike:
**identical inputs produce a byte-identical graph hash**. If you
analyze the same commit twice on the same machine — or on a different
machine with the same toolchain — you get the same `graphHash`. That
is the determinism contract.

## Why it matters

Three concrete reasons:

- **Reproducibility.** An agent that reports a blast radius at
  `graphHash=abc123` and a human reviewer who re-runs `codehub
  analyze` should see the same graph. If the hash diverges, the
  agent's claim is not auditable.
- **Cache-safety.** `codehub status` and CI runners assume that two
  analyze runs at the same commit have the same output. Without
  determinism, incremental caches would drift silently and staleness
  detection would get unreliable.
- **Regression testing.** Every `feat` or `refactor` that touches the
  ingestion pipeline has to demonstrate it did not move the hash
  unintentionally. Determinism makes that assertion possible in one
  line of CI.

## What "inputs" means

An input is:

- Source tree contents at the current commit.
- Toolchain versions (Node 22.x, pnpm 10.33.2, tree-sitter grammars
  pinned in `packages/ingestion/package.json`, SCIP indexer versions
  pinned in `.github/workflows/gym.yml` per ADR 0006).
- OpenCodeHub version (the monorepo version pinned in
  `release-please`).
- Any user-supplied configuration (AGENTS.md overrides, `.codehub/`
  config).

Anything outside that list — wall-clock time, process ID, file-system
inode ordering — must not influence the hash. The ingestion phases
are pure: inputs in, relations out, no ambient state.

## How we test it

Acceptance gate 6 is the regression test. It:

1. Copies a fixture repo into two temp directories.
2. `git init` + commit each (identical tree → identical commit hash).
3. Runs `codehub analyze --force --skip-agents-md` against each,
   capturing the printed `graphHash`.
4. Asserts the two hashes are byte-identical.

If the hashes diverge, the gate fails and the acceptance run exits
non-zero. See `scripts/acceptance.sh` gate 6 for the exact script.

Two adjacent gates reinforce the contract:

- **Gate 10 — embeddings determinism.** Runs the same double-analyze
  with `--embeddings`. Skipped if model weights are not present
  locally. Advisory-only today because embeddings do not yet propagate
  into the headline `graphHash`; the gate prints the hashes so a
  reviewer can spot drift manually.
- **Gym replay (`mise run gym:replay`).** Bit-exact re-invocation of
  the pinned SCIP indexer against the frozen manifest. Catches drift
  introduced by an indexer bump before it lands in `main`.

Full analyze and incremental re-analyze at the same commit must
produce identical hashes (this is asserted explicitly in the
determinism CI gate, not just on a clean tree). That is the "full vs
incremental byte-identical" invariant called out in ADR 0002.

## The `--offline` contract

`codehub analyze --offline` is a separate but related guarantee:
**zero sockets opened** during the run. The flag sets
`OCH_WASM_ONLY=1` (which also forces the WASM-only tree-sitter
runtime path) and disables every non-filesystem I/O path in the
pipeline.

"Zero sockets" is the literal, measurable claim. It is testable by
running under `strace -e connect` or the equivalent on macOS
(`dtruss`); a socket attempt is a bug.

Why it matters: OpenCodeHub is local-first. Your code never leaves
your machine by default. The `--offline` flag makes that an enforceable
contract for users who need to prove it.

## Sources of non-determinism we actively guard against

Ingestion phases are reviewed for the usual suspects:

- **Set / map iteration order.** All emitted records are sorted by a
  stable key before being persisted. Providers that emit
  `extractPropertyAccesses` must return records sorted by
  `(enclosingSymbolId, propertyName, startLine)` — see the
  `LanguageProvider` interface docstring.
- **`Date.now()`, `crypto.randomUUID()`, any `Math.random()`.**
  Banned in ingestion code. The graph-hash computation uses content
  hashes, never timestamps.
- **File-system walk order.** `readdir` results are sorted by byte
  value before dispatch.
- **Parallel worker output ordering.** Worker pools emit into
  per-worker buffers that are concatenated in deterministic file order
  at join time.

A fresh contributor reviewing a PR that adds a new phase should ask:
"If I ran this twice on the same commit, would I get the same
bytes?" If the answer is not obviously yes, the phase is wrong.

## Related

- [ADR 0001 — Storage backend](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0001-storage-backend.md) —
  "Deterministic writes given identical INSERT order" is a listed
  positive of DuckDB vs. engines with random header UUIDs.
- [ADR 0002 — Rust core deferred](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0002-rust-core-deferred.md) —
  calls out the "full vs incremental `graphHash` byte-identical"
  determinism CI gate explicitly.
- [Contributing overview — Tenets](/opencodehub/contributing/overview/#tenets) —
  "Determinism is non-negotiable" is the first tenet in `CONTRIBUTING.md`.
- `scripts/acceptance.sh` gate 6 — the runtime regression test.
