/**
 * Top-level orchestrator that constructs a `PipelineContext`, runs the
 * configured phase set, and returns a summary plus the hashed graph.
 *
 * The orchestrator does not touch storage — the returned
 * `KnowledgeGraph` is in-memory only. Persisting it (DuckDB / embeddings)
 * is a CLI concern (see `codehub analyze`, which opens a writable store
 * and calls `bulkLoad`).
 */

import { graphHash, KnowledgeGraph } from "@opencodehub/core-types";
import { ANNOTATE_PHASE_NAME, type AnnotateOutput } from "./phases/annotate.js";
import { COCHANGE_PHASE_NAME, type CochangeOutput } from "./phases/cochange.js";
import { DEFAULT_PHASES } from "./phases/default-set.js";
import { EMBEDDER_PHASE_NAME, type EmbedderPhaseOutput } from "./phases/embeddings.js";
import {
  INCREMENTAL_SCOPE_PHASE_NAME,
  type IncrementalScopeOutput,
} from "./phases/incremental-scope.js";
import { PARSE_PHASE_NAME, type ParseOutput } from "./phases/parse.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./phases/scan.js";
import {
  SUMMARIZE_PHASE_NAME,
  SUMMARY_CACHE_OPTIONS_KEY,
  type SummarizePhaseOutput,
  type SummaryCacheAdapter,
} from "./phases/summarize.js";
import { runPipeline } from "./runner.js";
import type {
  PhaseResult,
  PipelineContext,
  PipelineOptions,
  PipelinePhase,
  PreviousGraph,
  ProgressEvent,
} from "./types.js";

export interface RunPipelineResult {
  readonly graph: KnowledgeGraph;
  readonly graphHash: string;
  readonly stats: {
    readonly totalMs: number;
    readonly phases: readonly { readonly name: string; readonly durationMs: number }[];
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly byKind?: Record<string, number>;
    readonly byRelation?: Record<string, number>;
    readonly schemaVersion?: string;
    readonly currentCommit?: string;
    /**
     * Cache hit / miss counts from the parse phase. Populated on every run
     * because `parsePhase` tracks them unconditionally; a fully-cold run
     * reports `{hits: 0, misses: N}` which produces `cacheHitRatio === 0`.
     */
    readonly parseCache?: {
      readonly hits: number;
      readonly misses: number;
      readonly ratio: number;
    };
  };
  readonly warnings: readonly string[];
  /**
   * Output of the `embeddings` phase when present. `undefined` only in the
   * pathological case of a custom phase set that omits it entirely. When
   * embeddings were disabled the phase still ran and returned a zero-ed
   * output so this field remains defined.
   */
  readonly embeddings?: EmbedderPhaseOutput;
  /**
   * Output of the `incremental-scope` phase when it ran. Absent when the
   * operator supplied a custom phase set that excluded it. Downstream code
   * (analyze CLI, doctor) reads `mode` and `closureRatio` for reporting.
   */
  readonly incrementalScope?: IncrementalScopeOutput;
  /**
   * Output of the `scan` phase. Exposed so CLIs can persist the post-scan
   * state (content hashes per file) for the next run's incremental pass.
   * Always present under the default phase set; absent only when a custom
   * set omits scan entirely (which would fail validation anyway).
   */
  readonly scan?: ScanOutput;
  /**
   * Output of the `cochange` phase. Carries the file×file association-rule
   * rows that the CLI persists into the dedicated `cochanges` storage table
   * after `bulkLoad`. Absent only when a custom phase set omits cochange.
   */
  readonly cochange?: CochangeOutput;
  /**
   * Output of the `summarize` phase. Carries any fresh `SymbolSummaryRow`
   * entries the CLI persists into the `symbol_summaries` table. Absent only
   * when a custom phase set omits summarize; the default phase set always
   * runs it (the phase internally short-circuits when gated off).
   */
  readonly summarize?: SummarizePhaseOutput;
}

