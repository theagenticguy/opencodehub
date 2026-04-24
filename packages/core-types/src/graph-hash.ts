import { createHash } from "node:crypto";
import type { KnowledgeGraph } from "./graph.js";
import { writeCanonicalJson } from "./hash.js";

/**
 * SHA-256 of the graph's canonical-JSON projection `{edges, nodes}` (keys
 * sorted — `edges` before `nodes`).
 *
 * Implementation streams each node and edge through the SHA-256 updater so
 * we never materialize the full canonical-JSON string. For a 1.3 M-edge
 * repo the concatenated string would exceed V8's max-string-length limit
 * and throw `RangeError: Invalid string length`; the streaming path stays
 * O(longest-single-record) in string size.
 *
 * Byte-for-byte identical to `sha256Hex(canonicalJson({nodes, edges}))` on
 * inputs small enough for the all-in-memory path to succeed. The determinism
 * tests in `graph-hash.test.ts` cover cross-permutation stability; the
 * upstream tests must not change hex output for fixture-sized graphs.
 */
export function graphHash(graph: KnowledgeGraph): string {
  const hasher = createHash("sha256");
  const write = (chunk: string): void => {
    hasher.update(chunk, "utf8");
  };

  // `canonicalJson` sorts object keys, so the top-level object is serialized
  // as `{"edges":[...],"nodes":[...]}`. We replicate that layout exactly
  // here, emitting separators by hand and streaming each array element one
  // at a time through `writeCanonicalJson`.
  write('{"edges":[');
  const edges = graph.orderedEdges();
  for (let i = 0; i < edges.length; i += 1) {
    if (i > 0) write(",");
    writeCanonicalJson(edges[i], write);
  }
  write('],"nodes":[');
  const nodes = graph.orderedNodes();
  for (let i = 0; i < nodes.length; i += 1) {
    if (i > 0) write(",");
    writeCanonicalJson(nodes[i], write);
  }
  write("]}");

  return hasher.digest("hex");
}
