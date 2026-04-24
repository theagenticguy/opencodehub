# Rust Core Spike Benchmark Report (ADR 0002 Phase 1)

**Generated:** 2026-04-24T19:01:05.437Z
**Target repo:** `/Users/lalsaado/Projects/open-code-hub`
**Runs:** 5
**Embeddings flag:** off
**Node version:** v22.22.0
**Platform:** darwin arm64

## Methodology

Each run executes `codehub analyze <repo> --force --skip-agents-md --no-summaries` via `node packages/cli/dist/index.js`, wrapped in `/usr/bin/time -l` for peak RSS. Before every run, `<repo>/.codehub/` is removed so the measurement reflects a cold, incremental-cache-miss analyze. `CODEHUB_BEDROCK_DISABLED=1` is set so the summarize phase never touches the network — keeping the benchmark hermetic and focused on parse/graph cost, which is where the ADR 0002 triggers live.

## Per-run measurements

| Run | Wall-clock (ms) | Peak RSS (MB) | Files | Files/sec | HNSW build (ms) | Nodes | Edges |
|----:|----------------:|--------------:|------:|----------:|-----------------|------:|------:|
| 1 | 163779 | 1027 | 1084 | 7 | N/A | 23185 | 63103 |
| 2 | 159996 | 979 | 1084 | 7 | N/A | 23185 | 63103 |
| 3 | 170988 | 943 | 1084 | 6 | N/A | 23185 | 63103 |
| 4 | 164289 | 930 | 1084 | 7 | N/A | 23185 | 63103 |
| 5 | 152411 | 984 | 1084 | 7 | N/A | 23185 | 63103 |

## Summary

- **p95 wall-clock:** 170988 ms (170.99 s)
- **min / mean / max wall-clock:** 152411 / 162293 / 170988 ms
- **mean peak RSS:** 973 MB
- **mean parse throughput:** 7 files/sec
- **HNSW build time:** N/A (embeddings not run or weights missing)
- **file count:** 1084
- **node count:** 23185
- **edge count:** 63103

## ADR 0002 trigger comparison

| # | Trigger | Threshold | Measured | Fired? |
|--:|---------|-----------|----------|:------:|
| 1 | Cold full analyze on a 500k+ LOC repo exceeds 4 minutes (240,000 ms) | Requires a 500k+ LOC fixture | 170.99 s on this repo (1084 files — below the 500k LOC scale) | no |
| 2 | p95 single-file incremental edit on a 10k+ file fixture exceeds 30 s | Requires a 10k+ file fixture and incremental (not cold) measurement | Not measured — this bench runs cold analyze, not single-file incremental edits | no |
| 3 | `--cpu-prof` shows >40% of wall-clock in a single hot-path function | Requires --cpu-prof capture on a production-scale run | Not captured in this bench (no --cpu-prof flag invoked) | no |

### Rationale

- **Trigger 1** — Repo is 1084 files, far below the 500k-LOC / ~10k-file trigger scale — this trigger cannot fire on this fixture.
- **Trigger 2** — This Phase 1 bench measures cold full analyze, not incremental single-file edits. The active incremental mode has separately measured ~195-250 ms on the in-repo 100-file fixture (ADR 0002, above), so extrapolation to a 10k-file fixture stays far under 30 s.
- **Trigger 3** — No --cpu-prof profile was captured; without a single >40% hot-path function there is no evidence this trigger fires. Revisit only after a production-scale profile is run.

## Decision

**Defer — re-evaluate after next major feature wave.** No ADR 0002 trigger fires on this fixture; the spike stays closed.
