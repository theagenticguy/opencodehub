# ADR 0002 — Rust core spike deferred to v2.1+

**Status**: Accepted, 2026-04-20
**Context**: v2.0 time-boxed Rust NAPI-RS spike.

## Decision

Defer a Rust NAPI-RS native core to v2.1+. OpenCodeHub v2.0 ships pure TypeScript.

## Context

The PRD M3 trigger for a Rust core was clear: "indexing > 30s on 100k LOC with incremental cache". The active incremental-carry-forward mode landed with the following measured perf characteristics on in-repo fixtures:

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

## 2026-04-24 — P09 Phase 1 re-evaluation

Re-ran the trigger benchmarks against the OpenCodeHub repo itself via
`packages/gym/scripts/bench-rust-triggers.mjs` (5 cold runs of `codehub
analyze . --force --skip-agents-md --no-summaries`, wrapped in
`/usr/bin/time -l`). Full report at `bench/rust-spike-report.md`.

**Measured values (n=5, darwin arm64, Node v22.22.0):**

| Metric | Value |
|---|---|
| p95 wall-clock | 170,988 ms (~171 s) |
| min / mean / max wall-clock | 152,411 / 162,293 / 170,988 ms |
| Mean peak RSS | 973 MB |
| Parse throughput | ~7 files/sec (1,084 files) |
| HNSW build time | N/A (embeddings flag off — embedder weights not staged) |
| Graph size | 23,185 nodes / 63,103 edges |

**Per-trigger evaluation:**

1. **Cold full analyze on a 500k+ LOC repo > 4 min** — *not fired*. This
   fixture is 1,084 files, orders of magnitude below the 500k-LOC
   threshold; the trigger is structurally incapable of firing here. Even
   the p95 of 171 s on this repo is under the 240 s threshold *if one
   applied it literally* (we do not — the threshold is scoped to 500k+
   LOC repos).
2. **p95 single-file incremental edit on a 10k+ file fixture > 30 s** —
   *not fired*. This bench measures cold full analyze, not incremental
   edits. The prior measurements cited in this ADR (~195–250 ms on the
   100-file fixture) remain the authoritative data point for the
   incremental path; nothing has regressed.
3. **`--cpu-prof` shows > 40% of wall-clock in a single hot-path
   function** — *not fired*. No `--cpu-prof` capture was run as part of
   this re-evaluation; without the evidence, the trigger does not fire
   by default. Re-open this trigger only when a production-scale profile
   is available.

**Decision: Defer — re-evaluate after next major feature wave.**

No ADR 0002 trigger has fired. OpenCodeHub stays pure TypeScript. No
Rust crate, no napi-rs setup, no CI workflow changes, no ingestion /
worker-pool / storage modifications. The spike remains closed and will
be reconsidered at the next feature-wave boundary — in particular after
P03 (hierarchical embeddings) lands and changes the embeddings hot path,
which would otherwise over-fit any Rust baseline measured today.

Sign-off: Phase 1 executed per SPECS.md; benchmark report committed
alongside this ADR; no Phase 2 work undertaken.

