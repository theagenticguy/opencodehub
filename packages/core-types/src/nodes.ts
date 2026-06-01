import type { NodeId } from "./id.js";

export type NodeKind =
  | "File"
  | "Folder"
  | "Function"
  | "Class"
  | "Method"
  | "Interface"
  | "Constructor"
  | "Struct"
  | "Enum"
  | "Macro"
  | "Typedef"
  | "Union"
  | "Namespace"
  | "Trait"
  | "Impl"
  | "TypeAlias"
  | "Const"
  | "Static"
  | "Variable"
  | "Property"
  | "Record"
  | "Delegate"
  | "Annotation"
  | "Template"
  | "Module"
  | "CodeElement"
  | "Community"
  | "Process"
  | "Route"
  | "Tool"
  | "Section"
  | "Finding"
  | "Dependency"
  | "Operation"
  | "Contributor"
  | "ProjectProfile"
  | "Repo";

// Insertion order is load-bearing: any reorder of NODE_KINDS changes the serialized
// payload hashed by graphHash. New kinds must be APPENDED at the end to preserve
// stability of existing graph hashes across schema minor bumps.
export const NODE_KINDS: readonly NodeKind[] = [
  "File",
  "Folder",
  "Function",
  "Class",
  "Method",
  "Interface",
  "Constructor",
  "Struct",
  "Enum",
  "Macro",
  "Typedef",
  "Union",
  "Namespace",
  "Trait",
  "Impl",
  "TypeAlias",
  "Const",
  "Static",
  "Variable",
  "Property",
  "Record",
  "Delegate",
  "Annotation",
  "Template",
  "Module",
  "CodeElement",
  "Community",
  "Process",
  "Route",
  "Tool",
  "Section",
  "Finding",
  "Dependency",
  "Operation",
  "Contributor",
  "ProjectProfile",
  "Repo",
] as const;

interface NodeBase {
  readonly id: NodeId;
  readonly name: string;
  readonly filePath: string;
}

interface LocatedNode extends NodeBase {
  readonly startLine?: number;
  readonly endLine?: number;
}

interface CallableShape {
  readonly signature?: string;
  readonly parameterCount?: number;
  readonly returnType?: string;
  readonly isExported?: boolean;
  /**
   * McCabe cyclomatic complexity. Populated by the `complexity` phase; absent
   * on legacy nodes produced before the phase was introduced.
   */
  readonly cyclomaticComplexity?: number;
  /**
   * Maximum nesting depth of control-flow blocks inside the function body.
   * Zero means the function body has no nested blocks.
   */
  readonly nestingDepth?: number;
  /**
   * Non-blank, non-comment-only lines of code in the function body (NLOC).
   */
  readonly nloc?: number;
  /**
   * Halstead volume for the function body (operators + operands). Populated
   * by the `complexity` phase when the provider ships a `halsteadOperatorKinds`
   * table. Absent on legacy nodes and on languages without the table.
   */
  readonly halsteadVolume?: number;
  /**
   * Natural-language description captured from the function's docstring /
   * JSDoc / rustdoc / godoc. Populated by the parse phase via @doc captures.
   */
  readonly description?: string;
  /**
   * Liveness classification produced by the `dead-code` phase.
   */
  readonly deadness?: "live" | "dead" | "unreachable_export";
  /**
   * Line-level coverage ratio in [0, 1] for this callable. Populated by the
   * `coverage` phase when a report is supplied; absent otherwise.
   */
  readonly coveragePercent?: number;
  /**
   * JSON-encoded array of 1-based covered line numbers scoped to this
   * callable's body. Populated by the `coverage` phase when a report is
   * supplied; absent otherwise.
   */
  readonly coveredLinesJson?: string;
}

interface TypeDeclShape {
  readonly isExported?: boolean;
}

interface ValueDeclShape {
  readonly declaredType?: string;
}

/** Summary of branch divergence relative to the configured base branch. */
export interface FileBranchDivergence {
  readonly ahead: number;
  readonly behind: number;
  readonly overlapFiles: readonly string[];
}

