import type { CodeRelation } from "./edges.js";
import type { GraphNode } from "./nodes.js";

export function compareNodesById(a: GraphNode, b: GraphNode): number {
  const ai = a.id as string;
  const bi = b.id as string;
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
}

export function compareEdges(a: CodeRelation, b: CodeRelation): number {
  const af = a.from as string;
  const bf = b.from as string;
  if (af < bf) return -1;
  if (af > bf) return 1;
  if (a.type < b.type) return -1;
  if (a.type > b.type) return 1;
  const at = a.to as string;
  const bt = b.to as string;
  if (at < bt) return -1;
  if (at > bt) return 1;
  const as = a.step ?? 0;
  const bs = b.step ?? 0;
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

export function sortNodes(nodes: Iterable<GraphNode>): GraphNode[] {
  return [...nodes].sort(compareNodesById);
}

export function sortEdges(edges: Iterable<CodeRelation>): CodeRelation[] {
  return [...edges].sort(compareEdges);
}
