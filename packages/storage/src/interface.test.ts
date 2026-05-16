import assert from "node:assert/strict";
import { test } from "node:test";
import type { CochangeRow, IGraphStore, ITemporalStore, Store } from "./interface.js";

// ---------------------------------------------------------------------------
// Structural separation between IGraphStore and ITemporalStore
// ---------------------------------------------------------------------------

/**
 * Compile-time + runtime assertion that the graph-tier interface no longer
 * carries any temporal-tier method. The TypeScript checker enforces the
 * separation through the `IGraphStoreShape` type below; the runtime test
 * doubles as a regression guard against accidentally re-merging the
 * surfaces.
 */

// `keyof IGraphStore` MUST NOT include any of these temporal-only names.
// `Exclude` returns `never` when none of the listed keys overlap, which is
// what we want; the static assertion below pins the property to `never`.
type IGraphStoreTemporalLeak = Extract<
  keyof IGraphStore,
  | "exec"
  | "bulkLoadCochanges"
  | "lookupCochangesForFile"
  | "lookupCochangesBetween"
  | "bulkLoadSymbolSummaries"
  | "lookupSymbolSummary"
  | "lookupSymbolSummariesByNode"
>;
// Compile-fail wedge: if any temporal name leaked back into IGraphStore the
// `never` constraint below stops typechecking. Keep this line as-is.
const _temporalLeakWedge: IGraphStoreTemporalLeak extends never ? true : never = true;
void _temporalLeakWedge; // satisfies noUnusedLocals while preserving the type assertion

// Symmetric: `ITemporalStore` MUST NOT carry any graph-tier method names
// other than the lifecycle methods it shares (open/close/createSchema/
// healthCheck — those are intentional overlap because both views need
// them).
type ITemporalStoreGraphLeak = Extract<
  keyof ITemporalStore,
  | "bulkLoad"
  | "upsertEmbeddings"
  | "listEmbeddingHashes"
  | "listNodes"
  | "search"
  | "vectorSearch"
  | "traverse"
  | "getMeta"
  | "setMeta"
  | "execCypher"
  | "dialect"
>;
const _graphLeakWedge: ITemporalStoreGraphLeak extends never ? true : never = true;
void _graphLeakWedge;

// Function-typing wedge: a value satisfying IGraphStore must be REJECTED
// by a parameter typed as ITemporalStore (and vice-versa). We can't
// directly run a "compile-fail" test, but we can demonstrate the
// distinct shapes by constructing minimal stubs. If the interfaces ever
// merge again, the assignments below either both succeed or both fail
// — the inequality is what we want.
test("IGraphStore-shaped value lacks temporal methods at runtime", () => {
  // Minimal IGraphStore stub. Intentionally typed precisely as IGraphStore
  // so the structural shape is enforced by the checker.
  // The minimal stub carries thin no-op implementations for each typed
  // finder so the structural shape continues to be enforced by the
  // checker.
  // eslint-disable-next-line require-yield
  async function* emptyEmbeddings() {
    // intentionally empty
  }
  const graphOnly: IGraphStore = {
    dialect: "cypher",
    open: async () => {},
    close: async () => {},
    createSchema: async () => {},
    bulkLoad: async () => ({ nodeCount: 0, edgeCount: 0, durationMs: 0 }),
    upsertEmbeddings: async () => {},
    listEmbeddingHashes: async () => new Map<string, string>(),
    listEmbeddings: () => emptyEmbeddings(),
    listNodes: async () => [],
    listNodesByKind: async () => [],
    listEdges: async () => [],
    listEdgesByType: async () => [],
    listFindings: async () => [],
    listDependencies: async () => [],
    listRoutes: async () => [],
    getRepoNode: async () => undefined,
    listNodesByEntryPoint: async () => [],
    listNodesByName: async () => [],
    countNodesByKind: async () => new Map(),
    countEdgesByType: async () => new Map(),
    search: async () => [],
    vectorSearch: async () => [],
    traverse: async () => [],
    traverseAncestors: async () => [],
    traverseDescendants: async () => [],
    listConsumerProducerEdges: async () => [],
    getMeta: async () => undefined,
    setMeta: async () => {},
    healthCheck: async () => ({ ok: true }),
  };

  const bag = graphOnly as unknown as Record<string, unknown>;
  assert.equal(typeof bag["lookupCochangesForFile"], "undefined");
  assert.equal(typeof bag["lookupSymbolSummary"], "undefined");
  assert.equal(typeof bag["exec"], "undefined");
  assert.equal(graphOnly.dialect, "cypher");
});

test("ITemporalStore-shaped value lacks graph methods at runtime", () => {
  const temporalOnly: ITemporalStore = {
    open: async () => {},
    close: async () => {},
    createSchema: async () => {},
    healthCheck: async () => ({ ok: true }),
    exec: async () => [],
    exportEmbeddingsToParquet: async () => ({ rowCount: 0, duckdbVersion: "test" }),
    bulkLoadCochanges: async () => {},
    lookupCochangesForFile: async (): Promise<readonly CochangeRow[]> => [],
    lookupCochangesBetween: async () => undefined,
    bulkLoadSymbolSummaries: async () => {},
    lookupSymbolSummary: async () => undefined,
    lookupSymbolSummariesByNode: async () => [],
  };

  const bag = temporalOnly as unknown as Record<string, unknown>;
  assert.equal(typeof bag["listNodes"], "undefined");
  assert.equal(typeof bag["bulkLoad"], "undefined");
  assert.equal(typeof bag["search"], "undefined");
  assert.equal(typeof bag["vectorSearch"], "undefined");
  assert.equal(typeof bag["dialect"], "undefined");
});

test("Store alias matches OpenStoreResult composition", () => {
  // Exercises the type alias only; structural-equality is handled at the
  // type level. The runtime side of this test asserts that a properly-
  // typed Store value carries the four required keys.
  const dummy: Store = {
    graph: undefined as unknown as IGraphStore,
    temporal: undefined as unknown as ITemporalStore,
    graphFile: "/tmp/.codehub/graph.lbug",
    temporalFile: "/tmp/.codehub/temporal.duckdb",
    close: async () => {},
  };
  assert.equal(dummy.graphFile, "/tmp/.codehub/graph.lbug");
  assert.equal(dummy.temporalFile, "/tmp/.codehub/temporal.duckdb");
  assert.equal(typeof dummy.close, "function");
});
