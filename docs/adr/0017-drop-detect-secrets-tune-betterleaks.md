# ADR 0017 — Drop detect-secrets; ship a tuned betterleaks default config

- Status: **Accepted** — 2026-05-16.
- Authors: Laith Al-Saadoon + Claude.
- Branch: `chore/scanners-dedup-and-tune`.
- Supersedes: the "20th scanner" decision in
  [ADR 0010](./0010-dogfood-findings-2026-04-27.md) (PR #72).

## Context

`codehub analyze` ran two parallel secret scanners — `betterleaks`
(Go, gitleaks fork) and `detect-secrets` (Python, Yelp). Three problems
showed up in dogfood runs:

1. **Wall-clock cost.** detect-secrets is a single-process Python
   walker; on the OCH repo it took 5+ minutes and sometimes timed out
   at the 300 s ceiling. It was the long pole of every analyze run.
2. **The betterleaks integration was broken.** The wrapper passed
   `--report-path=/dev/stdout`, which fails inside Node's `execFile`
   with `ENXIO` because the child's fd 1 is a pipe, not a char device.
   Betterleaks logged the failure to stderr, emitted nothing to stdout,
   and the wrapper guard turned that into an empty SARIF. detect-secrets
   was effectively the only working secret scanner.
3. **18,893 findings on the OCH self-scan**, the vast majority noise:
   detect-secrets' generic Base64HighEntropy / KeywordDetector flagged
   integrity hashes in `pnpm-lock.yaml`, hash strings in
   `.cdx.json` SBOMs, fixture data, build outputs.

A coverage audit (Context7 + DeepWiki on
`github.com/betterleaks/betterleaks` + the upstream `betterleaks.toml`)
confirmed betterleaks ships **276 default rules** vs detect-secrets'
~24, including a CEL-filtered `generic-api-key` catch-all that subsumes
detect-secrets' high-entropy + keyword detectors. The only detector
unique to detect-secrets is `IPPublicDetector` (low value, high FP), and
a handful of named IBM-flavoured rules that fall through to
`generic-api-key` on betterleaks.

## Decision

1. **Remove detect-secrets entirely.** Wrapper, converter, catalog spec,
   index switch case, P1 list, tests, README rows, docs ADR refs,
   pre-release-gate workflow step, and the in-tree `.secrets.baseline`
   file. detect-secrets' threat coverage is a strict subset of
   betterleaks for the OCH use case.

2. **Fix the betterleaks wrapper.** Two changes:
   - `--report-path=/dev/stdout` → `--report-path=-`. The dash is
     betterleaks' explicit "write SARIF to stdout" idiom and works
     under `execFile`.
   - Use `dir` mode unconditionally. `git --pre-commit=false` walks the
     entire git log and re-flags every secret that ever existed in any
     historical commit, which is wrong for a working-tree-state scan.
     `dir` mode reflects the current checkout, matching what
     `codehub analyze` actually wants. Cost: `dir` mode does not honor
     `.gitignore`, so the path filtering moves into the config.

3. **Ship a vendored default config** at
   `packages/scanners/config/betterleaks.default.toml`. It uses
   `[extend] useDefault = true` to inherit the 276 upstream rules and
   then layers `[[allowlists]]` blocks that filter findings on:
   - Vendored deps (`node_modules`, `.venv`, `vendor`, `Pods`, etc.).
   - Build outputs (`dist`, `build`, `target`, `.next`, `coverage`).
   - Lockfiles (`pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, etc.).
   - Generated SBOM / SARIF / `.codehub` artifacts.
   - Binary blobs (`.parquet`, `.wasm`, `.so`, `.png`, `.pdf`).
   - Test files (`*.test.ts`, `_test.go`, `test/`, `__fixtures__/`).
   The wrapper auto-detects user-supplied `betterleaks.toml` /
   `.gitleaks.toml` at the project root and only injects the vendored
   config when none is present, so user customisation wins.

4. **Update the pre-release CI gate** to run `betterleaks dir` against
   the vendored config, with `--exit-code=1` so any new finding fails
   the gate. Replaces the previous `detect-secrets scan --baseline`
   step.

## Outcomes (measured on the OCH self-scan)

| Metric | Before | After | Delta |
|---|---|---|---|
| Wall clock (`codehub analyze .`) | 12:39 | 5:35 | **−56%** |
| Total scanner findings | 18,893 | 45 | **−420×** |
| Betterleaks findings | 0 (broken) | 0 (clean) | n/a |
| Scanner inventory size | 20 | 19 | −1 |

The remaining 45 are all signal: 26 grype CVEs, 12 vulture dead-code
flags, 3 ruff lint, 3 radon complexity, 1 biome.

## Tradeoffs

- **`.gitignore` is no longer a filter for secret scans.** `dir` mode
  walks every file the OS shows. The vendored `[allowlists]` is broad
  but not exhaustive; users with unusual layouts may need to extend
  the config. Accepted: the upside (working-tree-state scans, not
  history audits) is the right default for analyze.
- **Loss of named-rule attribution for IBM Cloudant / IAM / COS /
  SoftLayer.** Those collapse into `generic-api-key`. Detection still
  happens; only the SARIF `ruleId` changes. Acceptable for the OCH
  use case (open-source code repos, no enterprise-IBM credential
  leaks expected).
- **Loss of `IPPublicDetector`.** Public-IP-as-leak is a high-FP, low-
  value heuristic; not worth keeping detect-secrets to retain it.

## Migration

Existing users with a `.secrets.baseline` file at their project root
should delete it (no longer consumed). Any project-level overrides
should move to a `betterleaks.toml` at the project root, which the
wrapper will pick up automatically and use instead of the vendored
default. The vendored config is published with the
`@opencodehub/scanners` npm package under `config/` and is read at
runtime via `import.meta.url` resolution.
