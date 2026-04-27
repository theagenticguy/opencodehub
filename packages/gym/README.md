# @opencodehub/gym

Differential SCIP indexer evaluation harness. Verifies that each language's SCIP indexer (scip-typescript, scip-python, scip-go, rust-analyzer, scip-java) produces reference graphs consistent with pinned goldens, and gates on regressions.

## Layout

```
packages/gym/
  src/                # harness, manifest, metrics, gates, CLI
  test/               # unit tests (pair with src/*.test.ts convention)
  corpus/
    python/           # .yaml goldens (commit-pinned)
    typescript/
    go/
    rust/
    monorepo/         # cross-language fixtures
    repos/            # fixture git submodules pinned to specific SHAs
  manifests/          # freeze/replay JSONL — current run output
  baselines/          # last-green manifest + performance baselines
  reference/          # motivating papers and spikes
```

## Metrics

- **Edge-level P/R/F1** — primary gate per language.
- **Jaccard** on result sets — secondary.
- **Kendall tau** on ranked outputs — for rank-sensitive cases only.

Deterministic oracles (SCIP indexers) do not use judge-panel / Fleiss kappa — see `reference/metric-choice.md`.

## Three-layer regression gate

1. Absolute F1 floor per language (configurable in `baselines/thresholds.json`).
2. Relative F1 delta vs last-green baseline.
3. Per-case non-regression — previously green cases must stay green unless `waived: true`.

## Freeze/replay manifest

Every run emits a JSONL manifest pinning `{manifest_version, corpus_commit, tool: {name, version, sha256}, request, result_set, captured_at}`. Enables bit-exact replay by re-invoking the SCIP indexer at the pinned version — no language-server daemon is spawned.

## Submodule pin protocol

Fixture repos live under `corpus/repos/<lang>/<name>/` as git submodules. Pinned commits are authoritative — corpus YAMLs carry the matching SHA. Updating a fixture:

1. `git submodule update --remote corpus/repos/<lang>/<name>`
2. Re-run `mise run gym:baseline` to regenerate goldens against the new SHA.
3. Run `uv run packages/gym/baselines/scripts/refresh-expected.py packages/gym/baselines/manifest.jsonl` to refresh the corpus `expected:` sets.
4. Review the diff in the next PR.