export interface RunIngestionOptions extends PipelineOptions {
  readonly phases?: readonly PipelinePhase[];
  readonly onProgress?: (ev: ProgressEvent) => void;
  /**
   * Optional adapter the summarize phase probes before issuing work.
   * Production wires this to the DuckDB store's `lookupSymbolSummary`
   * implementation so re-indexes become free when source hasn't drifted.
   * Tests inject an in-memory fake. Absent by default — the phase degrades
   * to "every candidate is a miss" which is still correct, just more
   * expensive.
   */
  readonly summaryCacheAdapter?: SummaryCacheAdapter;
}

/**
 * Kick off an end-to-end pipeline run. When `options.phases` is omitted
 * the default phase set is used.
 */
export async function runIngestion(
  repoPath: string,
  options: RunIngestionOptions = {},
): Promise<RunPipelineResult> {
  const phases = options.phases ?? DEFAULT_PHASES;
  const normalizedOptions: PipelineOptions = stripPhaseKeys(options);
  // Attach the optional summary-cache adapter onto the options bag via a
  // well-known key. The `summarize` phase reads it back via an unchecked
  // cast; keeping the attach-point here (rather than inside stripPhaseKeys)
  // keeps the typed fields in stripPhaseKeys honest.
  if (options.summaryCacheAdapter !== undefined) {
    (normalizedOptions as unknown as Record<string, unknown>)[SUMMARY_CACHE_OPTIONS_KEY] =
      options.summaryCacheAdapter;
  }
  const graph = new KnowledgeGraph();
  const warnings: string[] = [];

  const ctx: PipelineContext = {
    repoPath,
    options: normalizedOptions,
    graph,
    phaseOutputs: new Map(),
    ...(options.onProgress !== undefined
      ? {
          onProgress: (ev) => {
            if (ev.kind === "warn" && ev.message !== undefined) {
              warnings.push(ev.message);
            }
            options.onProgress?.(ev);
          },
        }
      : {
          onProgress: (ev) => {
            if (ev.kind === "warn" && ev.message !== undefined) {
              warnings.push(ev.message);
            }
          },
        }),
  };

  const started = Date.now();
  const results = await runPipeline(phases, ctx);
  const totalMs = Date.now() - started;

  // If `annotate` ran, pull the richer stats and schema metadata out onto
  // the orchestrator-level result so the CLI can surface them without
  // reaching into the phase-output map.
  const annotate = results.find((r) => r.name === ANNOTATE_PHASE_NAME)?.output as
    | AnnotateOutput
    | undefined;
  const embeddings = results.find((r) => r.name === EMBEDDER_PHASE_NAME)?.output as
    | EmbedderPhaseOutput
    | undefined;
  const incrementalScope = results.find((r) => r.name === INCREMENTAL_SCOPE_PHASE_NAME)?.output as
    | IncrementalScopeOutput
    | undefined;
  const parse = results.find((r) => r.name === PARSE_PHASE_NAME)?.output as ParseOutput | undefined;
  const scan = results.find((r) => r.name === SCAN_PHASE_NAME)?.output as ScanOutput | undefined;
  const cochange = results.find((r) => r.name === COCHANGE_PHASE_NAME)?.output as
    | CochangeOutput
    | undefined;
  const summarize = results.find((r) => r.name === SUMMARIZE_PHASE_NAME)?.output as
    | SummarizePhaseOutput
    | undefined;

  const parseCache =
    parse !== undefined
      ? {
          hits: parse.cacheHits,
          misses: parse.cacheMisses,
          ratio:
            parse.cacheHits + parse.cacheMisses === 0
              ? 0
              : parse.cacheHits / (parse.cacheHits + parse.cacheMisses),
        }
      : undefined;

  // DEBUG_PHASE_MEM=1 brackets the graphHash call so large monorepos (where
  // the hash can take several seconds) don't look like a hang relative to
  // the per-phase telemetry emitted by the runner. Entirely gated — safe to
  // leave in; costs are two stderr writes + one Date.now() sample.
  const phaseMemDebug = process.env["DEBUG_PHASE_MEM"] === "1";
  if (phaseMemDebug) {
    process.stderr.write(
      `[phase-telemetry] graphHash-start nodes=${graph.nodeCount()} edges=${graph.edgeCount()}\n`,
    );
  }
  const hashStart = Date.now();
  const hashed = graphHash(graph);
  if (phaseMemDebug) {
    process.stderr.write(`[phase-telemetry] graphHash-end dur=${Date.now() - hashStart}ms\n`);
  }
  return {
    graph,
    graphHash: hashed,
    stats: {
      totalMs,
      phases: results.map(summarizePhase),
      nodeCount: graph.nodeCount(),
      edgeCount: graph.edgeCount(),
      ...(annotate !== undefined
        ? {
            byKind: annotate.stats.byKind,
            byRelation: annotate.stats.byRelation,
            schemaVersion: annotate.schemaVersion,
            ...(annotate.currentCommit !== undefined
              ? { currentCommit: annotate.currentCommit }
              : {}),
          }
        : {}),
      ...(parseCache !== undefined ? { parseCache } : {}),
    },
    warnings,
    ...(embeddings !== undefined ? { embeddings } : {}),
    ...(incrementalScope !== undefined ? { incrementalScope } : {}),
    ...(scan !== undefined ? { scan } : {}),
    ...(cochange !== undefined ? { cochange } : {}),
    ...(summarize !== undefined ? { summarize } : {}),
  };
}

