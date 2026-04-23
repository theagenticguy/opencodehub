// TypeScript / TSX / JavaScript ResolverStrategy backed by the clean-room
// stack-graphs evaluator. Mirrors `stack-graphs-python.ts` but handles the
// TS-family import/export shapes instead of Python's from/import grammar.
//
// Shapes modelled here:
//   * `import { foo } from "./bar"`          — named import.
//   * `import foo from "./bar"`              — default import (binds local).
//   * `import * as ns from "./bar"`          — namespace import (member push).
//   * `import type { X } from "./y"`         — type-only import, recorded.
//   * `export { x } from "./bar"`            — named re-export.
//   * `export { default as foo } from "./b"` — default re-export renamed.
//   * `export * from "./bar"`                — barrel-star re-export.
//   * `export default fn|expr`               — default export pop.
//   * `export function foo`                  — named export pop.
//
// We share `stack-graphs/partial-path-engine.ts` for the BFS; the node/edge
// shape is different from the Python builder though, so we keep our own
// builder inline rather than extending the shared Python builder.
//
// Like the Python strategy we register under the name `"stack-graphs"`. The
// router in `resolver-strategy.ts` dispatches by `provider.id`, so both
// strategies coexist under the same opt-in name.

import type { ResolutionCandidate, ResolutionQuery, SymbolIndex } from "./context.js";
import { CONFIDENCE_BY_TIER, resolve as threeTierResolve } from "./context.js";
import type { ResolverStrategy } from "./resolver-strategy.js";
import { resolveReference } from "./stack-graphs/partial-path-engine.js";
import type {
  NodeId,
  ReferenceQuery,
  StackGraph,
  StackGraphEdge,
  StackGraphNode,
  StackNodeKind,
} from "./stack-graphs/types.js";
import { STACK_GRAPHS_HIT_CONFIDENCE } from "./stack-graphs/types.js";

/**
 * Per-reference lookup info — the ingestion pipeline attaches (line, column)
 * to the query when delegating to stack-graphs. Mirrors the Python hinted
 * query type.
 */
export interface TsStackGraphsHintedQuery extends ResolutionQuery {
  readonly referenceLine?: number;
  readonly referenceColumn?: number;
}

interface TsStackGraphStore {
  readonly graphs: Map<string, StackGraph>;
  fallbacks: number;
  stackGraphHits: number;
}

const TS_STORE: TsStackGraphStore = {
  graphs: new Map(),
  fallbacks: 0,
  stackGraphHits: 0,
};

/**
 * Prime the TS cache with per-file stack graphs. Called by the ingestion
 * parse phase before resolution runs. Uses a store separate from Python's.
 */
export function registerTsStackGraphs(graphs: ReadonlyMap<string, StackGraph>): void {
  TS_STORE.graphs.clear();
  for (const [k, v] of graphs) TS_STORE.graphs.set(k, v);
}

/** For tests: drop all TS graphs and reset counters. */
export function clearTsStackGraphsForTests(): void {
  TS_STORE.graphs.clear();
  TS_STORE.fallbacks = 0;
  TS_STORE.stackGraphHits = 0;
}

/** Stats surfaced to the pipeline for telemetry. */
export function getTsStackGraphsStats(): {
  readonly fallbacks: number;
  readonly hits: number;
} {
  return { fallbacks: TS_STORE.fallbacks, hits: TS_STORE.stackGraphHits };
}

/** Does this query belong to a TS-family provider? */
function isTsFamilyQuery(q: ResolutionQuery): boolean {
  const id = q.provider.id;
  return id === "typescript" || id === "tsx" || id === "javascript";
}

function mapTargetKeyToResolutionId(targetKey: string): string {
  // targetKey is `${file}:${line}:${qualifiedName}`. Opaque to callers — the
  // storage layer only cares that it's unique.
  return targetKey;
}

