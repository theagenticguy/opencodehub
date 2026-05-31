# @opencodehub/sarif

SARIF v2.1.0 helpers for OpenCodeHub. Merges, enriches, fingerprints,
baseline-diffs, and suppresses SARIF outputs from multiple scanners into a
single canonical result set. Validation is done with `zod` (the public
shapes are pinned to SARIF version `2.1.0`); there is no JSON-schema
validator and no `ajv` dependency.

## Surface

```ts
import {
  mergeSarif,
  enrichWithProperties,
  enrichWithFingerprints,
  diffSarif,
  applyBaselineState,
  loadSuppressions,
  applySuppressions,
  isSuppressed,
} from "@opencodehub/sarif";

// 1. Concatenate scanner outputs into one log.
const merged = mergeSarif([semgrepSarif, betterleaksSarif, osvSarif]);

// 2. Add `opencodehub/v1` + `primaryLocationLineHash` partial fingerprints.
const fingerprinted = enrichWithFingerprints(merged);

// 3. Attach graph-derived signals under `properties.opencodehub.*`.
const enriched = enrichWithProperties(fingerprinted, {
  byResultIndex: new Map([[0, { blastRadius: 12, centrality: 0.4 }]]),
  run: { enrichedAt: new Date().toISOString(), enrichmentVersion: "1" },
});

// 4. Diff against a baseline and tag `result.baselineState`.
const diff = diffSarif(baselineSarif, enriched);
const tagged = applyBaselineState(enriched, baselineSarif);

// 5. Suppress via YAML rules + inline source markers.
const { rules, warnings } = loadSuppressions(".codehub/suppressions.yaml");
const suppressed = applySuppressions(enriched, rules, readSource);
```

- **`mergeSarif(logs)`** — validates each input against `SarifLogSchema`,
  deep-clones, and concatenates `runs` in argument order. It does **not**
  collapse runs by tool name: SARIF consumers rely on per-tool identity for
  provenance, so each run keeps its own `tool.driver.name`.
- **`enrichWithFingerprints(log)`** — computes the `opencodehub/v1` content
  + context-window fingerprint and the GHAS `primaryLocationLineHash` partial
  fingerprint. `computeContextHash`, `computeOpenCodeHubFingerprint`, and
  `computePrimaryLocationLineHash` are exported for callers that need the raw
  hashers.
- **`enrichWithProperties(log, enrichments)`** — deposits OpenCodeHub signals
  (blast radius, centrality, cochange score, bus factor, etc.) under
  `properties.opencodehub.*`. It never mutates `ruleId`, `fingerprints`,
  `partialFingerprints`, or `artifactLocation.uri` (the GHAS dedup contract).
- **`diffSarif(baseline, current, options?)`** — buckets results into
  `new` / `fixed` / `unchanged` / `updated` by the `opencodehub/v1`
  fingerprint, falling back to a `(ruleId, uri, startLine, startColumn)`
  tuple. An optional `renameChainFor` resolver follows `git mv` continuity.
- **`applyBaselineState(current, baseline, options?)`** — returns a clone of
  `current` with each result tagged with a SARIF 2.1.0 `baselineState`.
- **`loadSuppressions(path, now?)`** — reads `.codehub/suppressions.yaml`,
  drops expired rules, and returns surviving rules plus non-fatal warnings.
- **`applySuppressions(log, rules, readSource?)`** — appends standard SARIF
  `suppressions[]` entries for matching YAML rules and for inline
  `codehub-suppress: <ruleId>` comments (`//`, `#`, `/* */`, `--`, `<!--`)
  on or above the finding line. The marker is honored only inside a comment.
- **`isSuppressed(result)`** — the predicate `codehub verdict` uses to skip
  blocking findings.

## Design

- All zod schemas (`SarifLogSchema`, `SarifResultSchema`, …) use passthrough
  so unknown SARIF fields survive a round-trip untouched. `version` is pinned
  to the literal `"2.1.0"`; any other version is rejected.
- The public API returns plain objects typed against `@types/sarif`; `zod`
  is used internally for input validation only.
- The `fixtures/` directory holds real SARIF outputs captured from each
  bundled scanner; the schema-validation test runs against them on every build.
