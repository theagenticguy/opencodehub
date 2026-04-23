import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { FileNode } from "@opencodehub/core-types";
import { KnowledgeGraph, makeNodeId } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { cochangePhase, DEFAULT_MAX_FILES_PER_COMMIT } from "./cochange.js";
import { TEMPORAL_PHASE_NAME, type TemporalOutput } from "./temporal.js";

function addFileNode(graph: KnowledgeGraph, relPath: string): void {
  const node: FileNode = {
    id: makeNodeId("File", relPath, relPath),
    kind: "File",
    name: relPath.split("/").pop() ?? relPath,
    filePath: relPath,
  };
  graph.addNode(node);
}

function makeCtx(graph: KnowledgeGraph): PipelineContext {
  return {
    repoPath: "/unused",
    options: {} as PipelineContext["options"],
    graph,
    phaseOutputs: new Map(),
  };
}

function temporalFixture(
  commits: ReadonlyArray<{ sha: string; files: readonly string[] }>,
): TemporalOutput {
  return {
    signalsEmitted: 0,
    filesSkipped: 0,
    windowDays: 365,
    subprocessCount: 2,
    commitFileLists: commits.map((c) => ({
      sha: c.sha,
      files: [...c.files].sort(),
    })),
  };
}

describe("cochangePhase — empty / skip behaviour", () => {
  it("emits zero edges when temporal reports no commits", async () => {
    const graph = new KnowledgeGraph();
    const ctx = makeCtx(graph);
    const deps = new Map<string, unknown>([[TEMPORAL_PHASE_NAME, temporalFixture([])]]);
    const out = await cochangePhase.run(ctx, deps);
    assert.equal(out.edges1hopEmitted, 0);
    assert.equal(out.edges2hopEmitted, 0);
    assert.equal(out.totalCommits, 0);
    assert.equal(graph.edgeCount(), 0);
  });

  it("throws when temporal output is missing from dep map", async () => {
    const graph = new KnowledgeGraph();
    const ctx = makeCtx(graph);
    await assert.rejects(() => cochangePhase.run(ctx, new Map()), /temporal output missing/);
  });
});

describe("cochangePhase — 1-hop co-change counting", () => {
  it("counts co-commits and emits canonical COCHANGES edges", async () => {
    const graph = new KnowledgeGraph();
    for (const p of ["a.ts", "b.ts", "c.ts"]) addFileNode(graph, p);
    const ctx = makeCtx(graph);

    // 3 commits: (a,b), (a,b), (a,c). So (a,b) count=2 is strongest.
    const deps = new Map<string, unknown>([
      [
        TEMPORAL_PHASE_NAME,
        temporalFixture([
          { sha: "111aaa", files: ["a.ts", "b.ts"] },
          { sha: "222bbb", files: ["a.ts", "b.ts"] },
          { sha: "333ccc", files: ["a.ts", "c.ts"] },
        ]),
      ],
    ]);

    const out = await cochangePhase.run(ctx, deps);
    assert.equal(out.totalCommits, 3);
    assert.equal(out.commitsSkipped, 0);
    assert.equal(out.edges1hopEmitted, 2);

    const cochangeEdges = [...graph.edges()].filter((e) => e.type === "COCHANGES");
    assert.equal(cochangeEdges.length, out.edges1hopEmitted + out.edges2hopEmitted);

    const aId = makeNodeId("File", "a.ts", "a.ts");
    const bId = makeNodeId("File", "b.ts", "b.ts");
    const cId = makeNodeId("File", "c.ts", "c.ts");

    // Canonical direction: lex-smaller id as `from`.
    const ab = cochangeEdges.find(
      (e) => e.from === (aId < bId ? aId : bId) && e.to === (aId < bId ? bId : aId),
    );
    assert.ok(ab, "a.ts <-> b.ts edge must exist");
    assert.equal(ab?.step, 0);
    const reasonAB = JSON.parse(ab?.reason ?? "{}");
    assert.equal(reasonAB.hops, 1);
    assert.equal(reasonAB.coCommitCount, 2);
    // Max count = 2; (a,b) is the max so score = log(3)/log(3) = 1.0
    assert.equal(ab?.confidence, 1);

    const ac = cochangeEdges.find(
      (e) => e.from === (aId < cId ? aId : cId) && e.to === (aId < cId ? cId : aId),
    );
    assert.ok(ac, "a.ts <-> c.ts edge must exist");
    const reasonAC = JSON.parse(ac?.reason ?? "{}");
    assert.equal(reasonAC.hops, 1);
    assert.equal(reasonAC.coCommitCount, 1);
    // log(2)/log(3) ≈ 0.6309
    assert.ok(ac !== undefined && ac.confidence > 0 && ac.confidence < 1);
  });
});