function runStackGraphs(q: TsStackGraphsHintedQuery): ResolutionCandidate | null {
  if (TS_STORE.graphs.size === 0) return null;
  const line = q.referenceLine;
  const column = q.referenceColumn;
  if (line === undefined || column === undefined) return null;

  const graph = TS_STORE.graphs.get(q.callerFile);
  if (graph === undefined) return null;
  const refKey = `${line}:${column}`;
  const refNodeId = graph.referenceIndex.get(refKey);
  if (refNodeId === undefined) return null;

  const ref: ReferenceQuery = {
    file: q.callerFile,
    line,
    column,
    name: q.calleeName,
  };
  void ref; // carried for parity with the Python strategy signature

  try {
    const { results } = resolveReference(TS_STORE.graphs, q.callerFile, refNodeId);
    const best = results[0];
    if (best === undefined) return null;
    return {
      targetId: mapTargetKeyToResolutionId(best.targetKey),
      tier: "import-scoped",
      confidence: STACK_GRAPHS_HIT_CONFIDENCE,
    };
  } catch {
    return null;
  }
}

export const stackGraphsTsResolver: ResolverStrategy = {
  name: "stack-graphs",
  resolve(q: ResolutionQuery, index: SymbolIndex): ResolutionCandidate[] {
    if (!isTsFamilyQuery(q)) {
      return threeTierResolve(q, index);
    }
    const hinted = q as TsStackGraphsHintedQuery;
    const hit = runStackGraphs(hinted);
    if (hit !== null) {
      TS_STORE.stackGraphHits++;
      const clamped: ResolutionCandidate = {
        targetId: hit.targetId,
        tier: hit.tier,
        confidence: Math.max(hit.confidence, CONFIDENCE_BY_TIER["import-scoped"]),
      };
      return [clamped];
    }
    TS_STORE.fallbacks++;
    return threeTierResolve(q, index);
  },
};

// ---------------------------------------------------------------------------
// Builder — TS-family source → StackGraph
// ---------------------------------------------------------------------------

/**
 * Minimal import/export IR. The pipeline's parse phase produces this shape
 * from the TS tree-sitter CST; tests can also hand-author it. Keeping the
 * builder driven by a plain IR (rather than a tree-sitter node adapter)
 * means we don't need to fake the full SyntaxNode surface for every test
 * fixture — unlike the Python builder which consumes `MinimalTsNode`.
 */
export type TsImportSpec =
  | {
      readonly kind: "named";
      readonly name: string;
      readonly local: string;
      readonly module: string;
      readonly typeOnly?: boolean;
      readonly line: number;
    }
  | {
      readonly kind: "default";
      readonly local: string;
      readonly module: string;
      readonly typeOnly?: boolean;
      readonly line: number;
    }
  | {
      readonly kind: "namespace";
      readonly local: string;
      readonly module: string;
      readonly typeOnly?: boolean;
      readonly line: number;
    };

export type TsExportSpec =
  | { readonly kind: "named-local"; readonly name: string; readonly line: number }
  | { readonly kind: "default-local"; readonly target: string; readonly line: number }
  | {
      readonly kind: "named-reexport";
      readonly name: string;
      readonly imported: string;
      readonly module: string;
      readonly line: number;
    }
  | {
      readonly kind: "default-reexport-as";
      readonly name: string;
      readonly module: string;
      readonly line: number;
    }
  | { readonly kind: "star-reexport"; readonly module: string; readonly line: number };

/**
 * A reference site inside the module — typically an identifier the call
 * extractor already located. The builder emits one push-node per reference
 * so the resolver can look up (line, column).
 */
export interface TsReferenceSite {
  readonly name: string;
  readonly line: number;
  readonly column: number;
}

/**
 * All the per-file facts the builder needs. `moduleKey` is the canonical
 * identifier used both as the `graphs` map key and as the resolution target
 * for cross-file ROOT hops. Typically the absolute file path without the
 * extension; callers decide the shape as long as it's consistent with
 * `resolveModule`.
 */
