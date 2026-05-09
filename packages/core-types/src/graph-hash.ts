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
 *
 * **Empty-collection contract:** `canonicalJson` (in `./hash.ts`)
 * treats an empty array `[]` and an empty object `{}` as DISTINCT from an
 * absent / `undefined` field. A node written as `{keywords: []}` emits
 * `{"keywords":[]}` in the canonical JSON projection, while the same node
 * with the `keywords` key absent emits no key at all — the two
 * canonical-JSON byte streams differ, so their SHA-256 graph hashes
 * differ. Storage adapters preserve this distinction at the writer +
 * reader boundary: see
 * `packages/storage/src/column-encode.ts:stringArrayOrNull`,
 * `packages/storage/src/duckdb-adapter.ts:setStringArrayField`,
 * `packages/storage/src/graphdb-adapter.ts:setStringArrayFieldGd`, and
 * `packages/cli/src/commands/analyze.ts:stringArrayField`. The contract
 * is exercised end-to-end by the
 * `graphHash parity: medium-with-empty-keywords` fixture in
 * `packages/storage/src/graph-hash-parity.test.ts`, which asserts both
 * (a) cross-adapter parity for `{keywords: []}` and (b) the resulting
 * hash differs from the equivalent fixture without the `keywords` key.
 *
 * The same `[]`-vs-absent semantics apply to `responseKeys` on RouteNode.
 * Empty `Record<string, number>` (`languageStats: {}`) goes through a
 * separate sentinel path — see `coerceLanguageStats` in
 * `column-encode.ts` — because that column is JSON-encoded TEXT, not a
 * native typed array.
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