export interface FileNode extends NodeBase {
  readonly kind: "File";
  readonly language?: string;
  readonly contentHash?: string;
  readonly lineCount?: number;
  readonly content?: string;
  // --- Temporal signals. All optional; populated only when the
  // temporal phase runs over a git repository with history in the lookback
  // window. Keys in record-typed fields are always sorted for byte-stable
  // serialization. ---
  /** Histogram of Conventional-Commits types touching this file. */
  readonly ccTypeCounts?: Readonly<Record<string, number>>;
  /** Fraction in [0, 1] of `fix:` commits that follow a `feat:` within 48h on this file. */
  readonly fixFollowFeatDensity?: number;
  /** Count of revert commits touching this file (subject + body + --reference forms, deduped). */
  readonly revertCount?: number;
  /** Distinct Co-authored-by: emails across commits touching this file. */
  readonly coauthorCount?: number;
  /** Bus factor derived from contribution Gini. */
  readonly busFactor?: number;
  /** Sum of lines_changed weighted by exp(-age_days * ln(2) / halfLifeDays). */
  readonly decayedChurn?: number;
  /** Count of risk-keyword matches across subject + body. */
  readonly riskKeywordScore?: number;
  /** Jaccard ratio in [0, 1] of commits touching paired test files. */
  readonly testRatio?: number;
  /** Prior relative paths for this file (oldest to newest). */
  readonly renameHistoryChain?: readonly string[];
  /** Maximum gap in days between consecutive commits touching this file. */
  readonly commitIntervalMaxDays?: number;
  /** Average gap in days between consecutive commits touching this file. */
  readonly commitIntervalAvgDays?: number;
  /** Days since the top contributor's last commit anywhere in the repository. */
  readonly topContributorLastSeenDays?: number;
  /** Branch divergence summary for this file, when computed. */
  readonly branchDivergence?: FileBranchDivergence;
  // --- Ownership signals ( / H.5). All optional; emitted by the
  // `ownership` phase. ---
  /**
   * Ownership lifecycle grade derived from H.5. `active` is the default when
   * the file has recent top-contributor activity; other grades signal varying
   * degrees of abandonment.
   */
  readonly orphanGrade?: "active" | "orphaned" | "abandoned" | "fossilized";
  /** Convenience flag mirroring `orphanGrade !== "active"`. */
  readonly isOrphan?: boolean;
  /** Line-level coverage ratio in [0, 1] from the coverage overlay. */
  readonly coveragePercent?: number;
  /** Covered 1-based line numbers from the coverage overlay. */
  readonly coveredLines?: readonly number[];
}

export interface FolderNode extends NodeBase {
  readonly kind: "Folder";
}

export interface FunctionNode extends LocatedNode, CallableShape {
  readonly kind: "Function";
}

export interface MethodNode extends LocatedNode, CallableShape {
  readonly kind: "Method";
  readonly owner?: string;
}

export interface ConstructorNode extends LocatedNode, CallableShape {
  readonly kind: "Constructor";
  readonly owner?: string;
}

export interface ClassNode extends LocatedNode, TypeDeclShape {
  readonly kind: "Class";
}

export interface InterfaceNode extends LocatedNode, TypeDeclShape {
  readonly kind: "Interface";
}

export interface StructNode extends LocatedNode, TypeDeclShape {
  readonly kind: "Struct";
}

export interface TraitNode extends LocatedNode, TypeDeclShape {
  readonly kind: "Trait";
}

export interface EnumNode extends LocatedNode, TypeDeclShape {
  readonly kind: "Enum";
}

export interface ImplNode extends LocatedNode {
  readonly kind: "Impl";
  readonly isExported?: boolean;
}

export interface TypeAliasNode extends LocatedNode {
  readonly kind: "TypeAlias";
  readonly isExported?: boolean;
}

export interface ConstNode extends LocatedNode, ValueDeclShape {
  readonly kind: "Const";
  readonly isExported?: boolean;
}

export interface StaticNode extends LocatedNode, ValueDeclShape {
  readonly kind: "Static";
  readonly isExported?: boolean;
}