describe("cochangePhase — mass-rename skip", () => {
  it("drops commits that touch more files than the cap", async () => {
    const graph = new KnowledgeGraph();
    // 51 files all touched in one commit — must NOT emit pair edges.
    const renameFiles = Array.from(
      { length: DEFAULT_MAX_FILES_PER_COMMIT + 1 },
      (_, i) => `src/f${i.toString().padStart(3, "0")}.ts`,
    );
    for (const f of renameFiles) addFileNode(graph, f);

    const ctx = makeCtx(graph);
    const deps = new Map<string, unknown>([
      [TEMPORAL_PHASE_NAME, temporalFixture([{ sha: "deadbeef", files: renameFiles }])],
    ]);

    const out = await cochangePhase.run(ctx, deps);
    assert.equal(out.totalCommits, 1);
    assert.equal(out.commitsSkipped, 1);
    assert.equal(out.edges1hopEmitted, 0);
    assert.equal(out.edges2hopEmitted, 0);

    const cochangeEdges = [...graph.edges()].filter((e) => e.type === "COCHANGES");
    assert.equal(cochangeEdges.length, 0);
  });

  it("respects an operator-supplied cap", async () => {
    const graph = new KnowledgeGraph();
    for (const f of ["x.ts", "y.ts", "z.ts"]) addFileNode(graph, f);

    // With cap=2, a 3-file commit is dropped.
    const ctx: PipelineContext = {
      repoPath: "/unused",
      options: { cochangeMaxFilesPerCommit: 2 } as PipelineContext["options"],
      graph,
      phaseOutputs: new Map(),
    };
    const deps = new Map<string, unknown>([
      [TEMPORAL_PHASE_NAME, temporalFixture([{ sha: "aaa111", files: ["x.ts", "y.ts", "z.ts"] }])],
    ]);
    const out = await cochangePhase.run(ctx, deps);
    assert.equal(out.commitsSkipped, 1);
    assert.equal(out.edges1hopEmitted, 0);
  });
});

describe("cochangePhase — 2-hop closure", () => {
  it("emits a->c transitive edge via chain a-b, b-c", async () => {
    const graph = new KnowledgeGraph();
    for (const p of ["a.ts", "b.ts", "c.ts"]) addFileNode(graph, p);

    // Two disjoint commits create the chain a-b-c with no direct a-c.
    const ctx = makeCtx(graph);
    const deps = new Map<string, unknown>([
      [
        TEMPORAL_PHASE_NAME,
        temporalFixture([
          { sha: "111", files: ["a.ts", "b.ts"] },
          { sha: "222", files: ["b.ts", "c.ts"] },
        ]),
      ],
    ]);
    const out = await cochangePhase.run(ctx, deps);
    assert.equal(out.edges1hopEmitted, 2, "expect (a,b) and (b,c) 1-hop edges");
    assert.equal(out.edges2hopEmitted, 1, "expect (a,c) 2-hop edge");

    const cochangeEdges = [...graph.edges()].filter((e) => e.type === "COCHANGES");
    const aId = makeNodeId("File", "a.ts", "a.ts");
    const cId = makeNodeId("File", "c.ts", "c.ts");
    const ac = cochangeEdges.find(
      (e) => e.from === (aId < cId ? aId : cId) && e.to === (aId < cId ? cId : aId),
    );
    assert.ok(ac, "a.ts <-> c.ts 2-hop edge must exist");
    const reason = JSON.parse(ac?.reason ?? "{}");
    assert.equal(reason.hops, 2);
    // 2-hop confidence is dampened versus 1-hop (scaled by 0.5).
    assert.ok(
      ac !== undefined && ac.confidence > 0 && ac.confidence < 1,
      `2-hop confidence expected in (0,1), got ${ac?.confidence}`,
    );
  });

  it("does not emit 2-hop when a 1-hop edge already exists", async () => {
    const graph = new KnowledgeGraph();
    for (const p of ["a.ts", "b.ts", "c.ts"]) addFileNode(graph, p);

    // Triangle — every pair co-commits directly. No 2-hop edges should
    // be added because every candidate is already a direct neighbor.
    const ctx = makeCtx(graph);
    const deps = new Map<string, unknown>([
      [
        TEMPORAL_PHASE_NAME,
        temporalFixture([
          { sha: "111", files: ["a.ts", "b.ts"] },
          { sha: "222", files: ["b.ts", "c.ts"] },
          { sha: "333", files: ["a.ts", "c.ts"] },
        ]),
      ],
    ]);
    const out = await cochangePhase.run(ctx, deps);
    assert.equal(out.edges1hopEmitted, 3);
    assert.equal(out.edges2hopEmitted, 0);
  });
});

describe("cochangePhase — determinism", () => {
  it("two runs produce byte-identical edge sets", async () => {
    const fixture = temporalFixture([
      { sha: "c1", files: ["pkg/a.ts", "pkg/b.ts"] },
      { sha: "c2", files: ["pkg/b.ts", "pkg/c.ts"] },
      { sha: "c3", files: ["pkg/a.ts", "pkg/c.ts"] },
      { sha: "c4", files: ["pkg/a.ts", "pkg/d.ts", "pkg/e.ts"] },
    ]);

    const runOnce = async (): Promise<string> => {
      const graph = new KnowledgeGraph();
      for (const p of ["pkg/a.ts", "pkg/b.ts", "pkg/c.ts", "pkg/d.ts", "pkg/e.ts"])
        addFileNode(graph, p);
      const ctx = makeCtx(graph);
      const deps = new Map<string, unknown>([[TEMPORAL_PHASE_NAME, fixture]]);
      await cochangePhase.run(ctx, deps);
      const edges = graph.orderedEdges().filter((e) => e.type === "COCHANGES");
      return JSON.stringify(
        edges.map((e) => ({
          from: e.from,
          to: e.to,
          confidence: e.confidence,
          reason: e.reason,
        })),
      );
    };
    const a = await runOnce();
    const b = await runOnce();
    assert.equal(a, b);
  });
});
