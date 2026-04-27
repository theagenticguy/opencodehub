export type {
  BaselineCommandOptions,
  ReplayCommandOptions,
  RunCommandOptions,
} from "./cli.js";
export { baselineCommand, replayCommand, runCommand } from "./cli.js";
export type { CorpusCase, CorpusFile } from "./corpus.js";
export { corpusCaseSchema, corpusFileSchema, loadCorpus } from "./corpus.js";
export type {
  ManifestCorpus,
  ManifestLanguage,
  ManifestRecord,
  ManifestRequest,
  ManifestRequestKind,
  ManifestResult,
  ManifestTarget,
  ManifestTool,
} from "./manifest.js";
export {
  canonicalize,
  fingerprint,
  manifestCorpusSchema,
  manifestLanguageSchema,
  manifestRecordSchema,
  manifestRequestKindSchema,
  manifestRequestSchema,
  manifestResultSchema,
  manifestTargetSchema,
  manifestToolSchema,
  readManifest,
  writeManifest,
} from "./manifest.js";
export type {
  CaseScore,
  ConfusionCounts,
  PrecisionRecallF1,
  Rollup,
} from "./metrics.js";
export {
  aggregate,
  confusion,
  evaluateSet,
  jaccard,
  kendallTau,
  precisionRecallF1,
} from "./metrics.js";
export type { RunnerConfig, RunResult, RunSummary } from "./runner.js";
export { replayManifest, runGym } from "./runner.js";
export type {
  CallerSite,
  ImplementationSite,
  LspClientLike,
  LspFactory,
  QueryCallersInput,
  QueryImplementationsInput,
  QueryReferencesInput,
  ReferenceSite,
} from "./scip-factory.js";
export { defaultLspFactory } from "./scip-factory.js";

export const GYM_PACKAGE_VERSION = "0.1.0";