export interface VariableNode extends LocatedNode, ValueDeclShape {
  readonly kind: "Variable";
  readonly isExported?: boolean;
}

export interface PropertyNode extends LocatedNode, ValueDeclShape {
  readonly kind: "Property";
  readonly owner?: string;
}

export interface MacroNode extends LocatedNode {
  readonly kind: "Macro";
  readonly isExported?: boolean;
}

export interface TypedefNode extends LocatedNode {
  readonly kind: "Typedef";
  readonly isExported?: boolean;
}

export interface UnionNode extends LocatedNode, TypeDeclShape {
  readonly kind: "Union";
}

export interface NamespaceNode extends LocatedNode {
  readonly kind: "Namespace";
  readonly isExported?: boolean;
}

export interface RecordNode extends LocatedNode, TypeDeclShape {
  readonly kind: "Record";
}

export interface DelegateNode extends LocatedNode {
  readonly kind: "Delegate";
  readonly signature?: string;
  readonly isExported?: boolean;
}

export interface AnnotationNode extends LocatedNode {
  readonly kind: "Annotation";
  readonly isExported?: boolean;
}

export interface TemplateNode extends LocatedNode {
  readonly kind: "Template";
  readonly isExported?: boolean;
}

export interface ModuleNode extends LocatedNode {
  readonly kind: "Module";
  readonly isExported?: boolean;
}

export interface CodeElementNode extends LocatedNode {
  readonly kind: "CodeElement";
  readonly content?: string;
  readonly contentHash?: string;
}

export interface CommunityNode extends NodeBase {
  readonly kind: "Community";
  readonly symbolCount?: number;
  readonly cohesion?: number;
  readonly inferredLabel?: string;
  readonly keywords?: readonly string[];
  // --- Community-level ownership metrics. ---
  /**
   * Aggregate truck factor over the community's member files — a population-
   * level Gini-derived headcount proxy. Rounded integer, never less than 1.
   */
  readonly truckFactor?: number;
  /** Stddev of top-3 contributor line-shares over the last 30 days. */
  readonly ownershipDrift30d?: number;
  /** Stddev of top-3 contributor line-shares over the last 90 days. */
  readonly ownershipDrift90d?: number;
  /** Stddev of top-3 contributor line-shares over the last 365 days. */
  readonly ownershipDrift365d?: number;
}

export interface ProcessNode extends NodeBase {
  readonly kind: "Process";
  readonly entryPointId?: string;
  readonly stepCount?: number;
  readonly inferredLabel?: string;
}

export interface SectionNode extends LocatedNode {
  readonly kind: "Section";
  readonly level?: number;
  readonly content?: string;
}

export interface RouteNode extends NodeBase {
  readonly kind: "Route";
  readonly url: string;
  readonly method?: string;
  readonly responseKeys?: readonly string[];
}

export interface ToolNode extends NodeBase {
  readonly kind: "Tool";
  readonly toolName: string;
  readonly description?: string;
  /**
   * JSON-encoded input schema captured from the MCP / JSON-RPC tool
   * definition literal. Canonical (key-sorted) so downstream consumers can
   * diff two tool declarations byte-for-byte.
   */
  readonly inputSchemaJson?: string;
}

/** SARIF-sourced static-analysis finding anchored to a code location. */
export interface FindingNode extends LocatedNode {
  readonly kind: "Finding";
  readonly ruleId: string;
  readonly severity: "error" | "warning" | "note" | "none";
  readonly scannerId: string;
  readonly message: string;
  readonly propertiesBag: Record<string, unknown>;
  /**
   * SARIF `partialFingerprints["opencodehub/v1"]` — a content-plus-context
   * hash produced by `enrichWithFingerprints` that survives line-level
   * shifts and file renames. Used as the match key for baseline diffs.
   */
  readonly partialFingerprint?: string;
  /**
   * SARIF 2.1.0 `result.baselineState` tag, resolved against the frozen
   * baseline SARIF when one exists. When no baseline is configured the
   * column stays NULL and consumers should treat every finding as `new`.
   */
  readonly baselineState?: "new" | "unchanged" | "updated" | "absent";
  /**
   * JSON-encoded suppression metadata: `{ rules: [...], reasonCategory: ... }`
   * for findings suppressed via `.codehub/suppressions.yaml` or an inline
   * `codehub-suppress:` comment. NULL when the finding is not suppressed.
   */
  readonly suppressedJson?: string;
}

