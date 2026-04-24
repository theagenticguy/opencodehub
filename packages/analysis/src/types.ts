/**
 * Public types for the @opencodehub/analysis package.
 *
 * These mirror the shapes consumed by the CLI and the MCP tool layer. Every
 * exported interface is readonly so callers can safely pass results through
 * serialization boundaries without defensive copying.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ImpactQuery {
  readonly target: string;
  readonly direction: "upstream" | "downstream" | "both";
  readonly maxDepth?: number;
  readonly relationTypes?: readonly string[];
  readonly minConfidence?: number;
  /**
   * Exact node id for zero-ambiguity lookup. When set, target name is
   * ignored for resolution — the UID must exist or the call returns
   * not-found.
   */
  readonly targetUid?: string;
  /** Disambiguation filter on file path (exact match). */
  readonly filePath?: string;
  /** Disambiguation filter on node kind (Function, Method, Class, …). */
  readonly kind?: string;
  /**
   * When false (default), nodes whose `filePath` looks like a test file
   * (`tests/`, `test/`, `__tests__/` segments, `.test.` / `.spec.` infix)
   * are excluded from the traversal result and enrichment output.
   */
  readonly includeTests?: boolean;
}

export interface NodeRef {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly kind: string;
}

export interface ImpactDepthBucket {
  readonly depth: number;
  readonly nodes: readonly (NodeRef & { readonly viaRelation: string })[];
}

/**
 * Per-module aggregation surfaced by `runImpact`. `hits` counts how many
 * traversed nodes belong to the community; `impact` is `"direct"` when the
 * module is also hit by a depth-1 dependent, else `"indirect"`.
 */
export interface AffectedModule {
  readonly name: string;
  readonly hits: number;
  readonly impact: "direct" | "indirect";
}

/**
 * Minimal edge projection for confidence-breakdown aggregation. Each entry
 * represents one hop traversed inside the blast radius, flattened across
 * depths. Callers never mutate the underlying relations — they aggregate
 * `confidence` + `reason` into a provenance-tier histogram.
 */
export interface ImpactEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
  readonly confidence: number;
  readonly reason?: string;
}

export interface ImpactResult {
  readonly targetCandidates: readonly NodeRef[];
  readonly chosenTarget?: NodeRef;
  readonly byDepth: readonly ImpactDepthBucket[];
  readonly risk: RiskLevel;
  readonly totalAffected: number;
  readonly ambiguous: boolean;
  readonly affectedProcesses: readonly AffectedProcess[];
  /** Modules (Communities) containing any traversed node, ranked by hits. */
  readonly affectedModules: readonly AffectedModule[];
  /**
   * Every edge traversed between the target and an impacted node, flattened
   * across depths. Populated only when the target resolves unambiguously;
   * empty on ambiguous / not-found targets.
   */
  readonly traversedEdges: readonly ImpactEdge[];
  readonly hint?: string;
}

export interface RenameQuery {
  readonly symbolName: string;
  readonly newName: string;
  readonly dryRun?: boolean;
  readonly scope?: { readonly filePath?: string };
}

export interface RenameEdit {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly before: string;
  readonly after: string;
  readonly confidence: number;
  readonly source: "graph" | "text";
}

export interface RenameResult {
  readonly edits: readonly RenameEdit[];
  readonly applied: boolean;
  readonly skipped: readonly { readonly filePath: string; readonly reason: string }[];
  readonly ambiguous: boolean;
  readonly hint?: string;
}

export interface DetectChangesQuery {
  readonly scope: "unstaged" | "staged" | "all" | "compare";
  readonly compareRef?: string;
  readonly repoPath: string;
}

export interface AffectedSymbol {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly kind: string;
  readonly changedLines: readonly number[];
}

export interface AffectedProcess {
  readonly id: string;
  readonly name: string;
  readonly entryPointFile: string;
}

export interface DetectChangesResult {
  readonly changedFiles: readonly string[];
  readonly affectedSymbols: readonly AffectedSymbol[];
  readonly affectedProcesses: readonly AffectedProcess[];
  readonly summary: {
    readonly fileCount: number;
    readonly symbolCount: number;
    readonly processCount: number;
    readonly risk: RiskLevel;
  };
}

export interface StalenessResult {
  readonly isStale: boolean;
  readonly commitsBehind: number;
  readonly hint?: string;
  readonly lastIndexedCommit?: string;
  readonly currentCommit?: string;
}

/** Hunk boundary from `git diff -U0` (new-side coordinates). */
export interface ChangedHunk {
  readonly start: number;
  readonly count: number;
}

/** File-I/O abstraction so rename can be tested without touching disk. */
export interface FsAbstraction {
  readFile(absPath: string): Promise<string>;
  writeFileAtomic(absPath: string, content: string): Promise<void>;
}
