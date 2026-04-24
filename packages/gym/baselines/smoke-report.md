# E2E Smoke + Runtime Baselines

**Measured**: 2026-04-23 (UTC 22:00)
**Host**: darwin 25.4.0 / arm64
**Toolchain**: Node v22.22.0 · pyright 1.1.408 · typescript-language-server 5.1.3 · gopls 0.21.1 · rust-analyzer 1.94.1 (2026-03-25)
**Total wall clock across all fixtures**: 265 s (4 min 25 s) — well inside the 10 min budget.

## Per-fixture results

| Fixture | Language | Wall (s) | Peak RSS (MB) | Nodes | Edges | LSP edges | Heuristic | Demoted | Gym smoke |
|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|
| sdk-python | python | — | — | — | — | — | — | — | skipped |
| ts-pattern | typescript | 70.8 | 452 | 2868 | 4666 | 88 | 176 | 1 | pass |
| cobra | go | 26.7 | 818 | 1184 | 7591 | 4005 | 150 | 14 | pass |
| thiserror | rust | 56.1 | 457 | 555 | 1624 | 105 | 67 | 0 | pass |
| electron-ws-python | monorepo (py+ts) | 63.9 | 191 | 133 | 209 | 28 | 0 | 0 | pass |

"LSP edges" = `confidence = 1.0` and `reason LIKE '%@%'` (LSP-sourced). "Heuristic" = `confidence = 0.5`. "Demoted" = `confidence = 0.2`.

"Gym smoke" = `codehub-gym run --language <lang>` against each fixture's corpus exits 0. Pass means the runner executed, not that F1 scores meet production targets (see below).

**sdk-python skipped** because the git submodule under `packages/gym/corpus/repos/python/sdk-python` is not initialized in this working tree. Per the task rubric the runner treats that as a skip (not an error) and records `skipped: true` with a reason in `performance.json`. Initializing the submodule is out of scope for a baseline pass (500+ files, multi-minute fetch + analyze).

## Observations

- **rust-analyzer `ownership` phase dominates thiserror**. The `ownership` phase spent **42.3 s** on thiserror — 75 % of the fixture's wall clock, far larger than the LSP phase itself (10.9 s). That phase is not language-specific, which is suspicious given how small thiserror is (555 nodes). Flagged for investigation; no fix in this change.
- **Go edges are LSP-dominated**. Cobra produces 4005 LSP edges out of 7591 total (53 %) — gopls is fast (22.6 s lsp-go phase on 40k LOC) and precise. Conversely, thiserror's rust-analyzer phase yields only 105 LSP edges against 67 heuristic edges, reflecting rust-analyzer's narrower coverage of cross-module calls on an untouched cargo workspace.
- **typescript-language-server `$/progress end` timeouts are routine**. Both the ts-pattern and monorepo runs logged `typescript-language-server did not emit $/progress end within 15000ms; proceeding` — the ingestion phase falls through without losing work, but the timeout explains why lsp-typescript ran 66 s on ts-pattern.
- **Monorepo fixture works without `pnpm install`**. The electron-ws-python fixture declares deps but never installs them, yet both pyright (0.7 s) and typescript-language-server (61.7 s) produced a graph with 28 LSP edges and the pyright callers/references goldens hit F1 = 1.0. The TS-callers case is where monorepo coverage is thinnest (F1 = 0.571, 2 cases).
- **Gym differential scores are below production thresholds for go/rust callers + implementations**. Cobra hits F1 = 0.048 on references and 0.0 on callers / implementations; thiserror shows the same pattern (F1 = 0.947 references, 0.0 callers / implementations). These are existing, known gaps in the oracle goldens — out of scope for this task, but flagged so the next round of corpus tuning knows where to focus.

## Regression watch

- **`ownership` phase on thiserror (42.3 s)** is the only phase that is >2× any reasonable naive expectation. The same phase ran in 1.0 s on ts-pattern, 0.9 s on cobra, and 0.8 s on electron-ws-python — the outlier behavior is specific to thiserror and deserves a dedicated investigation.
- **RSS on cobra (818 MB)** is ~2× the next-highest fixture. gopls is the likely driver given the phase timings, but the 0.21.1 release is current — cap size or prune options may help.
- `lsp-typescript` on the monorepo (61.7 s) is inflated by the `$/progress end` timeout. Worth considering dropping the timeout to 5 s so the smoke cycle tightens; no correctness impact.

## Verdict

End-to-end pipeline is smoke-clean across four fixtures (one language skipped for scope). Runtime baselines locked in `performance.json`. One suspicious phase (`ownership` on thiserror) flagged for follow-up. Ready to lock as a baseline; regression gates can now reference these numbers.
