/**
 * `@opencodehub/eval` — the variance probe (spec 010 / Move 2).
 *
 * Public surface: load a task, run the with/without experiment via a runner,
 * score it with the task's oracle, and emit a deterministic report. v1 ships
 * the Bedrock-wired direct-CLI runner; the probe core is runner-agnostic.
 */

export {
  buildAgentEnv,
  buildArgv,
  CliAgentRunner,
  type CliRunnerConfig,
  composePrompt,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  parseClaudeOutput,
  parseCodexOutput,
  type SpawnFn,
  type SpawnResult,
} from "./cli-runner.js";
export {
  type ArmDispersion,
  bernoulliDispersion,
  dispersionScalar,
  distinctOutputRatio,
  mean,
  populationStddev,
} from "./dispersion.js";
export {
  aggregateInsight,
  breaksSearchLoop,
  type InsightCounts,
  scoreInsight,
  ZERO_INSIGHT,
} from "./insight.js";
export { type JudgeScorer, type ScoreOptions, scoreArm } from "./oracle.js";
export {
  DEFAULT_RUNS,
  type ProbeOptions,
  type ProbeRunEvent,
  probeHarness,
  resolveHarnesses,
  runProbe,
} from "./probe.js";
export {
  type ArmInsight,
  type ArmReport,
  type ArmTokens,
  buildHarnessReport,
  formatReport,
  type HarnessReport,
  serializeReport,
  TOKEN_OVERHEAD_FLAG,
  type VarianceReport,
} from "./report.js";
export type {
  AgentRunner,
  Harness,
  RunOutcome,
  RunRequest,
  RunTokens,
} from "./runner.js";
export {
  buildAssertionCommand,
  type GeneratedTask,
  instanceToTask,
  parseTestList,
  type SweBenchInstance,
  type TestRunner,
  type ToTaskOptions,
} from "./swebench.js";
export {
  type AssertionOracle,
  type JudgeOracle,
  loadTask,
  type Oracle,
  OracleSchema,
  type OutputHashOracle,
  type Task,
  TaskSchema,
  TaskValidationError,
} from "./task.js";
export {
  type Action,
  type ActionType,
  actionsFromClaudeStreamJson,
  actionsFromCodexJsonl,
  isShellReadSearch,
  isValidationCommand,
  normalizeQuery,
  shellFirstWord,
} from "./trajectory.js";
