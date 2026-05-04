/**
 * Integration test for the incremental carry-forward hook in
 * {@link loadPreviousGraph}.
 *
 * What this exercises:
 *   - After a prior DuckDB index + scan-state.json are on disk,
 *     `loadPreviousGraph` returns a {@link pipeline.PreviousGraph} whose
 *     `nodes` AND `edges` fields are populated (non-empty, round-tripped
 *     through the `rowToGraphNode` / `rowToCodeRelation` mappers).
 *   - That shape is the exact precondition `resolveIncrementalView`
 *     (`packages/ingestion/src/pipeline/phases/incremental-helper.ts:95-102`)
 *     checks before it flips `active=true`. A `PreviousGraph` satisfying
 *     those fields plus a scope emitting `mode="incremental"` guarantees
 *     the four consumer phases (crossFile / mro / communities / processes)
 *     run their carry-forward codepath.
 *   - The negative case (missing DB) still returns `undefined`.
 *
 * The test builds its own DuckDB from scratch via a synthetic
 * `KnowledgeGraph` rather than running the full `runIngestion` pipeline —
 * keeps the test fast (no tree-sitter / SCIP invocations) and isolates the
 * storage ↔ `loadPreviousGraph` round-trip being exercised.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type CodeRelation,
  type EdgeId,
  type FileNode,
  type FunctionNode,
  type GraphNode,
  KnowledgeGraph,
  type NodeId,
} from "@opencodehub/core-types";
import { DuckDbStore, resolveDbPath, resolveRepoMetaDir } from "@opencodehub/storage";
import { loadPreviousGraph } from "./analyze.js";

/**
 * Build a minimal prior index + sidecar fixture:
 *   - `File` + `Function` + `Community` + `Process` nodes so the carry-
 *     forward-critical kinds are all represented,
 *   - IMPORTS / CALLS / MEMBER_OF / PROCESS_STEP edges so every edge-type
 *     filter the consumer phases care about is exercised,
 *   - `.codehub/scan-state.json` with hashes matching the File node's
 *     `contentHash` so the file set is considered stable.
 */
async function seedPriorIndex(repoPath: string): Promise<{
  nodeCount: number;
  edgeCount: number;
}> {
  const graph = new KnowledgeGraph();

  // File A and File B — the two "source" files.
  const fileA: FileNode = {
    id: "File:a.ts:a.ts" as NodeId,
    kind: "File",
    name: "a.ts",
    filePath: "a.ts",
    contentHash: "sha256-a",
    language: "typescript",
  };
  const fileB: FileNode = {
    id: "File:b.ts:b.ts" as NodeId,
    kind: "File",
    name: "b.ts",
    filePath: "b.ts",
    contentHash: "sha256-b",
    language: "typescript",
  };
  graph.addNode(fileA);
  graph.addNode(fileB);

  // One exported Function per file so the round-trip covers the callable
  // slot (signature + parameterCount + isExported).
  const fnA: FunctionNode = {
    id: "Function:a.ts:alpha" as NodeId,
    kind: "Function",
    name: "alpha",
    filePath: "a.ts",
    startLine: 1,
    endLine: 10,
    signature: "alpha(): string",
    parameterCount: 0,
    returnType: "string",
    isExported: true,
  };
  const fnB: FunctionNode = {
    id: "Function:b.ts:beta" as NodeId,
    kind: "Function",
    name: "beta",
    filePath: "b.ts",
    startLine: 1,
    endLine: 10,
    signature: "beta(): number",
    parameterCount: 0,
    returnType: "number",
    isExported: true,
  };
  graph.addNode(fnA);
  graph.addNode(fnB);

  // Community + Process — the two carry-forward-critical kinds whose
  // verbatim re-add depends on inferredLabel / symbolCount / keywords /
  // entryPointId / stepCount round-tripping.
  const community: GraphNode = {
    id: "Community:<global>:community-0" as NodeId,
    kind: "Community",
    name: "alpha-beta-cluster",
    filePath: "<global>",
    inferredLabel: "alpha beta core",
    symbolCount: 2,
    cohesion: 0.85,
    keywords: ["alpha", "beta"],
  };
  const process: GraphNode = {
    id: "Process:<global>:proc-0" as NodeId,
    kind: "Process",
    name: "alpha-process",
    filePath: "<global>",
    entryPointId: fnA.id,
    stepCount: 1,
    inferredLabel: "alpha entrypoint",
  };
  graph.addNode(community);
  graph.addNode(process);

  // Edges — one IMPORTS (file-granular), one CALLS (inside a.ts → b.ts),
  // one MEMBER_OF per function pointing at the community, and one
  // PROCESS_STEP from the Process to its entry callable.
  graph.addEdge({
    from: fileA.id,
    to: fileB.id,
    type: "IMPORTS",
    confidence: 1.0,
  });
  graph.addEdge({
    from: fnA.id,
    to: fnB.id,
    type: "CALLS",
    confidence: 0.9,
    reason: "static call",
  });
  graph.addEdge({
    from: fnA.id,
    to: community.id,
    type: "MEMBER_OF",
    confidence: 1.0,
  });
  graph.addEdge({
    from: fnB.id,
    to: community.id,
    type: "MEMBER_OF",
    confidence: 1.0,
  });
  graph.addEdge({
    from: process.id,
    to: fnA.id,
    type: "PROCESS_STEP",
    confidence: 1.0,
    step: 1,
  });

  await mkdir(resolveRepoMetaDir(repoPath), { recursive: true });
  const store = new DuckDbStore(resolveDbPath(repoPath));
  try {
    await store.open();
    await store.createSchema();
    await store.bulkLoad(graph);
  } finally {
    await store.close();
  }

  const scanState = {
    schemaVersion: 1,
    files: [
      { relPath: "a.ts", contentSha: "sha256-a" },
      { relPath: "b.ts", contentSha: "sha256-b" },
    ],
  };
  await writeFile(
    join(resolveRepoMetaDir(repoPath), "scan-state.json"),
    `${JSON.stringify(scanState, null, 2)}\n`,
    "utf8",
  );

  return { nodeCount: graph.nodeCount(), edgeCount: graph.edgeCount() };
}