/** External package dependency resolved from a lockfile or manifest. */
export interface DependencyNode extends NodeBase {
  readonly kind: "Dependency";
  readonly version: string;
  readonly ecosystem: "npm" | "pypi" | "go" | "cargo" | "maven" | "nuget";
  readonly lockfileSource: string;
  readonly license?: string;
}

/** OpenAPI / HTTP operation (method + templated path). */
export interface OperationNode extends NodeBase {
  readonly kind: "Operation";
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "TRACE";
  readonly path: string;
  readonly summary?: string;
  readonly operationId?: string;
}

/**
 * Code author/maintainer derived from git history.
 *
 * Privacy default: only `emailHash` (sha256 of lowercased email) is stored.
 * `emailPlain` is opt-in and must only be populated when the indexing
 * configuration explicitly enables plain-email emission.
 */
export interface ContributorNode extends NodeBase {
  readonly kind: "Contributor";
  readonly emailHash: string;
  readonly emailPlain?: string;
}

/**
 * Structured framework detection result emitted by the `profile` phase
 * frameworks detector. Covers the top-20 frameworks catalog. One object per
 * detected framework; variant and version fields are populated when the
 * fingerprint supplies them.
 */
export type FrameworkCategory =
  | "runtime"
  | "ui"
  | "meta"
  | "backend_http"
  | "data_layer"
  | "build"
  | "test"
  | "mobile_desktop"
  | "styling"
  | "cms"
  | "monorepo"
  | "signals";

/**
 * Structured evidence for a single framework detection. Each entry is a
 * citation — which detection stage produced it, which source file or symbol
 * supplied the signal, and a short human-readable detail. Replaces the
 * unstructured `signals: string[]` field on v1.0 graphs.
 *
 * The wired profile-time pipeline emits stages 1 (manifest), 2 (lockfile),
 * and 4 (folder/file marker). Stages 3 (config-AST) and 5 (imports) ship as
 * standalone, independently-tested modules in `@opencodehub/frameworks` but
 * are not yet wired — stage 5 in particular needs the materialized IMPORTS
 * edges, which do not exist at profile time (profile is a leaf on `scan`).
 * The `stage` union keeps 3 and 5 as reserved, forward-looking values.
 */
export interface Evidence {
  /** Which detection stage produced this evidence (1=manifest, 2=lockfile, 3=config-AST, 4=folder, 5=imports). Profile-time wiring emits 1/2/4; 3 and 5 are reserved. */
  readonly stage: 1 | 2 | 3 | 4 | 5;
  /** Source file path or symbol id that supplied the signal. */
  readonly source: string;
  /** Human-readable discovery. */
  readonly detail: string;
}

export interface FrameworkDetection {
  readonly name: string;
  readonly category: FrameworkCategory;
  readonly variant?: string;
  readonly version?: string;
  readonly confidence: "deterministic" | "heuristic" | "composite";
  /**
   * Structured evidence the framework-detection pipeline produced. Sorted
   * deterministically by (stage, source, detail) for byte-stable output.
   */
  readonly evidence: readonly Evidence[];
  readonly parentName?: string;
}

/** Detected repository profile (languages, frameworks, sources). Singleton per repo. */
export interface ProjectProfileNode extends NodeBase {
  readonly kind: "ProjectProfile";
  readonly languages: readonly string[];
  /**
   * Flat-string framework list (v1.0 surface). Kept for backward compat.
   * New consumers should prefer `frameworksDetected` for variant/version info.
   */
  readonly frameworks: readonly string[];
  /**
   * Structured framework detections populated by the `profile` phase's
   * frameworks detector. One object per detected framework covering the
   * top-20 catalog with variant, version, confidence, and signal fields.
   * Absent on legacy v1.0 graphs.
   */
  readonly frameworksDetected?: readonly FrameworkDetection[];
  readonly iacTypes: readonly string[];
  readonly apiContracts: readonly string[];
  readonly manifests: readonly string[];
  readonly srcDirs: readonly string[];
}

