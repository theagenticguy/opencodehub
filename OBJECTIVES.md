# OBJECTIVES.md — OpenCodeHub

A concise set of project objectives inferred from the repo. What success
looks like, where the quality bar sits, and what is deliberately out of
scope.

## Primary objectives

1. **Give AI coding agents graph-aware code context in one MCP tool
   call.** *Because the README's problem statement is exactly this:
   grep is textual, language servers are per-file, embeddings are
   lossy; agents need callers, callees, processes, and blast radius
   answered before they write a diff, and the 27-tool MCP surface is
   the primary product.*

2. **Stay Apache-2.0 end-to-end, with every transitive runtime
   dependency on the permissive allowlist.** *Because CI already
   enforces the allowlist (Apache-2.0 / MIT / BSD / ISC / CC0 /
   BlueOak / 0BSD), scanner license incompatibilities (hadolint GPL,
   tflint MPL/BUSL) are resolved by subprocess-only invocation, and the
   README explicitly frames this as a fork-and-embed posture.*

3. **Keep the index local, offline-capable, and deterministic.**
   *Because `--offline` is asserted to open zero sockets, `graphHash`
   must be byte-identical across full and incremental runs at the same
   commit, and `scripts/acceptance.sh` gate 6 gates on exactly that
   invariant.*

4. **Cover the 14 GA languages with tree-sitter and upgrade four of
   them (Python, TS/JS, Go, Rust) with real LSP oracles.** *Because
   heuristic call-graph edges miss cross-module resolution, the
   `confidence-demote` phase already exists to reconcile heuristic and
   compiler-grade edges, and the gym harness gates per-language F1.*

## Quality bar

5. **Hold a three-layer regression gate on every eval and gym run.**
   *Because the gym's absolute-F1-floor + relative-F1-delta + per-case
   non-regression layering is baked into the harness, and acceptance
   gate 9 requires ≥ 40/49 Python-eval cases to pass — soft regressions
   are not an option.*

6. **Fail CI on any non-zero exit.** *Because `pnpm run check` chains
   lint → typecheck → test → banned-strings and exits on first
   failure, CI runs the same chain plus OSV, CodeQL, Scorecard, SARIF
   schema validation, commitlint, and license allowlist — with the
   banned-strings sweep enforcing clean-room IP hygiene.*

7. **Keep the MCP server responses structured, versioned, and
   self-describing.** *Because every tool must return a `next_steps`
   array, a `_meta["codehub/staleness"]` envelope when the index lags
   HEAD, and a typed error code (e.g. `AMBIGUOUS_REPO`) rather than
   free-form failure strings — this is what makes the tools safe for
   automated agent loops.*

## Non-goals

8. **Do not operate a server or SaaS.** *Because DuckDB is embedded,
   the MCP server is a stdio process, and ADR 0001 explicitly rejects
   engines that would require a daemon; the product is a CLI + MCP
   server, not a hosted product.*

9. **Do not port to Rust before it's needed.** *Because ADR 0002
   measured p95 single-file incremental at 195-250ms on the 100-file
   fixture (well under the 1s hard gate) and extrapolates cold 100k-LOC
   analyze to 3-5 seconds — Rust is deferred to v2.1+ with explicit
   re-trigger conditions tied to measured latency on user repos.*

## Measurable outcomes

10. **A user can go from `git clone` to a wired MCP server to their
    agent calling `impact`, `detect_changes`, and `rename` on a real
    repo in a single quick-start sequence (`mise install` →
    `pnpm install --frozen-lockfile` → `codehub setup` →
    `codehub analyze`), with acceptance gates 1-8 confirming the happy
    path and gates 10-15 confirming the opt-in paths (embeddings,
    scanners, SARIF validation, license audit, verdict).** *Because
    that end-to-end flow is what the README promises and what
    `scripts/acceptance.sh` verifies; everything else rolls up to it.*
