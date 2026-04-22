// Partial-path search engine.
//
// Given one or more stack graphs (per-file) and a starting reference node,
// enumerate paths whose symbol stack eventually empties at a pop node that
// carries a `definitionTarget`. We use BFS rather than DFS so the first
// result found is also the shortest — a natural ranking signal when several
// alternative definitions exist (e.g. conditional imports).
//
// Semantics (simplified, intentionally narrower than upstream):
//   * Every `push` node appends its symbol to the current stack.
//   * Every `pop` node must match the top of the stack; path is pruned if
//     the top differs.
//   * A path terminates successfully when it lands on a pop node whose
//     `definitionTarget` is set and the remaining stack is empty.
//   * `root` nodes hop to every other graph's root, enabling cross-file
//     resolution without having to model a global scope stack.
//
// Determinism is provided by sorting each node's outgoing edges on
// (descending precedence, ascending target id) before expansion. That gives
// us reproducible traversal order regardless of insertion order.

import type {
  NodeId,
  PartialPathResult,
  ResolvedDefinition,
  StackGraph,
  StackGraphEdge,
} from "./types.js";
import { MAX_PARTIAL_PATH_DEPTH } from "./types.js";

/** Map a graph by file path so the traversal can hop across graphs. */
export type GraphIndex = ReadonlyMap<string, StackGraph>;

/** Internal BFS state element. */
interface Frontier {
  readonly nodeId: NodeId;
  readonly graphFile: string;
  readonly symbolStack: readonly string[];
  readonly depth: number;
  readonly visitedKey: string;
}

function edgeSortKey(e: StackGraphEdge): string {
  // Sort by descending precedence (higher first), then ascending target id
  // to keep iteration deterministic across runs.
  const invPrec = String(10_000 - e.precedence).padStart(6, "0");
  return `${invPrec}|${e.target}`;
}

function outgoingEdges(graph: StackGraph, nodeId: NodeId): readonly StackGraphEdge[] {
  const out: StackGraphEdge[] = [];
  for (const e of graph.edges) {
    if (e.source === nodeId) out.push(e);
  }
  return out.sort((a, b) => (edgeSortKey(a) < edgeSortKey(b) ? -1 : 1));
}

function makeVisitedKey(graphFile: string, nodeId: NodeId, stack: readonly string[]): string {
  return `${graphFile}|${nodeId}|${stack.join(">")}`;
}

/**
 * Resolve a reference within a per-file graph. `startGraphFile` is the key
 * into `graphs` at which the search begins.
 */
export function resolveReference(
  graphs: GraphIndex,
  startGraphFile: string,
  referenceNodeId: NodeId,
): PartialPathResult {
  const startGraph = graphs.get(startGraphFile);
  if (startGraph === undefined) return { results: [], truncated: false };
  const startNode = startGraph.nodes.get(referenceNodeId);
  if (startNode === undefined) return { results: [], truncated: false };

  const results: ResolvedDefinition[] = [];
  const visited = new Set<string>();
  const initialStack: readonly string[] = startNode.symbol === undefined ? [] : [startNode.symbol];
  const queue: Frontier[] = [];
  queue.push({
    nodeId: referenceNodeId,
    graphFile: startGraphFile,
    symbolStack: initialStack,
    depth: 0,
    visitedKey: makeVisitedKey(startGraphFile, referenceNodeId, initialStack),
  });
  visited.add(queue[0]?.visitedKey ?? "");

  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    if (current.depth > MAX_PARTIAL_PATH_DEPTH) {
      truncated = true;
      continue;
    }
    const graph = graphs.get(current.graphFile);
    if (graph === undefined) continue;
    const node = graph.nodes.get(current.nodeId);
    if (node === undefined) continue;

    // Successful termination: we landed on a pop node whose own symbol
    // has already been consumed via the inbound edge traversal (stack.length
    // now zero) AND the node advertises a definitionTarget.
    if (
      node.kind === "pop" &&
      node.definitionTarget !== undefined &&
      current.symbolStack.length === 0
    ) {
      results.push({
        targetNodeId: node.id,
        targetKey: `${graph.file}:${node.line ?? 0}:${node.definitionTarget}`,
        pathLength: current.depth,
      });
      // Don't continue from a successful terminal — any further traversal
      // would leave the stack empty and then try to pop with nothing to
      // pop, which is semantically invalid.
      continue;
    }

    // Cross-graph hop at root nodes.
    if (node.kind === "root") {
      for (const [otherFile, otherGraph] of graphs) {
        if (otherFile === current.graphFile) continue;
        const key = makeVisitedKey(otherFile, otherGraph.rootNodeId, current.symbolStack);
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push({
          nodeId: otherGraph.rootNodeId,
          graphFile: otherFile,
          symbolStack: current.symbolStack,
          depth: current.depth + 1,
          visitedKey: key,
        });
      }
    }

    for (const edge of outgoingEdges(graph, current.nodeId)) {
      const nextNode = graph.nodes.get(edge.target);
      if (nextNode === undefined) continue;
      let nextStack: readonly string[] | null = current.symbolStack;
      if (nextNode.kind === "push" && nextNode.symbol !== undefined) {
        nextStack = [...current.symbolStack, nextNode.symbol];
      } else if (nextNode.kind === "pop" && nextNode.symbol !== undefined) {
        const top = current.symbolStack[current.symbolStack.length - 1];
        if (top !== nextNode.symbol) {
          // Pop mismatch — prune.
          nextStack = null;
        } else {
          nextStack = current.symbolStack.slice(0, -1);
        }
      }
      if (nextStack === null) continue;
      const key = makeVisitedKey(current.graphFile, edge.target, nextStack);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({
        nodeId: edge.target,
        graphFile: current.graphFile,
        symbolStack: nextStack,
        depth: current.depth + 1,
        visitedKey: key,
      });
    }
  }

  // Sort by path length (shorter first) for deterministic output.
  results.sort((a, b) => {
    if (a.pathLength !== b.pathLength) return a.pathLength - b.pathLength;
    return a.targetKey < b.targetKey ? -1 : 1;
  });
  return { results, truncated };
}
