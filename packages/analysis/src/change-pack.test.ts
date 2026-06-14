import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";
import { type ChangePackInternal, charHeuristicTokens, runChangePack } from "./change-pack.js";
import { FakeStore } from "./test-utils.js";
import type { DetectChangesResult } from "./types.js";
import type { VerdictQuery, VerdictResponse } from "./verdict-types.js";

// ---------------------------------------------------------------------------
// Hermetic seams. runChangePack composes runDetectChanges + computeVerdict,
// both of which shell out to git. The internal seams let the suite inject a
// canned diff + verdict and an in-memory file reader so nothing spawns git or
// touches disk.
// ---------------------------------------------------------------------------

function stubVerdict(): VerdictResponse {
  return {
    verdict: "single_review",
    confidence: 0.85,
    decisionBoundary: { distancePercent: 50, nextTier: "dual_review" },
    reasoningChain: [],
    recommendedReviewers: [],
    githubLabels: ["review:single"],
    reviewCommentMarkdown: "",
    exitCode: 0,
    blastRadius: 3,
    communitiesTouched: [],
    changedFileCount: 1,
    changedFiles: ["src/a.ts"],
    affectedSymbolCount: 1,
  };
}

function makeInternal(
  changes: DetectChangesResult,
  files: Readonly<Record<string, string>> = {},
  verdict: VerdictResponse = stubVerdict(),
): ChangePackInternal {
  return {
    detectChanges: () => Promise.resolve(changes),
    computeVerdict: (_store: IGraphStore, _q: VerdictQuery) => Promise.resolve(verdict),
    readFileText: (absPath: string) => {
      const v = files[absPath];
      if (v === undefined) return Promise.reject(new Error(`ENOENT: ${absPath}`));
      return Promise.resolve(v);
    },
  };
}

function detect(symbols: DetectChangesResult["affectedSymbols"]): DetectChangesResult {
  const fileSet = new Set<string>();
  for (const s of symbols) fileSet.add(s.filePath);
  const changedFiles = [...fileSet].sort();
  return {
    changedFiles,
    affectedSymbols: symbols,
    affectedProcesses: [],
    summary: {
      fileCount: changedFiles.length,
      symbolCount: symbols.length,
      processCount: 0,
      risk: "LOW",
    },
  };
}

/**
 * Fixture: one changed symbol `foo` in src/a.ts, with three upstream callers:
 * a production caller `bar` (src/b.ts), a test `foo.test.ts:itFoo`, and a
 * deeper production caller `baz` reached via `bar`.
 *
 *   bar  --CALLS-->  foo   (bar is depth-1 upstream of foo)
 *   itFoo --CALLS--> foo   (test, depth-1)
 *   baz  --CALLS-->  bar   (baz is depth-2 upstream of foo)
 */
function fooFixture(): FakeStore {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/b.ts:bar#0",
    kind: "Function",
    name: "bar",
    filePath: "src/b.ts",
  });
  store.addNode({
    id: "Function:src/c.ts:baz#0",
    kind: "Function",
    name: "baz",
    filePath: "src/c.ts",
  });
  store.addNode({
    id: "Function:src/foo.test.ts:itFoo#0",
    kind: "Function",
    name: "itFoo",
    filePath: "src/foo.test.ts",
  });
  // File nodes back the suite-size count (totalTestCount = test-path File nodes).
  store.addNode({ id: "File:src/a.ts:src/a.ts", kind: "File", name: "a.ts", filePath: "src/a.ts" });
  store.addNode({ id: "File:src/b.ts:src/b.ts", kind: "File", name: "b.ts", filePath: "src/b.ts" });
  store.addNode({ id: "File:src/c.ts:src/c.ts", kind: "File", name: "c.ts", filePath: "src/c.ts" });
  store.addNode({
    id: "File:src/foo.test.ts:src/foo.test.ts",
    kind: "File",
    name: "foo.test.ts",
    filePath: "src/foo.test.ts",
  });
  store.addEdge({
    fromId: "Function:src/b.ts:bar#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 1.0,
  });
  store.addEdge({
    fromId: "Function:src/foo.test.ts:itFoo#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 1.0,
  });
  store.addEdge({
    fromId: "Function:src/c.ts:baz#0",
    toId: "Function:src/b.ts:bar#0",
    type: "CALLS",
    confidence: 1.0,
  });
  return store;
}

