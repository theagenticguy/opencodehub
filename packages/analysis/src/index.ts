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
  Contract,
  ContractRegistry,
  ContractType,
  CrossLink,
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
export { runRename } from "./rename.js";
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
  RenameEdit,
  RenameQuery,
  RenameResult,
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
export type { WikiLlmOptions, WikiOptions, WikiResult } from "./wiki.js";
export { generateWiki } from "./wiki.js";
export type {
  LlmModuleInput,
  LlmOverview,
  LlmOverviewOptions,
} from "./wiki-render/llm-overview.js";