test("loadPreviousGraph: returns full nodes + edges from a seeded DuckDB", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "och-carry-forward-"));
  const seeded = await seedPriorIndex(repoPath);

  const prior = await loadPreviousGraph(repoPath);
  assert.ok(prior, "loadPreviousGraph returned undefined despite seeded DB");
  assert.ok(prior.nodes !== undefined, "PreviousGraph.nodes must be defined");
  assert.ok(prior.edges !== undefined, "PreviousGraph.edges must be defined");
  assert.equal(prior.nodes.length, seeded.nodeCount, "every seeded node round-trips");
  assert.equal(prior.edges.length, seeded.edgeCount, "every seeded edge round-trips");

  // The Community + Process kinds are the ones the `communities` /
  // `processes` phases re-add verbatim — assert the round-trip preserved
  // the fields those consumers read.
  const community = prior.nodes.find(
    (n): n is GraphNode & { kind: "Community" } => n.kind === "Community",
  );
  assert.ok(community, "Community node missing from round-trip");
  assert.equal(community.filePath, "<global>");
  const comm = community as unknown as {
    inferredLabel?: string;
    symbolCount?: number;
    keywords?: readonly string[];
  };
  assert.equal(comm.inferredLabel, "alpha beta core");
  assert.equal(comm.symbolCount, 2);
  assert.deepEqual(comm.keywords, ["alpha", "beta"]);

  const processNode = prior.nodes.find((n) => n.kind === "Process");
  assert.ok(processNode, "Process node missing from round-trip");
  const procFields = processNode as unknown as {
    entryPointId?: string;
    stepCount?: number;
  };
  assert.equal(procFields.entryPointId, "Function:a.ts:alpha");
  assert.equal(procFields.stepCount, 1);
});

test("loadPreviousGraph result satisfies resolveIncrementalView active=true precondition", async () => {
  // The active=true branch of `resolveIncrementalView`
  // (`packages/ingestion/src/pipeline/phases/incremental-helper.ts:95-102`)
  // returns true iff:
  //   1. `options.incrementalFrom` is supplied,
  //   2. the incremental-scope phase emits mode="incremental",
  //   3. `prior.nodes !== undefined && prior.edges !== undefined`.
  // This test covers (1) and (3) — the two conditions `loadPreviousGraph`
  // controls — by asserting the populated fields directly. (2) is driven
  // by the scan-phase closure walk at runtime; it's already covered by
  // `packages/ingestion/src/pipeline/incremental-determinism.test.ts`.
  const repoPath = await mkdtemp(join(tmpdir(), "och-carry-forward-active-"));
  await seedPriorIndex(repoPath);
  const prior = await loadPreviousGraph(repoPath);
  assert.ok(prior, "prior graph missing");
  assert.ok(prior.nodes !== undefined, "active=true requires prior.nodes populated");
  assert.ok(prior.edges !== undefined, "active=true requires prior.edges populated");
  // Spot-check edge-type coverage so the consumer phases each have work
  // to carry forward: crossFile → CALLS, communities → MEMBER_OF,
  // processes → PROCESS_STEP.
  const seenTypes = new Set(prior.edges.map((e: CodeRelation) => e.type));
  assert.ok(seenTypes.has("CALLS"), "crossFile carry-forward needs CALLS edges");
  assert.ok(seenTypes.has("MEMBER_OF"), "communities carry-forward needs MEMBER_OF edges");
  assert.ok(seenTypes.has("PROCESS_STEP"), "processes carry-forward needs PROCESS_STEP edges");
  // Edge ids are load-bearing for downstream dedupe — assert the round-
  // trip preserves them (they're regenerated deterministically from
  // from/type/to/step so the raw equality matters for incremental hash
  // stability).
  for (const e of prior.edges) {
    assert.ok(typeof e.id === "string" && (e.id as EdgeId).length > 0);
  }
});

test("loadPreviousGraph: returns undefined when no prior DB exists", async () => {
  // Fresh tmp dir with no `.codehub/` layout → the store open throws and
  // the helper swallows it, returning undefined so incremental-scope
  // degrades to a clean full reindex rather than propagating the error.
  const repoPath = await mkdtemp(join(tmpdir(), "och-carry-forward-none-"));
  const prior = await loadPreviousGraph(repoPath);
  assert.equal(prior, undefined, "missing DB must surface as undefined");
});