const FOO_CHANGE: DetectChangesResult["affectedSymbols"] = [
  {
    id: "Function:src/a.ts:foo#0",
    name: "foo",
    filePath: "src/a.ts",
    kind: "Function",
    changedLines: [1, 2],
  },
];

// ---------------------------------------------------------------------------
// Subgraph union + dedup + minDepth
// ---------------------------------------------------------------------------

test("runChangePack: impacted subgraph unions upstream fan-out, excludes tests by default", async () => {
  const store = fooFixture();
  const pack = await runChangePack(store, { repoPath: "/repo" }, makeInternal(detect(FOO_CHANGE)));

  const ids = pack.impactedSubgraph.nodes.map((n) => n.id);
  // Production callers retained; the test node is excluded from the subgraph.
  assert.deepEqual(ids, ["Function:src/b.ts:bar#0", "Function:src/c.ts:baz#0"]);
  assert.equal(pack.impactedSubgraph.nodeCount, 2);
  assert.equal(pack.impactedSubgraph.truncated, false);

  const bar = pack.impactedSubgraph.nodes.find((n) => n.id === "Function:src/b.ts:bar#0");
  const baz = pack.impactedSubgraph.nodes.find((n) => n.id === "Function:src/c.ts:baz#0");
  assert.equal(bar?.minDepth, 1, "bar is a direct upstream caller");
  assert.equal(baz?.minDepth, 2, "baz reaches foo through bar");

  // Edges retained only between surviving production nodes / the root symbol.
  // bar→foo (foo is the changed root) and baz→bar both survive; itFoo→foo drops.
  const edgeKeys = pack.impactedSubgraph.edges.map((e) => `${e.fromId}|${e.type}|${e.toId}`);
  assert.ok(edgeKeys.includes("Function:src/b.ts:bar#0|CALLS|Function:src/a.ts:foo#0"));
  assert.ok(edgeKeys.includes("Function:src/c.ts:baz#0|CALLS|Function:src/b.ts:bar#0"));
  assert.ok(
    !edgeKeys.some((k) => k.includes("foo.test.ts")),
    "test-incident edges must be dropped from the subgraph",
  );
  assert.equal(pack.impactedSubgraph.edgeCount, pack.impactedSubgraph.edges.length);
});

test("runChangePack: includeTestsInSubgraph retains test nodes + edges", async () => {
  const store = fooFixture();
  const pack = await runChangePack(
    store,
    { repoPath: "/repo", includeTestsInSubgraph: true },
    makeInternal(detect(FOO_CHANGE)),
  );
  const ids = pack.impactedSubgraph.nodes.map((n) => n.id);
  assert.ok(ids.includes("Function:src/foo.test.ts:itFoo#0"), "test node retained when opted in");
  const edgeKeys = pack.impactedSubgraph.edges.map((e) => `${e.fromId}|${e.type}|${e.toId}`);
  assert.ok(
    edgeKeys.includes("Function:src/foo.test.ts:itFoo#0|CALLS|Function:src/a.ts:foo#0"),
    "test-incident edge retained when opted in",
  );
});

test("runChangePack: dedup keeps min depth across two changed symbols", async () => {
  // Two changed symbols foo + bar both upstream-reach baz at different depths.
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/b.ts:bar#0",
    kind: "Function",
    name: "bar",
    filePath: "src/b.ts",
  });
  store.addNode({
    id: "Function:src/c.ts:baz#0",
    kind: "Function",
    name: "baz",
    filePath: "src/c.ts",
  });
  // baz calls bar (depth-1 from bar) and baz calls foo through bar (depth-2 from foo).
  store.addEdge({
    fromId: "Function:src/c.ts:baz#0",
    toId: "Function:src/b.ts:bar#0",
    type: "CALLS",
    confidence: 1.0,
  });
  store.addEdge({
    fromId: "Function:src/b.ts:bar#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 1.0,
  });

  const symbols: DetectChangesResult["affectedSymbols"] = [
    {
      id: "Function:src/a.ts:foo#0",
      name: "foo",
      filePath: "src/a.ts",
      kind: "Function",
      changedLines: [1],
    },
    {
      id: "Function:src/b.ts:bar#0",
      name: "bar",
      filePath: "src/b.ts",
      kind: "Function",
      changedLines: [1],
    },
  ];
  const pack = await runChangePack(store, { repoPath: "/repo" }, makeInternal(detect(symbols)));
  const baz = pack.impactedSubgraph.nodes.find((n) => n.id === "Function:src/c.ts:baz#0");
  assert.ok(baz, "baz must be in the subgraph");
  assert.equal(baz.minDepth, 1, "baz reached at depth-1 from bar wins over depth-2 from foo");
});

