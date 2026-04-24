/**
 * @opencodehub/sarif — SARIF v2.1.0 helpers.
 *
 * Public surface:
 *   - Schemas (zod): validate slim subset of SARIF v2.1.0.
 *   - mergeSarif(logs[]): concatenate runs across inputs; deep-clone.
 *   - enrichWithProperties(log, enrichments): add opencodehub.* properties
 *     WITHOUT mutating ruleId / fingerprints / artifactLocation.uri
 *     (GHAS dedup contract).
 *   - enrichWithFingerprints(log): compute `opencodehub/v1` +
 *     `primaryLocationLineHash` partial fingerprints.
 *   - diffSarif / applyBaselineState: snapshot-diff by fingerprint and tag
 *     SARIF 2.1.0 `baselineState` on every Result.
 *   - applySuppressions / loadSuppressions / isSuppressed: external YAML
 *     rules + inline `codehub-suppress: <ruleId>` comment handling.
 *   - Types: SarifLog/SarifRun/SarifResult/... + ResultEnrichment/RunEnrichment.
 */

export type {
  BaselineState,
  DiffOptions,
  DiffResult,
  RenameChainResolver,
} from "./baseline.js";
export { applyBaselineState, diffSarif } from "./baseline.js";
export type { EnrichmentInput, ResultEnrichment, RunEnrichment } from "./enrich.js";
export { enrichWithProperties } from "./enrich.js";
export {
  computeContextHash,
  computeOpenCodeHubFingerprint,
  computePrimaryLocationLineHash,
  enrichWithFingerprints,
} from "./fingerprint.js";
export { mergeSarif } from "./merge.js";
export type {
  SarifArtifactLocation,
  SarifLocation,
  SarifLog,
  SarifMessage,
  SarifPhysicalLocation,
  SarifPropertyBag,
  SarifRegion,
  SarifResult,
  SarifRun,
  SarifTool,
  SarifToolDriver,
} from "./schemas.js";
export {
  SarifArtifactLocationSchema,
  SarifLocationSchema,
  SarifLogSchema,
  SarifMessageSchema,
  SarifPhysicalLocationSchema,
  SarifPropertyBagSchema,
  SarifRegionSchema,
  SarifResultSchema,
  SarifRunSchema,
  SarifToolDriverSchema,
  SarifToolSchema,
} from "./schemas.js";
export type { LoadedSuppressions, SuppressionRule } from "./suppressions.js";
export {
  applySuppressions,
  findInlineSuppressionReason,
  isSuppressed,
  loadSuppressions,
} from "./suppressions.js";
