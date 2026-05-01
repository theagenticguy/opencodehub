---
title: Scanners and SARIF
description: Two scanner tiers, how SARIF enrichment preserves GHAS dedup, and how the findings baseline bucketizes new versus fixed versus unchanged results.
sidebar:
  order: 40
---

Scanners are a tier-one MCP surface: the `scan` tool is the only tool
that spawns processes (`openWorldHint=true`) and the only tool that is
non-idempotent. SARIF is the on-disk exchange format. This page
covers the catalog, the license distinction between bundled and
wrapped tools, how SARIF enrichment stays GHAS-compatible, and how
baseline diffs get bucketized.

## Scanner tiers

The catalog at `packages/scanners/src/catalog.ts` is a flat module:
one exported `ScannerSpec` per tool plus three aggregate arrays.
Selection is driven by the project profile (languages, IaC types, API
contracts) and can be overridden with an explicit scanner list.

### Priority-1 (11 scanners)

Always considered for a default scan; each one is gated on the
project's detected languages.

- **semgrep** — multi-language static analysis, rule packs for common
  bugs and insecure patterns.
- **betterleaks** — secret scanner, permissive license.
- **osv-scanner** — vulnerability scan against the OSV database
  keyed on lockfiles.
- **bandit** — Python static security analyzer.
- **biome** — JS/TS formatter and linter in one binary.
- **pip-audit** — Python dependency vulnerability audit.
- **npm-audit** — npm dependency vulnerability audit.
- **ruff** — Python lint + format.
- **grype** — container image and filesystem vulnerability scanner.
- **checkov-docker-compose** — IaC policy scan scoped to
  docker-compose files (kept in P1 for every repo with a compose file).
- **vulture** — Python dead-code detection.

### Priority-2 (8 scanners)

Opt-in or gated by profile fields beyond language:

- **trivy** — broader container / IaC / SBOM scanner.
- **checkov** — full IaC policy coverage (Terraform, Kubernetes,
  CloudFormation, Helm).
- **hadolint** — Dockerfile lint. Invoked as a subprocess only
  (license note below).
- **tflint** — Terraform lint. Subprocess-only.
- **spectral** — OpenAPI / AsyncAPI contract lint.
- **radon** — Python complexity / maintainability metrics.
- **ty** — Python type checker.
- **clamav** — malware scan. Carries the `opt-in` flag so it is
  excluded from every default gate; explicit `scanners: ["clamav"]`
  turns it on.

## License-incompatible wrappers

hadolint (GPL-3.0) and tflint (MPL-2.0 + BUSL-1.1 depending on vendor
build) are not on the permissive license allowlist. OpenCodeHub still
supports them the same way it supports any other scanner: **wrap,
don't link**.

Concretely:

- `packages/scanners/src/wrappers/hadolint.ts` and `.../tflint.ts`
  spawn the OS binary, capture stdout as SARIF, and emit findings.
- The binary is a user-provided runtime dependency. OpenCodeHub does
  not bundle it, ship it, or require it at install time.
- License obligations flow to the user who installed the scanner,
  not to OpenCodeHub.

This is the same pattern GitHub CodeQL uses with third-party SARIF
producers. See [Supply chain](/opencodehub/architecture/supply-chain/)
for the broader policy.

A missing binary yields an empty SARIF run, not a crash — the catalog
is built to degrade gracefully when a wrapper's tool is not installed.

## SARIF emission

`@opencodehub/sarif` owns the schema, merge, enrichment, suppressions,
and baseline logic. Every scanner run produces SARIF v2.1.0,
zod-validated against the spec.

### Rule IDs and fingerprints

Two fingerprints are computed per result, under
`properties.opencodehub.*`:

- `opencodehub/v1` — `sha256(scannerId \0 ruleId \0 filePath \0
  contextHash)[:32]`. The match key for baseline diffing.
- `primaryLocationLineHash` — `sha256(ruleId \0 filePath \0
  normalizedSnippet)[:16] + ":" + startLine`. The GHAS dedup key.

