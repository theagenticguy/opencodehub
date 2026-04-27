/**
 * Shared types for the pipeline runner and phase modules.
 *
 * The pipeline is a static DAG: each phase declares its dependencies by name,
 * the runner validates (duplicate / missing / cycle) and sorts phases
 * topologically, then executes in order. Phases communicate via a typed
 * output map keyed by phase name; each phase only sees outputs of phases it
 * declared as dependencies (dep isolation prevents hidden coupling).
 *
 * The runner plus scan/structure/parse are the core; markdown, routes,
 * tools, orm, crossFile, mro, communities, and processes extend the set
 * without touching this file.
 */

import type { CodeRelation, GraphNode, KnowledgeGraph } from "@opencodehub/core-types";

/** Runtime context supplied to each phase. */
export interface PipelineContext {
  /** Absolute repository root path. */
  readonly repoPath: string;
  /** Normalized pipeline options. */
  readonly options: PipelineOptions;
  /** Single shared mutable graph accumulator populated across phases. */
  readonly graph: KnowledgeGraph;
  /** Outputs emitted by phases that completed before the caller. */
  readonly phaseOutputs: ReadonlyMap<string, unknown>;
  /** Optional progress sink; thrown errors from the callback are swallowed. */
  readonly onProgress?: (ev: ProgressEvent) => void;
}

/**
 * Minimal projection of a prior-run graph sufficient for the incremental-scope
 * phase to compute the import-closure walk. We intentionally keep this
 * narrower than a full {@link KnowledgeGraph} so callers can materialise
 * it cheaply from persisted storage (DuckDB rows, sidecar JSON, etc.) without
 * hydrating every node/edge kind in the graph.
 *
 * All arrays carry repo-relative posix paths (matching `ScannedFile.relPath`).
 * The inputs must be pre-deduplicated; no validation is performed downstream.
 */
export interface PreviousGraph {
  /**
   * Relative file paths present in the prior index, each paired with the
   * content-addressed sha256 captured on the last successful scan. Paths
   * absent from the current scan are silently ignored; paths whose hash
   * differs from the current scan are treated as "changed" and seed the
   * closure walk.
   */
  readonly files: readonly { readonly relPath: string; readonly contentSha: string }[];
  /**
   * IMPORTS edges at file granularity — `importer` depends on `target`. The
   * shape mirrors the edges written by the parse phase (`File -> File`). Edges
   * whose endpoints are outside `files` are ignored by the closure walk.
   */
  readonly importEdges: readonly { readonly importer: string; readonly target: string }[];
  /**
   * Heritage neighbourhoods per file. Used to grow the closure by one hop of
   * EXTENDS/IMPLEMENTS ancestors + descendants so an edit to a base class
   * refreshes its subtype MROs. Empty array is valid (no heritage known).
   */
  readonly heritageEdges: readonly {
    readonly childFile: string;
    readonly parentFile: string;
  }[];
  /**
   * Full prior-run node set. When present, the four active incremental
   * phases (crossFile/mro/communities/processes) carry forward any
   * non-closure node from the prior run so incremental mode produces a
   * byte-identical graph hash vs a fresh full run at the same commit.
   * `undefined` keeps the passive contract where incremental-scope emits
   * the closure hint but the downstream phases re-compute from scratch.
   */
  readonly nodes?: readonly GraphNode[];
  /**
   * Full prior-run edge set. Paired with {@link nodes}; see its docstring
   * for activation semantics. Active incremental phases use this snapshot
   * to carry forward edges whose both endpoints lie outside the closure
   * unchanged. Edges whose endpoints are now missing from the current
   * graph are silently dropped on carry-forward.
   */
  readonly edges?: readonly CodeRelation[];
}

