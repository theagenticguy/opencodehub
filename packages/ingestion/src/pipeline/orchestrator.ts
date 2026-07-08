/**
 * Top-level orchestrator that constructs a `PipelineContext`, runs the
 * configured phase set, and returns a summary plus the hashed graph.
 *
 * The orchestrator does not touch storage — the returned
 * `KnowledgeGraph` is in-memory only. Persisting it (SQLite / embeddings)
 * is a CLI concern (see `codehub analyze`, which opens a writable store
 * and calls `bulkLoad`).
 */

import { graphHash, KnowledgeGraph } from "@opencodehub/core-types";
import { ANNOTATE_PHASE_NAME, type AnnotateOutput } from "./phases/annotate.js";
import { COCHANGE_PHASE_NAME, type CochangeOutput } from "./phases/cochange.js";
import { DEFAULT_PHASES } from "./phases/default-set.js";
import {
  EMBEDDER_PHASE_NAME,
  EMBEDDING_HASH_CACHE_OPTIONS_KEY,
  type EmbedderPhaseOutput,
  type EmbeddingHashCacheAdapter,
} from "./phases/embeddings.js";
import {
  INCREMENTAL_SCOPE_PHASE_NAME,
  type IncrementalScopeOutput,
} from "./phases/incremental-scope.js";
import { PARSE_PHASE_NAME, type ParseOutput } from "./phases/parse.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./phases/scan.js";
import { runPipeline } from "./runner.js";
import type {
  PhaseResult,
  PipelineContext,
  PipelineOptions,
  PipelinePhase,
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
   * Set when the parse phase routed a non-trivial number of files to
   * tree-sitter grammars but extracted ZERO code symbols — the signature of a
   * globally-broken parser (e.g. a WASM grammar/resolver regression) that would
   * otherwise complete "successfully" with a File/Directory-only skeleton
   * graph. A run-level backstop to the per-file warnings (which collapse and
   * never affect the verdict). See {@link shouldTripZeroSymbolGuard}.
   */
  readonly zeroSymbolGuardTripped?: boolean;
}

/**
 * Below this many tree-sitter files, a real-but-tiny repo is too small to
 * confidently distinguish "broken parser" from "genuinely few symbols", so the
 * guard stays quiet. The failure mode it targets is a GLOBAL break across a
 * real codebase, where the file count is comfortably above this floor.
 */
const ZERO_SYMBOL_MIN_FILES = 5;

/**
 * Predicate for the zero-symbol guard: trips when the repo presented at least
 * {@link ZERO_SYMBOL_MIN_FILES} tree-sitter-parseable files yet produced zero
 * code symbols. Pure + exported so the threshold logic is unit-testable
 * without standing up the parser.
 */
export function shouldTripZeroSymbolGuard(
  treeSitterFileCount: number,
  treeSitterSymbolCount: number,
): boolean {
  return treeSitterFileCount >= ZERO_SYMBOL_MIN_FILES && treeSitterSymbolCount === 0;
}

export interface RunIngestionOptions extends PipelineOptions {
  readonly phases?: readonly PipelinePhase[];
  readonly onProgress?: (ev: ProgressEvent) => void;
  /**
   * Optional adapter the embeddings phase probes before issuing embedder
   * calls. Production wires this to the SQLite store's
   * `listEmbeddingHashes` implementation so re-analyze runs skip chunks
   * whose `content_hash` matches a prior row. Absent by default —
   * the phase degrades to "every chunk is new" which is still correct,
   * just more expensive. Ignored when `options.force === true`.
   */
  readonly embeddingHashCacheAdapter?: EmbeddingHashCacheAdapter;
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
  // Attach the embeddings phase's content-hash cache adapter onto the
  // options bag via a well-known key. Attached here (not in stripPhaseKeys)
  // so the typed option shape stays minimal: this is a well-known extension
  // point, not a first-class `PipelineOptions` field.
  if (options.embeddingHashCacheAdapter !== undefined) {
    (normalizedOptions as unknown as Record<string, unknown>)[EMBEDDING_HASH_CACHE_OPTIONS_KEY] =
      options.embeddingHashCacheAdapter;
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

  // Run-level backstop: a globally-broken parser yields empty captures for
  // every file, so extraction produces a File/Directory-only skeleton and the
  // run "succeeds". Per-file warnings collapse and never affect the verdict —
  // so aggregate here and surface a loud, greppable warning. (The hard-runtime
  // case aborts earlier via WasmRuntimeUnavailableError; this catches the
  // residual soft case, e.g. web-tree-sitter genuinely absent.)
  const zeroSymbolGuardTripped =
    parse !== undefined &&
    shouldTripZeroSymbolGuard(parse.treeSitterFileCount, parse.treeSitterSymbolCount);
  if (zeroSymbolGuardTripped && parse !== undefined) {
    warnings.push(
      `parse: extracted 0 code symbols from ${parse.treeSitterFileCount} tree-sitter source file(s) ` +
        `(expected Function/Class/Method/etc). The parser is likely globally broken — the graph holds ` +
        `only File/Directory nodes. Re-run with --verbose for per-file parse warnings, or run ` +
        `'codehub doctor' to check the vendored grammars.`,
    );
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
    ...(zeroSymbolGuardTripped ? { zeroSymbolGuardTripped: true } : {}),
  };
}

function summarizePhase(r: PhaseResult): { readonly name: string; readonly durationMs: number } {
  return { name: r.name, durationMs: r.durationMs };
}

function stripPhaseKeys(options: RunIngestionOptions): PipelineOptions {
  // Drop only the orchestrator-level keys — phase overrides, the progress
  // callback, and the two cache adapters are not per-phase options — and
  // spread the rest. Destructure-and-omit is the single source of truth:
  // every current and future `PipelineOptions` field reaches `ctx.options`
  // automatically, so the normalized bag can never silently drop a field
  // the way a hand-maintained allowlist did.
  const {
    phases: _phases,
    onProgress: _onProgress,
    embeddingHashCacheAdapter: _embeddingHashCacheAdapter,
    ...pipelineOptions
  } = options;
  return pipelineOptions;
}