export interface TsModuleFacts {
  readonly file: string;
  readonly moduleKey: string;
  readonly imports: readonly TsImportSpec[];
  readonly exports: readonly TsExportSpec[];
  readonly localDefinitions: readonly { readonly name: string; readonly line: number }[];
  readonly references: readonly TsReferenceSite[];
  /**
   * Resolve an import specifier (e.g. `"./bar"`) to a `moduleKey` string
   * matching another `TsModuleFacts.moduleKey`. Returning `null` means the
   * import target is unknown — the builder will still emit the push-chain
   * but cross-file traversal won't hop.
   */
  resolveModule(specifier: string): string | null;
}

interface MutableGraph {
  readonly file: string;
  readonly nodes: Map<NodeId, StackGraphNode>;
  readonly edges: StackGraphEdge[];
  readonly referenceIndex: Map<string, NodeId>;
  readonly rootNodeId: NodeId;
  readonly moduleScopeId: NodeId;
  /** Per-symbol pops that live on the module scope (local exports). */
  readonly moduleExportPops: Map<string, NodeId>;
  seq: number;
}

function nextId(g: MutableGraph, kind: StackNodeKind): NodeId {
  g.seq++;
  return `${g.file}#${kind}-${g.seq}`;
}

function addNode(
  g: MutableGraph,
  kind: StackNodeKind,
  opts: {
    readonly symbol?: string;
    readonly definitionTarget?: string;
    readonly line?: number;
  } = {},
): NodeId {
  const id = nextId(g, kind);
  const base = { id, kind, file: g.file } as const;
  const node: StackGraphNode = {
    ...base,
    ...(opts.symbol !== undefined ? { symbol: opts.symbol } : {}),
    ...(opts.definitionTarget !== undefined ? { definitionTarget: opts.definitionTarget } : {}),
    ...(opts.line !== undefined ? { line: opts.line } : {}),
  };
  g.nodes.set(id, node);
  return id;
}

function addEdge(g: MutableGraph, source: NodeId, target: NodeId, precedence = 0): void {
  g.edges.push({ source, target, precedence });
}

/**
 * Build a stack graph for a single TS-family module from an import/export
 * IR. The graph shape:
 *
 *   * module-scope is a `scope` node. ROOT points at it (so external
 *     lookups hitting this module begin there).
 *   * Local definitions are `pop` nodes hanging off module-scope, precedence 2.
 *   * Named imports create a local `pop` for the binding plus a push chain
 *     `[binding-name, moduleKey]` terminating at ROOT.
 *   * Default imports are identical to named imports with `imported = "default"`.
 *   * Namespace imports create a `pop` at the local name whose continuation
 *     chains straight to ROOT of the target module (the member push is
 *     generated at the reference site — see `references`).
 *   * Star re-exports emit a precedence-1 scope edge mirroring Python's
 *     wildcard handling.
 *   * Named re-exports create a local `pop` whose target is the remote
 *     module's export with the same (or renamed-from) name.
 *   * Default re-exports (`export { default as foo }`) create a local pop
 *     "foo" targeting the remote default slot.
 *   * Default exports create a local pop "default" pointing at the target.
 */
export function buildTsStackGraph(facts: TsModuleFacts): StackGraph {
  const rootNodeId: NodeId = `${facts.file}#root`;
  const moduleScopeId: NodeId = `${facts.file}#module-scope`;
  const graph: MutableGraph = {
    file: facts.file,
    nodes: new Map<NodeId, StackGraphNode>(),
    edges: [],
    referenceIndex: new Map<string, NodeId>(),
    rootNodeId,
    moduleScopeId,
    moduleExportPops: new Map(),
    seq: 0,
  };
  graph.nodes.set(rootNodeId, { id: rootNodeId, kind: "root", file: facts.file });
  graph.nodes.set(moduleScopeId, { id: moduleScopeId, kind: "scope", file: facts.file });
  // External queries enter via ROOT — ROOT → module-scope so symbol lookups
  // can traverse pops attached to module-scope.
  addEdge(graph, rootNodeId, moduleScopeId, 0);

  emitLocalDefinitions(graph, facts.localDefinitions);
  emitImports(graph, facts);
  emitExports(graph, facts);
  emitReferences(graph, facts);

  return {
    file: facts.file,
    nodes: new Map(graph.nodes),
    edges: graph.edges.slice(),
    rootNodeId: graph.rootNodeId,
    referenceIndex: new Map(graph.referenceIndex),
  };
}

