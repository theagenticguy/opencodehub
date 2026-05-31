# OBJECTIVES.md — OpenCodeHub

Project objectives inferred from the repo: what success looks like, where the
quality bar sits, and what is deliberately out of scope.

## Primary objectives

1. **Answer graph questions in one MCP call.** AI coding agents need callers,
   callees, processes, and blast radius before they write a diff. Grep is
   textual. Language servers work one file at a time. Embeddings lose
   precision. OpenCodeHub answers all four from a persisted graph, and the
   28-tool MCP surface is the primary product.

2. **Stay Apache-2.0 across every runtime dependency.** Each transitive
   dependency sits on the permissive allowlist: Apache-2.0, MIT, BSD, ISC,
   CC0, BlueOak, 0BSD. CI enforces it on every push. Scanners with
   incompatible licenses never link into the host. hadolint (GPL) and tflint
   (MPL/BUSL) run as subprocesses instead. The README frames this as a
   fork-and-embed posture.

3. **Keep the index local, offline, and deterministic.** `codehub analyze
   --offline` opens zero sockets. The `graphHash` is byte-identical whether
   you run a full or an incremental index at the same commit. Acceptance gate
   6 checks that invariant on every run.

4. **Cover 15 languages; deepen five with SCIP.** Fourteen parse through
   tree-sitter, and a regex provider handles fixed-format COBOL. Five
   (TypeScript, Python, Go, Rust, Java) also run a native SCIP indexer.
   Heuristic call edges miss cross-module resolution. So the `scip-index`
   phase indexes each language once, and the `confidence-demote` phase
   reconciles heuristic edges against compiler-grade ones. A sibling testbed
   repo holds the gym that gates per-language F1 against SCIP baselines.

## Quality bar

5. **Gate every eval and gym run in three layers.** The testbed checks an
   absolute F1 floor, a relative F1 delta, and per-case non-regression.
   Acceptance gate 9 requires at least 40 of 49 Python-eval cases to pass. A
   soft regression fails the run.

6. **Fail CI on any non-zero exit.** `pnpm run check` chains lint, typecheck,
   test, and banned-strings, stopping at the first failure. CI runs the same
   chain plus OSV, CodeQL, Scorecard, SARIF schema validation, commitlint, and
   the license allowlist. The banned-strings sweep enforces clean-room IP
   hygiene.

7. **Keep MCP responses structured, versioned, and self-describing.** Every
   tool returns a `next_steps` array. When the index lags HEAD, it adds a
   `_meta["codehub/staleness"]` envelope. Failures carry a typed code such as
   `AMBIGUOUS_REPO`, never a free-form string. That shape is what makes the
   tools safe inside automated agent loops.

## Non-goals

8. **Do not operate a server or SaaS.** DuckDB is embedded. The MCP server is
   a stdio process. ADR 0001 rejects any engine that would need a daemon. The
   product ships as a CLI plus an MCP server, nothing hosted.

9. **Do not port to Rust before it is needed.** ADR 0002 measured p95
   single-file incremental analysis at 195-250ms on the 100-file fixture, well
   under the 1s gate. It projects a cold 100k-LOC analyze at 3 to 5 seconds.
   Rust is deferred to v2.1 or later. The re-trigger conditions are tied to
   measured latency on real user repos.

## Measurable outcomes

10. **Get from clone to a working agent in one sequence.** A user runs `mise
    install`, then `pnpm install --frozen-lockfile`, then `codehub setup`,
    then `codehub analyze`. After that, their agent can call `impact`,
    `detect_changes`, and `context` on a real repo. Acceptance gates 1-8
    confirm this happy path. Gates 10-15 confirm the opt-in paths for
    embeddings, scanners, SARIF validation, license audit, and verdict. The
    README promises this flow. `scripts/acceptance.sh` verifies it.
