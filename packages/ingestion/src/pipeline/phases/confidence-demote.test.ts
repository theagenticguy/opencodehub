import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NodeId } from "@opencodehub/core-types";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { CONFIDENCE_DEMOTE_PHASE_NAME, confidenceDemotePhase } from "./confidence-demote.js";

// `KnowledgeGraph.addEdge` dedupes by `(from, type, to, step)` and keeps the
// higher-confidence entry. Tests that need a heuristic 0.5 edge to coexist
// with a 1.0 LSP edge at the same `(from, type, to)` therefore differ only
// on `step` — an edge-specific disambiguator that the phase intentionally
// ignores when matching triples.
const HEURISTIC_STEP = 1;

function buildCtx(): { ctx: PipelineContext; events: ProgressEvent[] } {
  const events: ProgressEvent[] = [];
  const ctx: PipelineContext = {
    repoPath: "/tmp/och-demote-test",
    options: { skipGit: true },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
    onProgress: (ev) => {
      events.push(ev);
    },
  };
  return { ctx, events };
}

function findEdge(
  ctx: PipelineContext,
  predicate: (reason: string | undefined, confidence: number) => boolean,
) {
  for (const edge of ctx.graph.edges()) {
    if (predicate(edge.reason, edge.confidence)) return edge;
  }
  return undefined;
}

describe(CONFIDENCE_DEMOTE_PHASE_NAME, () => {
  it("demotes a heuristic CALLS edge when an LSP edge covers the same triple", async () => {
    const { ctx, events } = buildCtx();
    const from = "Function:src/m.py:caller" as NodeId;
    const to = "Function:src/m.py:callee" as NodeId;

    ctx.graph.addEdge({
      from,
      to,
      type: "CALLS",
      confidence: 0.5,
      reason: "heuristic/tier-2",
      step: HEURISTIC_STEP,
    });
    ctx.graph.addEdge({
      from,
      to,
      type: "CALLS",
      confidence: 1.0,
      reason: "pyright@1.1.390",
    });

    const out = await confidenceDemotePhase.run(ctx, new Map());
    assert.equal(out.demotedCount, 1);
    assert.equal(out.perLanguage["python"], 1);

    const demoted = findEdge(ctx, (reason) => reason?.startsWith("heuristic/tier-2") === true);
    assert.ok(demoted, "heuristic edge should still exist");
    assert.equal(demoted.confidence, 0.2);
    assert.equal(demoted.reason, "heuristic/tier-2+lsp-unconfirmed");

    const lsp = findEdge(ctx, (reason) => reason === "pyright@1.1.390");
    assert.ok(lsp, "pyright edge should still exist");
    assert.equal(lsp.confidence, 1.0);
    assert.equal(lsp.reason, "pyright@1.1.390");

    const noteEvents = events.filter((e) => e.phase === CONFIDENCE_DEMOTE_PHASE_NAME);
    assert.ok(noteEvents.some((e) => e.message?.includes("python=1")));
  });

  it("is a no-op when no LSP edge exists for the heuristic triple", async () => {
    const { ctx } = buildCtx();
    const from = "Function:src/m.py:caller" as NodeId;
    const to = "Function:src/m.py:callee" as NodeId;
    ctx.graph.addEdge({
      from,
      to,
      type: "CALLS",
      confidence: 0.5,
      reason: "heuristic/tier-2",
    });

    const out = await confidenceDemotePhase.run(ctx, new Map());
    assert.equal(out.demotedCount, 0);

    const edges = [...ctx.graph.edges()];
    assert.equal(edges.length, 1);
    assert.equal(edges[0]?.confidence, 0.5);
    assert.equal(edges[0]?.reason, "heuristic/tier-2");
  });

  it("isolates demotions per language — TypeScript heuristic untouched when only Python has LSP coverage", async () => {
    const { ctx } = buildCtx();

    const pyFrom = "Function:src/a.py:caller" as NodeId;
    const pyTo = "Function:src/a.py:callee" as NodeId;
    const tsFrom = "Function:src/a.ts:caller" as NodeId;
    const tsTo = "Function:src/a.ts:callee" as NodeId;

    ctx.graph.addEdge({
      from: pyFrom,
      to: pyTo,
      type: "CALLS",
      confidence: 0.5,
      reason: "heuristic/tier-2",
      step: HEURISTIC_STEP,
    });
    ctx.graph.addEdge({
      from: pyFrom,
      to: pyTo,
      type: "CALLS",
      confidence: 1.0,
      reason: "pyright@1.1.390",
    });
    ctx.graph.addEdge({
      from: tsFrom,
      to: tsTo,
      type: "CALLS",
      confidence: 0.5,
      reason: "heuristic/tier-2",
    });

    const out = await confidenceDemotePhase.run(ctx, new Map());
    assert.equal(out.demotedCount, 1);
    assert.equal(out.perLanguage["python"], 1);
    assert.equal(out.perLanguage["typescript"], undefined);

    const pyHeuristic = findEdge(
      ctx,
      (reason) => reason?.startsWith("heuristic/tier-2") === true && reason.includes("+lsp"),
    );
    assert.ok(pyHeuristic, "python heuristic edge should be demoted");
    assert.equal(pyHeuristic.confidence, 0.2);

    const tsHeuristic = [...ctx.graph.edges()].find(
      (e) => (e.from as string) === (tsFrom as string),
    );
    assert.ok(tsHeuristic, "typescript heuristic edge should still exist");
    assert.equal(tsHeuristic.confidence, 0.5);
    assert.equal(tsHeuristic.reason, "heuristic/tier-2");
  });
});
