/**
 * Barrel exports for the pipeline subsystem (Wave 5).
 */

export type { IgnoreRule } from "./gitignore.js";
export {
  HARDCODED_IGNORES,
  loadGitignoreChain,
  parseGitignore,
  shouldIgnore,
} from "./gitignore.js";
export type { RunIngestionOptions, RunPipelineResult } from "./orchestrator.js";
export { runIngestion } from "./orchestrator.js";
export type { CochangeOptions, CochangeOutput } from "./phases/cochange.js";
export {
  COCHANGE_PHASE_NAME,
  cochangePhase,
  DEFAULT_MAX_FILES_PER_COMMIT,
} from "./phases/cochange.js";
export type { ComplexityOutput } from "./phases/complexity.js";
export { COMPLEXITY_PHASE_NAME, complexityPhase } from "./phases/complexity.js";
export type {
  CachedCapture,
  CachedExtractions,
  CacheEntry,
  CacheKey,
} from "./phases/content-cache.js";
export {
  CACHE_VERSION,
  cacheFilePath,
  computeCacheSize,
  deriveCacheKey,
  readCacheEntry,
  writeCacheEntry,
} from "./phases/content-cache.js";
export { DEFAULT_PHASES } from "./phases/default-set.js";
export type { EmbedderPhaseOutput } from "./phases/embeddings.js";
export { EMBEDDER_PHASE_NAME, embeddingsPhase } from "./phases/embeddings.js";
export type { FetchesOutput } from "./phases/fetches.js";
export {
  FETCHES_PHASE_NAME,
  fetchesPhase,
  UNRESOLVED_FETCH_TARGET_PREFIX,
} from "./phases/fetches.js";
export type { IncrementalScopeOutput } from "./phases/incremental-scope.js";
export {
  INCREMENTAL_SCOPE_PHASE_NAME,
  incrementalScopePhase,
} from "./phases/incremental-scope.js";
export type { MarkdownOutput } from "./phases/markdown.js";
export { MARKDOWN_PHASE_NAME, markdownPhase } from "./phases/markdown.js";
export type { OpenApiOutput } from "./phases/openapi.js";
export { OPENAPI_PHASE_NAME, openapiPhase } from "./phases/openapi.js";
export type { OrmOutput } from "./phases/orm.js";
export { ORM_EXTERNAL_PATH, ORM_PHASE_NAME, ormPhase } from "./phases/orm.js";
export type { OwnershipOptions, OwnershipOutput } from "./phases/ownership.js";
export { OWNERSHIP_PHASE_NAME, ownershipPhase } from "./phases/ownership.js";
export type { ParseOutput } from "./phases/parse.js";
export { PARSE_PHASE_NAME, parsePhase } from "./phases/parse.js";
export type { ProfileOutput } from "./phases/profile.js";
export { PROFILE_PHASE_NAME, profilePhase } from "./phases/profile.js";
export type { RiskSnapshotOptions, RiskSnapshotOutput } from "./phases/risk-snapshot.js";
export {
  RISK_SNAPSHOT_PHASE_NAME,
  riskSnapshotPhase,
} from "./phases/risk-snapshot.js";
export type { RoutesOutput } from "./phases/routes.js";
export { ROUTES_PHASE_NAME, routesPhase } from "./phases/routes.js";
export type { SbomOutput } from "./phases/sbom.js";
export { SBOM_PHASE_NAME, sbomPhase } from "./phases/sbom.js";
export type { ScannedFile, ScanOutput } from "./phases/scan.js";
export { SCAN_PHASE_NAME, scanPhase } from "./phases/scan.js";
export type { StructureOutput } from "./phases/structure.js";
export { STRUCTURE_PHASE_NAME, structurePhase } from "./phases/structure.js";
export type {
  TemporalCommitManifest,
  TemporalOptions,
  TemporalOutput,
} from "./phases/temporal.js";
export { TEMPORAL_PHASE_NAME, temporalPhase } from "./phases/temporal.js";
export type { ToolsOutput } from "./phases/tools.js";
export { TOOLS_PHASE_NAME, toolsPhase } from "./phases/tools.js";
export {
  PipelineGraphError,
  runPipeline,
  topologicalSort,
  validatePipeline,
} from "./runner.js";
export type {
  PhaseResult,
  PipelineContext,
  PipelineOptions,
  PipelinePhase,
  PreviousGraph,
  ProgressEvent,
} from "./types.js";
