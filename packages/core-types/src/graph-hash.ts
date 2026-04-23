import type { KnowledgeGraph } from "./graph.js";
import { canonicalJson, sha256Hex } from "./hash.js";

export function graphHash(graph: KnowledgeGraph): string {
  const payload = {
    nodes: graph.orderedNodes(),
    edges: graph.orderedEdges(),
  };
  return sha256Hex(canonicalJson(payload));
}