function summarizePhase(r: PhaseResult): { readonly name: string; readonly durationMs: number } {
  return { name: r.name, durationMs: r.durationMs };
}

function stripPhaseKeys(options: RunIngestionOptions): PipelineOptions {
  // Copy only the fields PipelineOptions declares — phase overrides and
  // progress callbacks are orchestrator-level concerns and must not leak
  // into the normalized per-phase options.
  const typed: {
    force?: boolean;
    offline?: boolean;
    verbose?: boolean;
    skipGit?: boolean;
    byteCapPerFile?: number;
    maxTotalFiles?: number;
    embeddings?: boolean;
    embeddingsVariant?: "fp32" | "int8";
    embeddingsModelDir?: string;
    embeddingsGranularity?: readonly ("symbol" | "file" | "community")[];
    sbom?: boolean;
    reproducibleSbom?: boolean;
    incrementalFrom?: PreviousGraph;
    summaries?: boolean;
    maxSummariesPerRun?: number;
    summaryModel?: string;
  } = {};
  if (options.force !== undefined) typed.force = options.force;
  if (options.offline !== undefined) typed.offline = options.offline;
  if (options.verbose !== undefined) typed.verbose = options.verbose;
  if (options.skipGit !== undefined) typed.skipGit = options.skipGit;
  if (options.byteCapPerFile !== undefined) typed.byteCapPerFile = options.byteCapPerFile;
  if (options.maxTotalFiles !== undefined) typed.maxTotalFiles = options.maxTotalFiles;
  if (options.embeddings !== undefined) typed.embeddings = options.embeddings;
  if (options.embeddingsVariant !== undefined) typed.embeddingsVariant = options.embeddingsVariant;
  if (options.sbom !== undefined) typed.sbom = options.sbom;
  if (options.reproducibleSbom !== undefined) typed.reproducibleSbom = options.reproducibleSbom;
  if (options.embeddingsModelDir !== undefined) {
    typed.embeddingsModelDir = options.embeddingsModelDir;
  }
  if (options.embeddingsGranularity !== undefined) {
    typed.embeddingsGranularity = options.embeddingsGranularity;
  }
  if (options.incrementalFrom !== undefined) typed.incrementalFrom = options.incrementalFrom;
  if (options.summaries !== undefined) typed.summaries = options.summaries;
  if (options.maxSummariesPerRun !== undefined) {
    typed.maxSummariesPerRun = options.maxSummariesPerRun;
  }
  if (options.summaryModel !== undefined) typed.summaryModel = options.summaryModel;
  return typed;
}