// ---------------------------------------------------------------------------
// Affected-test selection
// ---------------------------------------------------------------------------

test("runChangePack: affected tests = upstream isTestPath hits with reachedFromSymbol + depth", async () => {
  const store = fooFixture();
  const pack = await runChangePack(store, { repoPath: "/repo" }, makeInternal(detect(FOO_CHANGE)));

  assert.equal(pack.affectedTests.length, 1);
  const t = pack.affectedTests[0];
  assert.ok(t);
  assert.equal(t.id, "Function:src/foo.test.ts:itFoo#0");
  assert.equal(t.filePath, "src/foo.test.ts");
  assert.equal(t.reachedFromSymbol, "Function:src/a.ts:foo#0");
  assert.equal(t.depth, 1);
});

test("runChangePack: affected tests sorted by (filePath, id), deduped by id", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  // Two tests in two files; the second sorts before the first by filePath.
  store.addNode({
    id: "Function:tests/z.spec.ts:t1#0",
    kind: "Function",
    name: "t1",
    filePath: "tests/z.spec.ts",
  });
  store.addNode({
    id: "Function:tests/a.spec.ts:t2#0",
    kind: "Function",
    name: "t2",
    filePath: "tests/a.spec.ts",
  });
  store.addEdge({
    fromId: "Function:tests/z.spec.ts:t1#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 1.0,
  });
  store.addEdge({
    fromId: "Function:tests/a.spec.ts:t2#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 1.0,
  });

  const pack = await runChangePack(store, { repoPath: "/repo" }, makeInternal(detect(FOO_CHANGE)));
  const paths = pack.affectedTests.map((t) => t.filePath);
  assert.deepEqual(paths, ["tests/a.spec.ts", "tests/z.spec.ts"], "sorted by filePath asc");
});

// ---------------------------------------------------------------------------
// Cost attribution
// ---------------------------------------------------------------------------

test("charHeuristicTokens: max(1, ceil(len/4))", () => {
  assert.equal(charHeuristicTokens(""), 1);
  assert.equal(charHeuristicTokens("abc"), 1);
  assert.equal(charHeuristicTokens("abcd"), 1);
  assert.equal(charHeuristicTokens("abcde"), 2);
  assert.equal(charHeuristicTokens("a".repeat(40)), 10);
});

test("runChangePack: cost attribution computes baseline, savings, pct, ci skip", async () => {
  const store = fooFixture();
  // Give the two retained production files large bodies so the blind baseline
  // dwarfs the scoped pack and savings are positive.
  const bigBody = "x".repeat(8000);
  const files = {
    "/repo/src/b.ts": bigBody,
    "/repo/src/c.ts": bigBody,
  };
  const pack = await runChangePack(
    store,
    { repoPath: "/repo" },
    makeInternal(detect(FOO_CHANGE), files),
  );

  const cost = pack.costAttribution;
  assert.equal(cost.estimate, true);
  assert.equal(cost.tokenizerModel, "char-heuristic-v1");
  // Baseline = sum over the two impacted files (src/b.ts, src/c.ts).
  const expectedBaseline = charHeuristicTokens(bigBody) * 2;
  assert.equal(cost.blindBaselineTokens, expectedBaseline);
  assert.ok(cost.changePackTokens > 0);
  assert.equal(cost.tokensSaved, Math.max(0, cost.blindBaselineTokens - cost.changePackTokens));
  assert.equal(
    cost.tokensSavedPct,
    Math.round((cost.tokensSaved / cost.blindBaselineTokens) * 100),
  );
  // One test file in the graph (foo.test.ts); one affected → zero CI skip.
  assert.equal(cost.totalTestCount, 1);
  assert.equal(cost.affectedTestCount, 1);
  assert.equal(cost.ciTestsSkipped, 0);
});

