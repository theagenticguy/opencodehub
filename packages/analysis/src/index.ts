export type { ApiImpactFilter, ApiImpactRow } from "./api-impact.js";
export { listApiImpact, scoreRisk, worseRisk } from "./api-impact.js";
export type {
  BusinessCandidateVerdict,
  PlumbingFeatures,
  PlumbingVerdict,
} from "./business-logic.js";
export {
  classifyBusinessCandidate,
  classifyPlumbing,
  SIEVE_VALIDATED_LANGUAGES,
} from "./business-logic.js";
export {
  type ChangePackInternal,
  COST_TOKENIZER_MODEL,
  countTokens,
  type ReadFileText,
  runChangePack,
} from "./change-pack.js";
export type {
  AffectedTest,
  ChangedSymbol,
  ChangePack,
  ChangePackQuery,
  CostAttribution,
  ImpactedSubgraph,
  ImpactedSubgraphEdge,
  ImpactedSubgraphNode,
} from "./change-pack-types.js";
export type {
  DeadCodeResult,
  Deadness,
  DeadSymbol,
  MembershipRow as DeadCodeMembershipRow,
  ReferrerRow as DeadCodeReferrerRow,
  SymbolRow as DeadCodeSymbolRow,
} from "./dead-code.js";
export {
  classifyDeadness,
  classifyInMemory as classifyDeadnessInMemory,
  referrerRelations as deadCodeReferrerRelations,
  symbolKinds as deadCodeSymbolKinds,
} from "./dead-code.js";
export { runDetectChanges } from "./detect-changes.js";
export { createNodeFs } from "./fs.js";
export {
  gitDiffHunks,
  gitDiffNames,
  gitRevListCount,
  gitRevParseHead,
  parseDiffHunks,
} from "./git.js";
// Cross-repo group contract extractors (HTTP, gRPC, topic) + sync.
export type {
  ComputeCrossRepoLinksOpts,
  Contract,
  ContractRegistry,
  ContractType,
  CrossLink,
  CrossRepoLink,
  CrossRepoRelation,
  DocPathScheme,
  GrpcClientExtractOptions,
  GrpcProtoExtractOptions,
  HttpExtractOptions,
  ManifestLink,
  MatchReason,
  RepoManifestSummary,
  RunGroupSyncOptions,
  SyncRepoInput,
  TopicExtractOptions,
} from "./group/index.js";
export {
  buildManifestLinks,
  buildRegistry,
  computeCrossRepoLinks,
  contractFamily,
  extractGrpcClientContracts,
  extractGrpcProtoContracts,
  extractHttpContracts,
  extractTopicContracts,
  httpSignature,
  isProducer,
  normalizeHttpPath,
  normalizeTopicSignature,
  readRepoManifest,
  resolveCrossLinks,
  runGroupSync,
} from "./group/index.js";
export { runImpact } from "./impact.js";
export type {
  DependencyRef,
  LicenseAuditFlagged,
  LicenseAuditResult,
  LicenseTier,
} from "./license-classify.js";
export { classifyDependencies } from "./license-classify.js";
export type { OwnerRow } from "./owners.js";
export { collectOwnersByPath, listOwners } from "./owners.js";
export type { Adjacency, EdgeLike } from "./page-rank.js";
export { buildAdjacency, pageRank } from "./page-rank.js";
export type { OrphanGrade } from "./risk.js";
export {
  maxOrphanMultiplier,
  orphanMultiplier,
  riskFromCount,
  riskFromScore,
  scoreFromDepths,
} from "./risk.js";
export type {
  CommunityRiskEntry,
  CommunityTrend,
  FindingSeverity,
  RiskSnapshot,
  RiskTrend,
  RiskTrendsResult,
} from "./risk-snapshot.js";
export {
  buildRiskSnapshot,
  buildRiskSnapshotFromGraph,
  computeRiskTrends,
  HISTORY_DIR,
  loadSnapshots,
  persistRiskSnapshot,
  SNAPSHOT_RETENTION,
  snapshotFilename,
} from "./risk-snapshot.js";
export type { RouteMapFilter, RouteMapRow } from "./route-map.js";
export { listRouteMap } from "./route-map.js";
export type { ShapeStatus } from "./shape.js";
export { classifyShape } from "./shape.js";
export { computeStaleness } from "./staleness.js";
export type {
  AffectedModule,
  AffectedProcess,
  AffectedSymbol,
  ChangedHunk,
  DetectChangesQuery,
  DetectChangesResult,
  FsAbstraction,
  ImpactDepthBucket,
  ImpactEdge,
  ImpactQuery,
  ImpactResult,
  NodeRef,
  RiskLevel,
  StalenessResult,
} from "./types.js";
export { computeVerdict } from "./verdict.js";
export { renderVerdictMarkdown } from "./verdict-markdown.js";
export type {
  DecisionBoundary,
  ReasoningSignal,
  RecommendedReviewer,
  VerdictConfig,
  VerdictQuery,
  VerdictResponse,
  VerdictTier,
} from "./verdict-types.js";
export { DEFAULT_VERDICT_CONFIG } from "./verdict-types.js";
