import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { cochangePhase, DEFAULT_MAX_FILES_PER_COMMIT } from "./cochange.js";
import { TEMPORAL_PHASE_NAME, type TemporalOutput } from "./temporal.js";

function makeCtx(): PipelineContext {
  const graph = new KnowledgeGraph();
  // Any mutation of the graph by the cochange phase is a regression: the phase
  // should write strictly to the cochanges table (via its output), never to
  // `ctx.graph`. Proxy `addEdge` so tests can assert on accidental writes.
  const guarded = new Proxy(graph, {
    get(target, prop, receiver) {
      if (prop === "addEdge") {
        return (...args: unknown[]) => {
          throw new Error(
            `cochange phase unexpectedly called graph.addEdge(${JSON.stringify(args)})`,
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    repoPath: "/unused",
    options: {} as PipelineContext["options"],
    graph: guarded,
    phaseOutputs: new Map(),
  };
}

function temporalFixture(
  commits: ReadonlyArray<{ sha: string; files: readonly string[]; ct?: number }>,
): TemporalOutput {
  return {
    signalsEmitted: 0,
    filesSkipped: 0,
    windowDays: 365,
    subprocessCount: 2,
    commitFileLists: commits.map((c, i) => ({
      sha: c.sha,
      files: [...c.files].sort(),
      ct: c.ct ?? 1_700_000_000 + i,
    })),
  };
}

describe("cochangePhase — empty / skip behaviour", () => {
  it("emits zero rows when temporal reports no commits", async () => {
    const ctx = makeCtx();
    const deps = new Map<string, unknown>([[TEMPORAL_PHASE_NAME, temporalFixture([])]]);
    const out = await cochangePhase.run(ctx, deps);
    assert.equal(out.rows.length, 0);
    assert.equal(out.rowsEmitted, 0);
    assert.equal(out.totalCommits, 0);
  });

  it("throws when temporal output is missing from dep map", async () => {
    const ctx = makeCtx();
    await assert.rejects(() => cochangePhase.run(ctx, new Map()), /temporal output missing/);
  });
});

describe("cochangePhase — lift computation", () => {
  it("emits one row per ordered pair with correct lift + per-file totals", async () => {
    // 4 commits:
    //  c1: a.ts, b.ts       (co-commits a,b + 1 each on a,b)
    //  c2: a.ts, b.ts       (co-commits a,b + 1 each on a,b)
    //  c3: a.ts, c.ts       (co-commit a,c + 1 on a, 1 on c)
    //  c4: d.ts, e.ts       (co-commit d,e + 1 on d, 1 on e)
    // N_total = 4
    // totals: a=3, b=2, c=1, d=1, e=1
    // pair (a,b): cocount=2, lift = (2*4)/(3*2) = 8/6 = 1.3333...
    // pair (a,c): cocount=1, lift = (1*4)/(3*1) = 1.3333...
    // pair (d,e): cocount=1, lift = (1*4)/(1*1) = 4
    const ctx = makeCtx();
    const deps = new Map<string, unknown>([
      [
        TEMPORAL_PHASE_NAME,
        temporalFixture([
          { sha: "1", files: ["a.ts", "b.ts"], ct: 1_700_000_100 },
          { sha: "2", files: ["a.ts", "b.ts"], ct: 1_700_000_200 },
          { sha: "3", files: ["a.ts", "c.ts"], ct: 1_700_000_300 },
          { sha: "4", files: ["d.ts", "e.ts"], ct: 1_700_000_400 },
        ]),
      ],
    ]);

    const out = await cochangePhase.run(ctx, deps);
    assert.equal(out.rowsEmitted, 3);
    assert.equal(out.totalCommits, 4);
    assert.equal(out.commitsSkipped, 0);
    const byPair = new Map(out.rows.map((r) => [`${r.sourceFile}|${r.targetFile}`, r]));

    const ab = byPair.get("a.ts|b.ts");
    assert.ok(ab);
    assert.equal(ab?.cocommitCount, 2);
    assert.equal(ab?.totalCommitsSource, 3);
    assert.equal(ab?.totalCommitsTarget, 2);
    assert.equal(ab?.lift, 1.3333);
    assert.equal(ab?.lastCocommitAt, new Date(1_700_000_200_000).toISOString());

    const de = byPair.get("d.ts|e.ts");
    assert.ok(de);
    assert.equal(de?.lift, 4);
    assert.equal(de?.cocommitCount, 1);
    assert.equal(de?.lastCocommitAt, new Date(1_700_000_400_000).toISOString());
  });
});

describe("cochangePhase — mass-rename skip", () => {
  it("drops commits that touch more files than the cap", async () => {
    const ctx = makeCtx();
    const renameFiles = Array.from(
      { length: DEFAULT_MAX_FILES_PER_COMMIT + 1 },
      (_, i) => `src/f${i.toString().padStart(3, "0")}.ts`,
    );
    const deps = new Map<string, unknown>([
      [TEMPORAL_PHASE_NAME, temporalFixture([{ sha: "deadbeef", files: renameFiles }])],
    ]);
    const out = await cochangePhase.run(ctx, deps);
    assert.equal(out.totalCommits, 1);
    assert.equal(out.commitsSkipped, 1);
    assert.equal(out.rowsEmitted, 0);
  });

  it("respects an operator-supplied cap", async () => {
    const ctx: PipelineContext = {
      repoPath: "/unused",
      options: { cochangeMaxFilesPerCommit: 2 } as PipelineContext["options"],
      graph: new KnowledgeGraph(),
      phaseOutputs: new Map(),
    };
    const deps = new Map<string, unknown>([
      [TEMPORAL_PHASE_NAME, temporalFixture([{ sha: "aaa111", files: ["x.ts", "y.ts", "z.ts"] }])],
    ]);
    const out = await cochangePhase.run(ctx, deps);
    assert.equal(out.commitsSkipped, 1);
    assert.equal(out.rowsEmitted, 0);
  });
});

describe("cochangePhase — determinism", () => {
  it("two runs produce byte-identical row sets", async () => {
    const fixture = temporalFixture([
      { sha: "c1", files: ["pkg/a.ts", "pkg/b.ts"], ct: 1_700_001_000 },
      { sha: "c2", files: ["pkg/b.ts", "pkg/c.ts"], ct: 1_700_002_000 },
      { sha: "c3", files: ["pkg/a.ts", "pkg/c.ts"], ct: 1_700_003_000 },
      { sha: "c4", files: ["pkg/a.ts", "pkg/d.ts", "pkg/e.ts"], ct: 1_700_004_000 },
    ]);

    const runOnce = async (): Promise<string> => {
      const ctx = makeCtx();
      const deps = new Map<string, unknown>([[TEMPORAL_PHASE_NAME, fixture]]);
      const out = await cochangePhase.run(ctx, deps);
      return JSON.stringify(out.rows);
    };
    const a = await runOnce();
    const b = await runOnce();
    assert.equal(a, b);
  });
});

describe("cochangePhase — never mutates the graph", () => {
  it("does not call ctx.graph.addEdge even for a rich commit history", async () => {
    // The `makeCtx` helper proxies `addEdge` to throw; if the phase ever
    // regresses and tries to emit a COCHANGES edge we'll see it here.
    const ctx = makeCtx();
    const deps = new Map<string, unknown>([
      [
        TEMPORAL_PHASE_NAME,
        temporalFixture([
          { sha: "x", files: ["a.ts", "b.ts"] },
          { sha: "y", files: ["b.ts", "c.ts"] },
          { sha: "z", files: ["a.ts", "c.ts"] },
        ]),
      ],
    ]);
    const out = await cochangePhase.run(ctx, deps);
    assert.ok(out.rowsEmitted > 0);
  });
});
