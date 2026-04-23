// Shared types for the clean-room stack-graphs evaluator.
//
// This module is a minimal, Python-scoped subset of the stack-graphs model.
// Our types are intentionally narrow. All names and semantics were chosen
// independently from any prior implementation — we model only what our
// Python rules need.

/**
 * Node roles in our simplified stack-graph. Each maps to one primitive
 * attribute family in the broader stack-graphs model, but we collapse
 * push-scoped / pop-scoped into `push`/`pop` here because Python's
 * reference model doesn't require the scope-stack machinery for the
 * re-export cases we actually resolve.
 */
export type StackNodeKind =
  | "push" //   reference site — pushes a symbol when traversed
  | "pop" //    definition site — pops a matching symbol
  | "scope" //  pass-through junction
  | "root"; // global sink for cross-file lookup

/** Opaque node identifier. Format: `${file}#${seq}` where seq is per-file. */
export type NodeId = string;

/**
 * One node in our stack graph. `symbol` is populated for push/pop kinds and
 * carries the Python identifier the node pushes or pops. `definitionTarget`
 * is set on pop nodes that correspond to concrete definitions (e.g. the
 * function / class the resolver should land on).
 */
export interface StackGraphNode {
  readonly id: NodeId;
  readonly kind: StackNodeKind;
  readonly symbol?: string;
  readonly definitionTarget?: string;
  /** Source file that created this node — useful for cross-file debugging. */
  readonly file: string;
  /** Optional line number in the source file (1-indexed). */
  readonly line?: number;
}

/** A directed edge with optional precedence (higher wins at enumeration time). */
export interface StackGraphEdge {
  readonly source: NodeId;
  readonly target: NodeId;
  readonly precedence: number;
}

/** Per-file stack graph plus the well-known root-node id. */
export interface StackGraph {
  readonly file: string;
  readonly nodes: ReadonlyMap<NodeId, StackGraphNode>;
  readonly edges: readonly StackGraphEdge[];
  /** Id of the module's per-file root — references escape to here. */
  readonly rootNodeId: NodeId;
  /** Ids of reference-push nodes, keyed by (line, column) for lookup. */
  readonly referenceIndex: ReadonlyMap<string, NodeId>;
}

/**
 * Query input: resolve the reference at this position in this file.
 * The evaluator looks up the starting push-node via `referenceIndex`.
 */
export interface ReferenceQuery {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly name: string;
}

/** A successful path resolution. */
export interface ResolvedDefinition {
  readonly targetNodeId: NodeId;
  /** Where the definition actually lives — typically `${file}:${line}:${name}`. */
  readonly targetKey: string;
  /** Length of the path in edges; shorter paths score higher. */
  readonly pathLength: number;
}

/** Confidence assigned when stack-graphs produces a hit. */
export const STACK_GRAPHS_HIT_CONFIDENCE = 0.9;

/** Budget — never enumerate a path longer than this. */
export const MAX_PARTIAL_PATH_DEPTH = 100;

/**
 * Rule-file AST — consumed by the node/edge builder. We intentionally keep
 * only the shapes our Python evaluator consults; other rule kinds
 * (let/set/var/scan) are parsed into an opaque `raw` form and ignored by
 * the builder.
 */
export type TsgMatch = {
  readonly kind: "pattern";
  /** Tree-sitter node type name the rule fires on (e.g. `module`). */
  readonly nodeType: string;
  /** Tree-sitter capture name attached to the match (e.g. `@mod`). */
  readonly capture?: string;
};

export type TsgActionKind = "node-decl" | "edge-decl" | "attr-decl" | "unknown";

export interface TsgAction {
  readonly kind: TsgActionKind;
  /** Raw action source text (debug only). */
  readonly raw: string;
}

export interface TsgRule {
  readonly patterns: readonly TsgMatch[];
  readonly actions: readonly TsgAction[];
}

/** Result returned from `resolveReference`. */
export interface PartialPathResult {
  readonly results: readonly ResolvedDefinition[];
  readonly truncated: boolean;
}
