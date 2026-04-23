import type { CodeRelation } from "./edges.js";
import { makeEdgeId, type NodeId } from "./id.js";
import type { GraphNode } from "./nodes.js";
import { sortEdges, sortNodes } from "./ordering.js";

function definedFieldCount(node: GraphNode): number {
  let n = 0;
  for (const key of Object.keys(node)) {
    const v = (node as unknown as Record<string, unknown>)[key];
    if (v !== undefined && v !== null) n += 1;
  }
  return n;
}

function edgeDedupKey(e: Pick<CodeRelation, "from" | "type" | "to" | "step">): string {
  return `${e.from}\x00${e.type}\x00${e.to}\x00${e.step ?? 0}`;
}

export class KnowledgeGraph {
  private readonly nodeById = new Map<NodeId, GraphNode>();
  private readonly edgeByKey = new Map<string, CodeRelation>();

  addNode(node: GraphNode): void {
    const existing = this.nodeById.get(node.id);
    if (!existing) {
      this.nodeById.set(node.id, node);
      return;
    }
    if (definedFieldCount(node) > definedFieldCount(existing)) {
      this.nodeById.set(node.id, node);
    }
  }

  addEdge(edge: Omit<CodeRelation, "id">): void {
    const key = edgeDedupKey(edge);
    const existing = this.edgeByKey.get(key);
    const id = makeEdgeId(edge.from, edge.type, edge.to, edge.step);
    const candidate: CodeRelation = { ...edge, id };
    if (!existing) {
      this.edgeByKey.set(key, candidate);
      return;
    }
    if (candidate.confidence > existing.confidence) {
      this.edgeByKey.set(key, candidate);
    }
  }

  hasNode(id: NodeId): boolean {
    return this.nodeById.has(id);
  }

  getNode(id: NodeId): GraphNode | undefined {
    return this.nodeById.get(id);
  }

  nodes(): IterableIterator<GraphNode> {
    return this.nodeById.values();
  }

  edges(): IterableIterator<CodeRelation> {
    return this.edgeByKey.values();
  }

  nodeCount(): number {
    return this.nodeById.size;
  }

  edgeCount(): number {
    return this.edgeByKey.size;
  }

  orderedNodes(): readonly GraphNode[] {
    return sortNodes(this.nodeById.values());
  }

  orderedEdges(): readonly CodeRelation[] {
    return sortEdges(this.edgeByKey.values());
  }
}