function emitLocalDefinitions(
  g: MutableGraph,
  defs: readonly { readonly name: string; readonly line: number }[],
): void {
  for (const def of defs) {
    // A pop node that terminates a successful lookup for `name` inside this
    // module. Kept on module-scope with precedence 2 so local hits outrank
    // ambient re-exports (precedence 1) when both match.
    const defNode = addNode(g, "pop", {
      symbol: def.name,
      definitionTarget: def.name,
      line: def.line,
    });
    addEdge(g, g.moduleScopeId, defNode, 2);
    g.moduleExportPops.set(def.name, defNode);
  }
}

function emitImports(g: MutableGraph, facts: TsModuleFacts): void {
  for (const imp of facts.imports) {
    const targetKey = facts.resolveModule(imp.module);
    switch (imp.kind) {
      case "named":
        bindImport(g, imp.local, imp.name, targetKey, imp.module, imp.line);
        break;
      case "default":
        bindImport(g, imp.local, "default", targetKey, imp.module, imp.line);
        break;
      case "namespace":
        bindNamespaceImport(g, imp.local, targetKey, imp.module, imp.line);
        break;
    }
  }
}

/**
 * Emit the pop + push chain for a named or default import. The pop binds
 * the local name; a push chain of `[imported-name, targetKey]` terminates
 * at ROOT so the traversal hops to the module graph that provides the
 * definition.
 */
function bindImport(
  g: MutableGraph,
  local: string,
  imported: string,
  targetKey: string | null,
  specifier: string,
  line: number,
): void {
  const definitionTarget =
    targetKey !== null ? `${targetKey}.${imported}` : `${specifier}.${imported}`;
  const defNode = addNode(g, "pop", {
    symbol: local,
    definitionTarget,
    line,
  });
  addEdge(g, g.moduleScopeId, defNode, 2);

  // Push the imported name first so after the pop we expect `[imported, targetKey]`
  // on the stack; the ROOT hop then emits a push for `targetKey` (the module
  // identifier) and lands on the target graph's ROOT.
  const pushImported = addNode(g, "push", { symbol: imported, line });
  addEdge(g, defNode, pushImported, 0);
  let cursor = pushImported;
  if (targetKey !== null) {
    const pushModule = addNode(g, "push", { symbol: targetKey, line });
    addEdge(g, cursor, pushModule, 0);
    cursor = pushModule;
  }
  addEdge(g, cursor, g.rootNodeId, 0);
}

/**
 * Namespace imports (`import * as ns`) resolve `ns.member` to the target
 * module's `member` export. We emit a pop for `ns` plus a push for the
 * module key — references of the form `ns.x` show up as two push nodes
 * at the reference site (`x` then `ns`) which pop `ns` here, push `x`,
 * and hop to ROOT.
 */
function bindNamespaceImport(
  g: MutableGraph,
  local: string,
  targetKey: string | null,
  specifier: string,
  line: number,
): void {
  const definitionTarget = targetKey !== null ? `${targetKey}.*` : `${specifier}.*`;
  const defNode = addNode(g, "pop", {
    symbol: local,
    definitionTarget,
    line,
  });
  addEdge(g, g.moduleScopeId, defNode, 2);
  if (targetKey !== null) {
    const pushModule = addNode(g, "push", { symbol: targetKey, line });
    addEdge(g, defNode, pushModule, 0);
    addEdge(g, pushModule, g.rootNodeId, 0);
  } else {
    addEdge(g, defNode, g.rootNodeId, 0);
  }
}