**Invariant:** `result.fingerprints`, `partialFingerprints`, `ruleId`,
and `artifactLocation.uri` are never mutated by enrichment. All
enrichment goes under `properties.opencodehub.*`. This is how SARIF
output stays GHAS-compatible — GitHub's deduplication on
`primaryLocationLineHash` still works.

### Enrichment fields

`enrichWithProperties` adds graph-derived context to each result:

- `blastRadius` — dependent count from `impact`.
- `community` — the containing Louvain community.
- `cochangeScore` — temporal co-change coefficient.
- `centrality` — node centrality.
- `temporalFixDensity` — how often this file has been a fix target.
- `busFactor` — unique recent authors.
- `cyclomaticComplexity` — McCabe complexity of the enclosing
  function.
- `ownershipDrift` — recent change in top contributor.

### Suppressions

Two paths, same output:

- **External YAML** — `.codehub/suppressions.yaml` declares
  `{ruleId, filePathPattern, reason, expiresAt?}`.
- **Inline comment** — `// codehub-suppress: <ruleId> <reason>` (or
  `#`, `/* */` variants) in source.

Both write to `result.suppressions[]` with `{kind:
"external"|"inSource", justification}`. Suppressions past their
`expiresAt` are dropped at load with a warning, so `codehub verdict`
can re-block the finding.

## Findings baseline and delta

Two SARIF files on disk:

- `.codehub/scan.sarif` — the current scan.
- `.codehub/baseline.sarif` — the frozen baseline written by
  `codehub scan --baseline`.

`list_findings_delta` reads both and runs `diffSarif`. The match key
is the `opencodehub/v1` partial fingerprint, with a fallback to
`(ruleId, uri, startLine)` when the fingerprint is missing. Rename
follow-through is optional: if the storage layer supplies a
`renameChainFor` resolver (backed by `FileNode.renameHistoryChain`
from the temporal phase), a finding that followed a rename still
matches.

Four buckets:

| Bucket      | Meaning                                                  |
|-------------|----------------------------------------------------------|
| `new`       | In current, not in baseline.                             |
| `fixed`     | In baseline, not in current.                             |
| `unchanged` | Same fingerprint, same contextHash.                      |
| `updated`   | Same fingerprint, changed line / snippet.                |

When the current SARIF already carries baked-in `baselineState` tags
(written by `codehub scan --baseline`), `list_findings_delta` reuses
them instead of re-running the diff — the on-disk SARIF is the source
of truth.

## The `scan` tool

`scan` is deliberately the odd one out. Annotations:

```
readOnlyHint:   false
destructiveHint: false
openWorldHint:  true       // spawns subprocesses
idempotentHint: false       // writes disk, state-changing
```

The tool picks scanners via `selectScanners()`, which honors an
explicit list or falls back to profile-gated defaults. Concurrency is
clamped to `min(availableParallelism(), opts.concurrency ?? 4)`. A
per-wrapper failure does not abort the run — it just omits that
scanner's results from the merged SARIF.

The merged SARIF is persisted to `.codehub/scan.sarif`; a summary
groups result counts by `tool.driver.name` and `result.level`
(defaulting to `note` when the scanner omits the level).

## Configuration knobs

- `ScanInput.timeoutMs` — per-scanner timeout (default 300_000, max
  600_000).
- `ScanInput.scanners` — explicit id list overrides profile gating.
- `ProjectProfileGate.languages / iacTypes / apiContracts` — stored
  in `nodes WHERE kind='ProjectProfile'`; drives default selection.
- `.codehub/suppressions.yaml` — external suppression rules.

## Related

- [`scan` tool reference](/opencodehub/mcp/tools/) —
  the full input schema.
- [`list_findings` tool reference](/opencodehub/mcp/tools/)
  — querying findings stored as nodes.
- [Supply chain](/opencodehub/architecture/supply-chain/) — why
  subprocess invocation is the right pattern for non-permissive
  scanners.
