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

## Scanner inventory (19)

The catalog at `packages/scanners/src/catalog.ts` is a flat module:
one exported `ScannerSpec` per tool plus aggregate arrays. Selection
is driven by the project profile (languages, IaC types, API contracts)
and can be overridden with an explicit `scanners` list on the `scan`
tool. The current inventory is **19 scanners** — `detect-secrets` was
removed in favour of `betterleaks`, which ships 276 default rules and
a CEL-filtered `generic-api-key` catch-all that subsumes the older
tool's entropy + keyword detectors.

| Scanner | Scope |
|---|---|
| `semgrep` | Multi-language static analysis. |
| `betterleaks` | Secrets — 276 rules + entropy + CEL filters. |
| `osv-scanner` | Lockfile vulnerability scan against OSV. |
| `bandit` | Python static security. |
| `biome` | TS/JS lint + format. |
| `pip-audit` | Python dependency CVE scan. |
| `npm-audit` | npm dependency CVE scan. |
| `ruff` | Python lint + format. |
| `grype` | Container image + filesystem vulnerability scan. |
| `checkov-docker-compose` | IaC policy — docker-compose. |
| `vulture` | Python dead-code detection. |
| `trivy` | Container / IaC / SBOM scanner. |
| `checkov` | IaC policy — Terraform, Kubernetes, CloudFormation, Helm. |
| `hadolint` | Dockerfile lint (subprocess-only — see license note). |
| `tflint` | Terraform lint (subprocess-only). |
| `spectral` | OpenAPI / AsyncAPI contract lint. |
| `radon` | Python complexity + maintainability metrics. |
| `ty` | Python type checker. |
| `clamav` | Malware scan — opt-in only. |

A 21st scanner — `och self-scan` — is integrated through the OCH
graph itself (dead code, orphan symbols, group-level findings) and
runs as a CI workflow rather than through the `scan` tool.

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
