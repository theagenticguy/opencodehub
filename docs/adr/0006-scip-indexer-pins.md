# ADR 0006 — SCIP indexer CI pins

- Status: accepted
- Date: 2026-04-27
- Authors: @theagenticguy + Claude
- Branch: `feat/scip-replaces-lsp`

## Context

After ADR 0005 migrated the code-graph oracle from LSP language servers
to SCIP indexers, the CI pin table in ADR 0003 (gopls ↔ Go) is no
longer load-bearing. The gym workflow (`.github/workflows/gym.yml`)
now installs one SCIP indexer per language and runs it against a
per-language fixture corpus. Each indexer has its own version cadence
and toolchain requirements.

This ADR pins the current versions, documents why each one, and records
the bump procedure so the next bump is a one-PR change instead of a
multi-day scavenger hunt.

## Decision — pin table (2026-04-27)

| Language   | Indexer            | Version tag              | Install channel                                           |
|------------|--------------------|--------------------------|-----------------------------------------------------------|
| TypeScript | scip-typescript    | 0.4.0                    | `npm install -g @sourcegraph/scip-typescript@<version>`   |
| Python     | scip-python        | 0.6.6                    | `npm install -g @sourcegraph/scip-python@<version>`       |
| Go         | scip-go            | v0.2.3                   | `go install github.com/scip-code/scip-go/cmd/scip-go@<v>` |
| Rust       | rust-analyzer      | stable component         | `rustup component add rust-analyzer`                      |
| Java       | scip-java          | 0.12.3                   | `coursier install scip-java` (future: installed on demand) |

The versions are mirrored in `.github/workflows/gym.yml` env block and
in `packages/gym/baselines/performance.json` so the regression harness
has a single source of truth.

### Why scip-go resolves to the scip-code fork

The Go module name migrated mid-2025 from
`github.com/sourcegraph/scip-go` to `github.com/scip-code/scip-go`;
the go.mod at upstream declares the new path. `go install
github.com/sourcegraph/...` fails with a module-path mismatch even
though the GitHub repo still resolves. We install from the canonical
path (`github.com/scip-code/scip-go/cmd/scip-go`). Noted so the next
contributor does not spend an afternoon on the error.

### rust-analyzer is rustup-sourced, not pinned by tag

`rust-analyzer scip` is a built-in subcommand shipped with the
rust-analyzer component, which bumps every Monday off of master. Since
rust-analyzer's SCIP output shape is stable across these weekly bumps
(it has been unchanged since 2024), we track `rustup component add
rust-analyzer` against the stable toolchain. If a regression lands, we
can pin to an explicit `release-YYYY-MM-DD` tag via
`dtolnay/rust-toolchain@1.XX` + manual component install.

### scip-java is optional in CI

Java coverage is a stretch goal for OpenCodeHub's first SCIP release.
The gym workflow does not install `scip-java` today (no corpus), but
the runner and CI pin table are pre-wired so a follow-up PR only needs
to drop a `java/<fixture>.yaml` corpus + a single install step.

## Bump procedure

1. **Update env block** in `.github/workflows/gym.yml`:
   - `SCIP_TYPESCRIPT_VERSION`, `SCIP_PYTHON_VERSION`, `SCIP_GO_VERSION`,
     or `SCIP_JAVA_VERSION`.
2. **Regenerate the baseline manifest**:
   ```bash
   # Install the new indexer locally at the target version.
   # Then:
   mise run gym:baseline
   # (wraps `node packages/gym/dist/cli.js baseline --corpus ...`)
   ```
3. **Refresh the corpus `expected:` sets** by replaying the new
   manifest into each YAML. A utility Python/TS script that walks the
   new `manifest.jsonl` and rewrites each case's `expected` list lives
   in `packages/gym/baselines/scripts/refresh-expected.py`.
4. **Update `performance.json`** toolchain section.
5. **Run `pnpm run check && node packages/gym/dist/cli.js run ...`**
   locally against each fixture to make sure the F1 gates pass.
6. **Open the PR**. The gym matrix in CI will re-validate every cell
   against the refreshed baseline.

## Consequences

### Positive

- The gym workflow is self-documenting: the env block names every
  indexer + version at the top of `gym.yml`.
- `ADR 0003`'s gopls pin matrix is obsolete; a single env variable
  replaces the Go-toolchain ↔ gopls compatibility table.
- Java coverage is a one-PR addition when the fixture lands.

### Negative

- rust-analyzer's unpinned channel means a rustup bump can introduce a
  silent baseline drift. Mitigation: the gym's `f1DeltaTolerance`
  gate catches the drift in the PR that bumps the channel. If we see
  repeated drift we'll explicitly pin.
- scip-java currently needs Coursier on the runner image; GitHub's
  `ubuntu-latest` has it, but if we ever move to a minimal image we
  need to install Coursier first. Not a blocker today.

## Related

- ADR 0005: SCIP replaces LSP (migration rationale)
- ADR 0003: (obsoleted by this ADR; kept for history)