/** Operator knobs accepted by the top-level `runIngestion` entry. */
export interface PipelineOptions {
  /** Re-run phases even if a prior run's artifacts look current. */
  readonly force?: boolean;
  /**
   * Snapshot of the prior index, supplied when the orchestrator is invoked in
   * incremental mode. When present the {@link INCREMENTAL_SCOPE_PHASE_NAME}
   * phase walks the IMPORTS closure and emits the set of files that need
   * re-processing. When absent (or when `--force` is set), the phase declares
   * a full reindex. See `packages/ingestion/src/pipeline/phases/incremental-scope.ts`.
   */
  readonly incrementalFrom?: PreviousGraph;
  /**
   * Refuse to spawn any child that hits the network. Phase authors are
   * expected to honor this by avoiding network IO; the orchestrator does
   * not sandbox — it simply threads the flag through.
   */
  readonly offline?: boolean;
  /** Extra chatter on the progress callback (implementation-defined). */
  readonly verbose?: boolean;
  /** Skip `git` invocations during scan when we are not in a git repo. */
  readonly skipGit?: boolean;
  /** Per-file byte cap; files larger than this are skipped with a warning. */
  readonly byteCapPerFile?: number;
  /** Overall file cap; scan stops accepting files once this is reached. */
  readonly maxTotalFiles?: number;
  /**
   * Populate the embeddings table. Requires `codehub setup --embeddings` to
   * have installed weights on disk. When false (default) the embeddings
   * phase returns an empty result without loading ONNX.
   */
  readonly embeddings?: boolean;
  /**
   * Which embedder variant to load when `embeddings=true`. Defaults to
   * `fp32`. Ignored when `embeddings=false`.
   */
  readonly embeddingsVariant?: "fp32" | "int8";
  /** Override the model directory used by the embedder. */
  readonly embeddingsModelDir?: string;
  /**
   * Hierarchical tiers to emit when `embeddings=true` (P03). Defaults to
   * `["symbol"]` so v1.0 behaviour is preserved. Pass
   * `["symbol", "file", "community"]` to emit all three tiers; the phase
   * de-dupes and normalizes the order. Unknown tier names are silently
   * filtered at the TS type level.
   */
  readonly embeddingsGranularity?: readonly ("symbol" | "file" | "community")[];
  /**
   * Number of ONNX embedder workers to run in parallel. `undefined` or
   * `<= 1` preserves the legacy in-process path (single main-thread
   * embedder, no Piscina overhead). Values >= 2 spin up a worker pool of
   * independent OnnxEmbedder instances. Each worker holds its own
   * session (~300 MB RSS on fp32), so sizing above `os.cpus().length - 1`
   * buys nothing and risks memory pressure. Ignored when the HTTP
   * backend is selected via `CODEHUB_EMBEDDING_URL`.
   */
  readonly embeddingsWorkers?: number;
  /**
   * Batch size for cross-node inference. The embeddings phase groups
   * chunks across symbols/files/communities into a single
   * `embedder.embedBatch()` call; this knob controls that batch size.
   * Defaults to 32 (see `DEFAULT_EMBEDDING_BATCH_SIZE` in the phase
   * module). `1` restores the legacy one-node-per-call pattern.
   */
  readonly embeddingsBatchSize?: number;
  /**
   * When `true`, the SBOM phase emits `.codehub/sbom.cyclonedx.json` and
   * `.codehub/sbom.spdx.json` from Dependency nodes. When `false` (the
   * default), the phase is a no-op. Toggled via the `codehub analyze
   * --sbom` flag.
   */
  readonly sbom?: boolean;
  /**
   * When `true` (default), SBOM emission uses a fixed epoch timestamp and
   * a content-addressed document namespace so byte-identical SBOMs are
   * produced for byte-identical Dependency sets. This keeps downstream
   * attestations and diff-based review stable. Setting `false` swaps the
   * epoch for `Date.now()` (floored to the second) and the namespace for
   * a random UUID; reserved for ad-hoc local use.
   */
  readonly reproducibleSbom?: boolean;
  /**
   * When `true`, the coverage phase probes for lcov / cobertura / jacoco /
   * coverage.py artifacts and annotates `File` nodes with
   * `coveragePercent` + `coveredLines`. Default `false` so analyze stays
   * quiet in repos without a coverage pipeline. Toggled via the
   * `codehub analyze --coverage` flag.
   */
  readonly coverage?: boolean;
  /**
   * When `true`, the `summarize` phase walks callable symbols, computes a
   * content hash from their source span, and issues a Bedrock summarize
   * call for cache misses. Gated OFF by default because the phase spends
   * real money. The `offline` flag always wins — when `offline === true`
   * the phase is a no-op regardless of this flag.
   */
  readonly summaries?: boolean | undefined;
  /**
   * Upper bound on the number of Bedrock summarize calls per pipeline run.
   * Defaults to `0`, which runs the phase in dry-run mode: it enumerates
   * eligible symbols and reports `wouldHaveSummarized` without contacting
   * Bedrock. Set to a positive integer (e.g. 10) to actually summarize a
   * bounded subset. Ignored when `summaries !== true`. The CLI resolves
   * `--max-summaries auto` to a concrete integer before calling into the
   * pipeline, so this field is always numeric inside the pipeline.
   */
  readonly maxSummariesPerRun?: number | undefined;
  /**
   * Override the Bedrock model id used by the summarize phase. When
   * undefined, the phase uses `DEFAULT_MODEL_ID` from
   * `@opencodehub/summarizer`.
   */
  readonly summaryModel?: string | undefined;
  /**
   * When `true`, detectors that pattern-match on receiver identifiers
   * skip heuristic-only matches entirely — edges are emitted only when a
   * receiver's module origin was confirmed via the import graph or
   * ts-morph. Exposed by the `codehub analyze --strict-detectors` flag
   * (DET-O-001).
   */
  readonly strictDetectors?: boolean;
}

/** Lightweight progress event emitted during pipeline execution. */
export interface ProgressEvent {
  readonly phase: string;
  readonly kind: "start" | "end" | "note" | "warn" | "error";
  readonly pct?: number;
  readonly message?: string;
  readonly elapsedMs?: number;
}

/** Declarative phase description. */
export interface PipelinePhase<TOutput = unknown> {
  /** Unique phase identifier — must be distinct within a DAG. */
  readonly name: string;
  /** Other phase names that must complete before this one runs. */
  readonly deps: readonly string[];
  /**
   * Execute the phase against the shared context. `deps` is pre-filtered to
   * only include outputs of phases this phase declared as dependencies.
   */
  run(ctx: PipelineContext, deps: ReadonlyMap<string, unknown>): Promise<TOutput>;
}

/** Per-phase summary returned by {@link runPipeline}. */
export interface PhaseResult {
  readonly name: string;
  readonly output: unknown;
  readonly durationMs: number;
  readonly warnings: readonly string[];
}
