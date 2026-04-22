# ADR 0002 — Rust core spike deferred to v2.1+

**Status**: Accepted, 2026-04-20
**Context**: v2.0 Stream R time-boxed Rust NAPI-RS spike.

## Decision

Defer a Rust NAPI-RS native core to v2.1+. OpenCodeHub v2.0 ships pure TypeScript.

## Context

The PRD M3 trigger for a Rust core was clear: "indexing > 30s on 100k LOC with incremental cache". Stream L (W2.incremental-active) landed active incremental mode with the following measured perf characteristics on in-repo fixtures:

- p95 single-file edit on 100-file fixture: ~195-250ms (well under the 1s hard gate).
- Closure-empty incremental run (carry-forward path): ~195ms — Leiden + BFS skipped entirely.
- Full analyze on the 100-file fixture: ~200ms.
- Full vs incremental `graphHash` byte-identical at the same commit (new determinism CI gate).

The cold-run latency on a synthetic 100k-LOC fixture is extrapolated from these numbers at roughly 3-5 seconds (file-count scaling via closure-walker + parse worker pool), well below the 30-second trigger. Without a confirmed bottleneck, porting to Rust would be speculative optimization.

## Consequences

**Kept**:
- 100% TypeScript runtime. No NAPI-RS build matrix complications (musl, Windows x86/arm, macOS x64/arm).
- No Cargo.toml, no Rust toolchain dependency for contributors.
- Determinism gate unchanged: no cross-language hash validation needed.
- Apache-2.0 dependency audit surface stays TypeScript-only.

**Deferred**:
- Native-speed parse worker dispatch (would matter if cold index on a 1M+ LOC monorepo lands outside the 30s bar).
- Native-speed cross-file Tarjan SCC (would matter if a repo's call-graph density explodes to 100k+ edges per file).

## Trigger for revisiting

Reopen this ADR if ANY of these measurements surface:

1. Cold full analyze on a user-reported 500k+ LOC repo exceeds 4 minutes.
2. p95 single-file incremental edit on a 10k+ file fixture exceeds 30 seconds.
3. `--cpu-prof` on a production-scale run shows >40% of wall-clock time in a single hot-path function (parse dispatch, SCC, ACCESSES emitter).

Prior to greenlight:
- Port ONE function (not a rewrite).
- Require: graphHash byte-identical across Rust and TS feature-flag toggle in CI.
- Keep TS path always functional (Rust via optional `postinstall` prebuild download).
- Cap source-size growth at 2x the equivalent TS module.