function emitExports(g: MutableGraph, facts: TsModuleFacts): void {
  for (const exp of facts.exports) {
    switch (exp.kind) {
      case "named-local":
        // Local-only export — already represented by the local definition
        // pop on module-scope. If the def wasn't registered, emit a stub so
        // external lookups still terminate.
        if (!g.moduleExportPops.has(exp.name)) {
          const stub = addNode(g, "pop", {
            symbol: exp.name,
            definitionTarget: exp.name,
            line: exp.line,
          });
          addEdge(g, g.moduleScopeId, stub, 2);
          g.moduleExportPops.set(exp.name, stub);
        }
        break;
      case "default-local": {
        const defNode = addNode(g, "pop", {
          symbol: "default",
          definitionTarget: exp.target,
          line: exp.line,
        });
        addEdge(g, g.moduleScopeId, defNode, 2);
        g.moduleExportPops.set("default", defNode);
        break;
      }
      case "named-reexport":
        emitNamedReexport(g, facts, exp);
        break;
      case "default-reexport-as":
        emitDefaultReexportAs(g, facts, exp);
        break;
      case "star-reexport":
        emitStarReexport(g, facts, exp);
        break;
    }
  }
}

/**
 * `export { imported as name } from "./bar"` — a local pop for `name` whose
 * traversal hops through ROOT to the remote module's `imported` slot.
 */
function emitNamedReexport(
  g: MutableGraph,
  facts: TsModuleFacts,
  exp: Extract<TsExportSpec, { kind: "named-reexport" }>,
): void {
  const targetKey = facts.resolveModule(exp.module);
  const definitionTarget =
    targetKey !== null ? `${targetKey}.${exp.imported}` : `${exp.module}.${exp.imported}`;
  const defNode = addNode(g, "pop", {
    symbol: exp.name,
    definitionTarget,
    line: exp.line,
  });
  addEdge(g, g.moduleScopeId, defNode, 2);
  g.moduleExportPops.set(exp.name, defNode);

  const pushImported = addNode(g, "push", { symbol: exp.imported, line: exp.line });
  addEdge(g, defNode, pushImported, 0);
  let cursor = pushImported;
  if (targetKey !== null) {
    const pushModule = addNode(g, "push", { symbol: targetKey, line: exp.line });
    addEdge(g, cursor, pushModule, 0);
    cursor = pushModule;
  }
  addEdge(g, cursor, g.rootNodeId, 0);
}

/** `export { default as foo } from "./bar"` — same as named-reexport of "default". */
function emitDefaultReexportAs(
  g: MutableGraph,
  facts: TsModuleFacts,
  exp: Extract<TsExportSpec, { kind: "default-reexport-as" }>,
): void {
  emitNamedReexport(g, facts, {
    kind: "named-reexport",
    name: exp.name,
    imported: "default",
    module: exp.module,
    line: exp.line,
  });
}

/**
 * `export * from "./bar"` — every export in `./bar` becomes reachable from
 * this module. Mirrors Python's wildcard handling: a scope junction on
 * module-scope (precedence 1 so local pops still win on overlap) plus a
 * push chain that lands on the remote ROOT.
 */
function emitStarReexport(
  g: MutableGraph,
  facts: TsModuleFacts,
  exp: Extract<TsExportSpec, { kind: "star-reexport" }>,
): void {
  const targetKey = facts.resolveModule(exp.module);
  const junction = addNode(g, "scope", { line: exp.line });
  // Precedence 1 — beaten by local definitions/named re-exports (precedence 2)
  // but outranks ordinary fall-through edges.
  addEdge(g, g.moduleScopeId, junction, 1);
  if (targetKey !== null) {
    const pushModule = addNode(g, "push", { symbol: targetKey, line: exp.line });
    addEdge(g, junction, pushModule, 0);
    addEdge(g, pushModule, g.rootNodeId, 0);
  } else {
    addEdge(g, junction, g.rootNodeId, 0);
  }
}

function emitReferences(g: MutableGraph, facts: TsModuleFacts): void {
  for (const ref of facts.references) {
    const key = `${ref.line}:${ref.column}`;
    if (g.referenceIndex.has(key)) continue;
    const pushNode = addNode(g, "push", { symbol: ref.name, line: ref.line });
    addEdge(g, pushNode, g.moduleScopeId, 0);
    g.referenceIndex.set(key, pushNode);
  }
}