/**
 * First-class repo entity. One per indexed repository.
 *
 * Synthesizes the Sourcegraph-style repository URI scheme with SCIP
 * `Metadata.toolInfo`: a stable cross-repo handle (`repoUri`) plus the
 * indexer name + version that produced this graph.
 *
 * Singleton per graph — constructed via `makeNodeId("Repo", "", "repo")` so
 * the id stays stable across clones of the same repo on different absolute
 * paths (mirroring ProjectProfileNode). `indexTime` is deliberately kept OUT
 * of `pack_hash` / `graphHash` inputs (it serializes as a node field but does
 * not feed determinism-sensitive pipelines) so two indexes built from the
 * same commit yield byte-identical graph hashes.
 */
export interface RepoNode extends NodeBase {
  readonly kind: "Repo";
  /** Canonical remote URL; null when no git remote exists. */
  readonly originUrl: string | null;
  /**
   * Sourcegraph-style host-path key. Example: `github.com/org/repo`.
   *
   * When `originUrl` is null, this is `local:<sha256(absolute-path)[:12]>`
   * so the handle remains deterministic and distinguishable.
   */
  readonly repoUri: string;
  /** Default branch at index time. Example: `main`. Null when detached or unknown. */
  readonly defaultBranch: string | null;
  /** 40-char commit SHA the index was built against. */
  readonly commitSha: string;
  /** RFC-3339 UTC. Kept OUT of pack_hash / graphHash determinism inputs. */
  readonly indexTime: string;
  /** Federation-group tag. Null when the repo isn't in a group. */
  readonly group: string | null;
  /** Visibility for MCP gating. Defaults to `private`. */
  readonly visibility: "private" | "internal" | "public";
  /** Name+version of the indexer, per SCIP `Metadata.toolInfo`. */
  readonly indexer: string;
  /**
   * Language distribution by fraction. Example: `{ ts: 0.83, py: 0.14 }`.
   * Sum is bounded at 1.0. Keys sorted for byte-stable serialization.
   */
  readonly languageStats: Readonly<Record<string, number>>;
}

export type GraphNode =
  | FileNode
  | FolderNode
  | FunctionNode
  | MethodNode
  | ConstructorNode
  | ClassNode
  | InterfaceNode
  | StructNode
  | TraitNode
  | EnumNode
  | ImplNode
  | TypeAliasNode
  | ConstNode
  | StaticNode
  | VariableNode
  | PropertyNode
  | MacroNode
  | TypedefNode
  | UnionNode
  | NamespaceNode
  | RecordNode
  | DelegateNode
  | AnnotationNode
  | TemplateNode
  | ModuleNode
  | CodeElementNode
  | CommunityNode
  | ProcessNode
  | SectionNode
  | RouteNode
  | ToolNode
  | FindingNode
  | DependencyNode
  | OperationNode
  | ContributorNode
  | ProjectProfileNode
  | RepoNode;

/**
 * Discriminated-union narrow keyed by the node's `kind` discriminator.
 * Used by typed finders (`IGraphStore.listNodesByKind<K>`) so the result
 * type is a single concrete node interface rather than the wide
 * {@link GraphNode} union.
 *
 * Example:
 *   ```ts
 *   const findings: readonly NodeOfKind<"Finding">[] =
 *     await store.listNodesByKind("Finding");
 *   // findings[0].severity is now typed as the FindingNode severity union,
 *   // not the discriminated GraphNode union.
 *   ```
 */
export type NodeOfKind<K extends NodeKind> = Extract<GraphNode, { kind: K }>;

export interface Embedding {
  readonly id: string;
  readonly nodeId: NodeId;
  readonly chunkIndex: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly vector: readonly number[];
  readonly contentHash: string;
  readonly modelId: string;
}
