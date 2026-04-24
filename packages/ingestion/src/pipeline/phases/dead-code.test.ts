/**
 * Dead-code phase — phase-level test.
 *
 * Hand-constructs a `PipelineContext` with a prebuilt `KnowledgeGraph` so we
 * exercise the phase's classify-then-denormalise path without pulling in the
 * full ingestion orchestrator (which would require rebuilding every
 * predecessor phase). The phase must:
 *
 *   1. Tag three unused non-exported helpers with `deadness = "dead"`.
 *   2. Tag an exported helper with no cross-module referrer with
 *      `deadness = "unreachable-export"`.
 *   3. Leave `live`-classified callables unmarked / marked `live`.
 *   4. Emit a ghost-community warning for any community whose membership is
 *      entirely non-live.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  type CodeRelation,
  type FunctionNode,
  KnowledgeGraph,
  type NodeId,
} from "@opencodehub/core-types";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { DEAD_CODE_PHASE_NAME, deadCodePhase } from "./dead-code.js";

function fn(id: string, filePath: string, isExported: boolean): FunctionNode {
  return {
    id: id as NodeId,
    kind: "Function",
    name: id.split(":").pop() ?? id,
    filePath,
    startLine: 1,
    endLine: 5,
    isExported,
  };
}

function call(fromId: string, toId: string): Omit<CodeRelation, "id"> {
  return {
    from: fromId as NodeId,
    to: toId as NodeId,
    type: "CALLS",
    confidence: 1,
  };
}

describe(`${DEAD_CODE_PHASE_NAME}Phase`, () => {
  it("tags three unused non-exported helpers as `dead` and preserves live callables", async () => {
    const graph = new KnowledgeGraph();
    // Three truly-unused non-exported functions → all dead.
    graph.addNode(fn("Function:a.ts:unusedOne", "a.ts", false));
    graph.addNode(fn("Function:a.ts:unusedTwo", "a.ts", false));
    graph.addNode(fn("Function:a.ts:unusedThree", "a.ts", false));
    // A reached helper called by an exported entry → live.
    graph.addNode(fn("Function:a.ts:reached", "a.ts", false));
    graph.addNode(fn("Function:a.ts:entry", "a.ts", true));
    graph.addNode(fn("Function:b.ts:root", "b.ts", true));
    graph.addEdge(call("Function:a.ts:entry", "Function:a.ts:reached"));
    graph.addEdge(call("Function:b.ts:root", "Function:a.ts:entry"));

    const warnings: string[] = [];
    const ctx: PipelineContext = {
      repoPath: "/tmp/fake",
      options: {},
      graph,
      phaseOutputs: new Map(),
      onProgress: (ev: ProgressEvent) => {
        if (ev.kind === "warn" && ev.message !== undefined) warnings.push(ev.message);
      },
    };
    const out = await deadCodePhase.run(ctx, new Map());
    assert.equal(out.deadCount, 3);
    // `root` is exported but nothing imports b.ts → unreachable-export.
    assert.equal(out.unreachableExportCount, 1);
    assert.equal(out.ghostCommunityCount, 0);
    assert.equal(warnings.length, 0);

    const classifications = new Map<string, string | undefined>();
    for (const n of ctx.graph.nodes()) {
      const d = (n as unknown as { readonly deadness?: string }).deadness;
      classifications.set(n.id, d);
    }
    assert.equal(classifications.get("Function:a.ts:unusedOne"), "dead");
    assert.equal(classifications.get("Function:a.ts:unusedTwo"), "dead");
    assert.equal(classifications.get("Function:a.ts:unusedThree"), "dead");
    assert.equal(classifications.get("Function:a.ts:reached"), "live");
    assert.equal(classifications.get("Function:a.ts:entry"), "live");
    // `root` is exported but nothing imports b.ts → unreachable-export.
    assert.equal(classifications.get("Function:b.ts:root"), "unreachable-export");
  });

  it("tags an exported helper with only intra-file referrers as `unreachable-export`", async () => {
    const graph = new KnowledgeGraph();
    graph.addNode(fn("Function:lib.ts:orphanExport", "lib.ts", true));
    graph.addNode(fn("Function:lib.ts:localHelper", "lib.ts", false));
    graph.addEdge(call("Function:lib.ts:localHelper", "Function:lib.ts:orphanExport"));
    const ctx: PipelineContext = {
      repoPath: "/tmp/fake",
      options: {},
      graph,
      phaseOutputs: new Map(),
    };
    const out = await deadCodePhase.run(ctx, new Map());
    assert.equal(out.unreachableExportCount, 1);
    const orphan = ctx.graph.getNode("Function:lib.ts:orphanExport" as NodeId);
    assert.ok(orphan);
    assert.equal(
      (orphan as unknown as { readonly deadness?: string }).deadness,
      "unreachable-export",
    );
  });

  it("flags a community whose membership is 100% non-live as a ghost community", async () => {
    const graph = new KnowledgeGraph();
    graph.addNode(fn("Function:a.ts:zombie1", "a.ts", false));
    graph.addNode(fn("Function:a.ts:zombie2", "a.ts", false));
    // Community node is a separate kind — the phase only consumes MEMBER_OF edges.
    graph.addNode({
      id: "Community:<global>:community-0" as NodeId,
      kind: "Community",
      name: "community-0",
      filePath: "<global>",
      symbolCount: 2,
      cohesion: 0,
    });
    graph.addEdge({
      from: "Function:a.ts:zombie1" as NodeId,
      to: "Community:<global>:community-0" as NodeId,
      type: "MEMBER_OF",
      confidence: 1,
    });
    graph.addEdge({
      from: "Function:a.ts:zombie2" as NodeId,
      to: "Community:<global>:community-0" as NodeId,
      type: "MEMBER_OF",
      confidence: 1,
    });

    const warnings: string[] = [];
    const ctx: PipelineContext = {
      repoPath: "/tmp/fake",
      options: {},
      graph,
      phaseOutputs: new Map(),
      onProgress: (ev: ProgressEvent) => {
        if (ev.kind === "warn" && ev.message !== undefined) warnings.push(ev.message);
      },
    };
    const out = await deadCodePhase.run(ctx, new Map());
    assert.equal(out.deadCount, 2);
    assert.equal(out.ghostCommunityCount, 1);
    assert.deepEqual(out.ghostCommunities, ["Community:<global>:community-0"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /ghost community/);
  });
});
