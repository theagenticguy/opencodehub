/**
 * Public-interface parity harness.
 *
 * One backend-agnostic rebuilder that uses ONLY public {@link IGraphStore}
 * methods: {@link IGraphStore.listNodes} and {@link IGraphStore.listEdges}.
 * Replaces a pair of hand-written per-backend rebuild helpers — each
 * issuing raw SQL or Cypher — with a single dialect-free path.
 *
 * A community AGE / Memgraph / Neo4j / Neptune adapter can prove
 * conformance by importing {@link assertGraphParity} and running it
 * against its own `IGraphStore` implementation — no per-backend SQL
 * dialect required, no escape hatch into `query()` or `execCypher()`.
 *
 * The four sentinel rules described in `interface.ts` (step-zero drop,
 * empty-`languageStats` coercion, Repo nullable preservation, deadness
 * normalization) are enforced by the in-tree adapters at the public
 * boundary — `listNodes` / `listEdges` already return rehydrated objects
 * that match the original `GraphNode` / `CodeRelation` shape on every
 * adapter today. This harness therefore performs no extra coercion: the
 * symmetric round-trip is "list everything back, hand it to a fresh
 * KnowledgeGraph". Any conformance-failing adapter has a bug, not a
 * harness mismatch.
 */

import assert from "node:assert/strict";
import { type CodeRelation, graphHash, KnowledgeGraph } from "@opencodehub/core-types";
import type { IGraphStore } from "../interface.js";

// Re-export the boundary helpers from `column-encode.ts` so third-party
// adapter authors can import a single test-utils module rather than reach
// into the package internals when they implement their own write/read
// path. These are the canonical implementations of the four sentinel
// rules; new adapters should call them rather than reinvent the rules.
export {
  applyRepoNullables,
  coerceLanguageStats,
  stepZeroSentinel,
} from "../column-encode.js";

/**
 * Rebuild a `KnowledgeGraph` from any `IGraphStore` using only public
 * methods. Calls `listNodes({})` + `listEdges({})` and packages the
 * results into a fresh `KnowledgeGraph` — no raw SQL, no Cypher, no
 * dialect coupling.
 *
 * Conformance contract: any `IGraphStore` adapter whose `bulkLoad` is
 * round-trip stable produces byte-identical `graphHash` output via this
 * rebuilder. Use {@link assertGraphParity} to verify a third-party
 * adapter conforms.
 */
export async function rebuildFromStore(graph: IGraphStore): Promise<KnowledgeGraph> {
  const nodes = await graph.listNodes({});
  const edges = await graph.listEdges({});
  const out = new KnowledgeGraph();
  for (const node of nodes) {
    out.addNode(node);
  }
  for (const edge of edges) {
    // `addEdge` accepts `Omit<CodeRelation, "id">` and recomputes the id
    // via `makeEdgeId`. Strip the stored id so the rebuilt edge gets the
    // canonical id for free; this also keeps the rebuilt KnowledgeGraph
    // identical regardless of how the source backend chose to derive its
    // edge ids on bulkLoad.
    const { id: _id, ...rest } = edge as CodeRelation;
    out.addEdge(rest);
  }
  return out;
}

/**
 * Assert that bulkLoading a fixture into N graph adapters and rebuilding
 * each via {@link rebuildFromStore} produces byte-identical `graphHash`
 * output across all of them — and against the original fixture.
 *
 * Each store is expected to be already opened and schema-initialised
 * (i.e. `open()` + `createSchema()` already called by the caller). The
 * harness only owns the bulk-load → rebuild → hash sequence.
 *
 * The assertions run in two passes:
 *
 *   1. For every store, `graphHash(rebuilt) === graphHash(fixture)`.
 *      Surfaces a per-store regression with a precise error message.
 *   2. Pairwise across every store pair, the rebuilt hashes also match.
 *      Catches the failure mode where two different stores silently
 *      coincide on a different hash than the source fixture (which
 *      would otherwise mask one bug behind the other).
 */
export async function assertGraphParity(
  fixture: KnowledgeGraph,
  opts: { readonly stores: readonly IGraphStore[]; readonly label?: string },
): Promise<void> {
  const { stores } = opts;
  if (stores.length === 0) {
    throw new Error("assertGraphParity: opts.stores must contain at least one IGraphStore");
  }
  const label = opts.label ?? "parity";
  const original = graphHash(fixture);
  const hashes: string[] = [];
  for (let i = 0; i < stores.length; i += 1) {
    const store = stores[i] as IGraphStore;
    await store.bulkLoad(fixture);
    const rebuilt = await rebuildFromStore(store);
    const got = graphHash(rebuilt);
    assert.equal(
      got,
      original,
      `[${label}] store[${i}] round-trip broke graphHash\n` +
        `  original: ${original}\n` +
        `  rebuilt:  ${got}`,
    );
    hashes.push(got);
  }
  // Cross-store byte equality. Redundant with the per-store check when
  // every store matched the original, but kept so a future regression
  // surfaces a "store[i] vs store[j]" message without the developer
  // having to re-derive which stores actually matched.
  for (let i = 0; i < hashes.length; i += 1) {
    for (let j = i + 1; j < hashes.length; j += 1) {
      assert.equal(
        hashes[j],
        hashes[i],
        `[${label}] cross-store parity broken — store[${i}] vs store[${j}]\n` +
          `  store[${i}]: ${hashes[i]}\n` +
          `  store[${j}]: ${hashes[j]}`,
      );
    }
  }
}