test("runChangePack: unreadable impacted file is skipped without breaking the baseline", async () => {
  const store = fooFixture();
  // Only src/b.ts is readable; src/c.ts is missing from the fs map.
  const files = { "/repo/src/b.ts": "y".repeat(400) };
  const pack = await runChangePack(
    store,
    { repoPath: "/repo" },
    makeInternal(detect(FOO_CHANGE), files),
  );
  assert.equal(pack.costAttribution.blindBaselineTokens, charHeuristicTokens("y".repeat(400)));
});

// ---------------------------------------------------------------------------
// Empty-diff short-circuit
// ---------------------------------------------------------------------------

test("runChangePack: empty diff → empty-but-valid pack, verdict still present", async () => {
  const store = fooFixture();
  const pack = await runChangePack(store, { repoPath: "/repo" }, makeInternal(detect([])));

  assert.deepEqual(pack.changedSymbols, []);
  assert.deepEqual(pack.impactedSubgraph.nodes, []);
  assert.deepEqual(pack.impactedSubgraph.edges, []);
  assert.equal(pack.impactedSubgraph.truncated, false);
  assert.deepEqual(pack.affectedTests, []);
  assert.equal(pack.costAttribution.blindBaselineTokens, 0);
  assert.equal(pack.costAttribution.tokensSaved, 0);
  assert.equal(pack.costAttribution.tokensSavedPct, 0);
  // totalTestCount still reflects the graph; affected=0 → all skipped.
  assert.equal(pack.costAttribution.totalTestCount, 1);
  assert.equal(pack.costAttribution.ciTestsSkipped, 1);
  // Verdict is still computed.
  assert.equal(pack.verdict.verdict, "single_review");
  assert.ok(pack.changePackHash.length === 64, "hash present on empty pack");
});

// ---------------------------------------------------------------------------
// Truncation guard
// ---------------------------------------------------------------------------

test("runChangePack: subgraph truncates deterministically past the hard ceiling", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  // 5001 direct upstream callers → exceeds the 5000 cap by one.
  const total = 5001;
  for (let i = 0; i < total; i += 1) {
    const id = `Function:src/callers.ts:c_${String(i).padStart(5, "0")}#0`;
    store.addNode({ id, kind: "Function", name: `c_${i}`, filePath: "src/callers.ts" });
    store.addEdge({ fromId: id, toId: "Function:src/a.ts:foo#0", type: "CALLS", confidence: 1.0 });
  }
  const pack = await runChangePack(store, { repoPath: "/repo" }, makeInternal(detect(FOO_CHANGE)));
  assert.equal(pack.impactedSubgraph.truncated, true);
  assert.equal(pack.impactedSubgraph.nodeCount, 5000);
  assert.equal(pack.impactedSubgraph.nodes.length, 5000);
});

// ---------------------------------------------------------------------------
// Determinism + hash
// ---------------------------------------------------------------------------

test("runChangePack: deterministic — two runs yield identical hash + bytes", async () => {
  const big = "z".repeat(1234);
  const files = { "/repo/src/b.ts": big, "/repo/src/c.ts": big };

  const store1 = fooFixture();
  const store2 = fooFixture();
  const pack1 = await runChangePack(
    store1,
    { repoPath: "/repo" },
    makeInternal(detect(FOO_CHANGE), files),
  );
  const pack2 = await runChangePack(
    store2,
    { repoPath: "/repo" },
    makeInternal(detect(FOO_CHANGE), files),
  );

  assert.equal(pack1.changePackHash, pack2.changePackHash, "hashes must match");
  assert.equal(pack1.changePackHash.length, 64);
  assert.equal(
    canonicalJson(pack1),
    canonicalJson(pack2),
    "canonical-JSON bytes must be identical",
  );
});

test("runChangePack: hash changes when depth changes (envelope folded into preimage)", async () => {
  const store1 = fooFixture();
  const store2 = fooFixture();
  const pack1 = await runChangePack(
    store1,
    { repoPath: "/repo", depth: 4 },
    makeInternal(detect(FOO_CHANGE)),
  );
  const pack2 = await runChangePack(
    store2,
    { repoPath: "/repo", depth: 2 },
    makeInternal(detect(FOO_CHANGE)),
  );
  assert.notEqual(pack1.changePackHash, pack2.changePackHash, "depth is hashed");
});
