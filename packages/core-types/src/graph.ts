import type { CodeRelation } from "./edges.js";
import { canonicalJson } from "./hash.js";
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

// Deterministic tiebreak for equal-primary merges: compare the canonical-JSON
// projection of two records and keep the byte-smaller one. canonicalJson sorts
// object keys, so this ordering is independent of field insertion order — which
// is the property addNode/addEdge need so that full vs incremental re-indexes
// (which can present the same id in different phase/scan orders) converge on the
// same winner and therefore the same graphHash.
function canonicalCompare(a: unknown, b: unknown): number {
  const ca = canonicalJson(a);
  const cb = canonicalJson(b);
  if (ca < cb) return -1;
  if (ca > cb) return 1;
  return 0;
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
    const candidateFields = definedFieldCount(node);
    const existingFields = definedFieldCount(existing);
    if (candidateFields > existingFields) {
      this.nodeById.set(node.id, node);
      return;
    }
    // Equal field count: break the tie deterministically by canonical-JSON
    // order so the survivor never depends on which writer arrived first.
    if (candidateFields === existingFields && canonicalCompare(node, existing) < 0) {
      this.nodeById.set(node.id, node);
    }
  }

  addEdge(edge: Omit<CodeRelation, "id">): void {
    const key = edgeDedupKey(edge);
    const existing = this.edgeByKey.get(key);
    const id = makeEdgeId(edge.from, edge.type, edge.to, edge.step);
    // Canonicalize the step sentinel AT THE GRAPH BOUNDARY. `step: 0` and an
    // absent step are already the same edge by identity — both `edgeDedupKey`
    // and `makeEdgeId` collapse them via `step ?? 0`. But a candidate object
    // that literally carries `step: 0` serializes as `"step":0` in graphHash,
    // while every storage adapter's `listEdges` drops it via `stepZeroSentinel`
    // — so a rebuilt graph would hash differently from the original. Strip a
    // zero/non-finite step here so the in-memory canonical edge matches what
    // round-trips through any IGraphStore. (Closes the latent parity gap the
    // SQLite migration surfaced: the old graphdb-roundtrip test only passed
    // because its test-local rebuild re-attached step:0.)
    const { step: rawStep, ...edgeRest } = edge;
    const normalizedStep =
      typeof rawStep === "number" && Number.isFinite(rawStep) && rawStep !== 0
        ? rawStep
        : undefined;
    const candidate: CodeRelation =
      normalizedStep === undefined
        ? { ...edgeRest, id }
        : { ...edgeRest, step: normalizedStep, id };
    if (!existing) {
      this.edgeByKey.set(key, candidate);
      return;
    }
    if (candidate.confidence > existing.confidence) {
      this.edgeByKey.set(key, candidate);
      return;
    }
    // Equal confidence: `reason` is part of the graphHash-serialized payload,
    // so the survivor must not depend on insertion order. Break the tie by
    // canonical-JSON order of the full edge record.
    if (candidate.confidence === existing.confidence && canonicalCompare(candidate, existing) < 0) {
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
