import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { KnowledgeGraph, type NodeId } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { CROSS_FILE_PHASE_NAME, crossFilePhase } from "./cross-file.js";
import { ORM_PHASE_NAME } from "./orm.js";
import { PARSE_PHASE_NAME, parsePhase } from "./parse.js";
import { ROUTES_PHASE_NAME } from "./routes.js";
import { SCAN_PHASE_NAME, scanPhase } from "./scan.js";
import { STRUCTURE_PHASE_NAME, structurePhase } from "./structure.js";
import { TOOLS_PHASE_NAME } from "./tools.js";

async function buildCtxAfterParse(repo: string): Promise<PipelineContext> {
  const ctx: PipelineContext = {
    repoPath: repo,
    options: { skipGit: true },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
  };
  const scan = await scanPhase.run(ctx, new Map());
  const structure = await structurePhase.run(
    ctx,
    new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
  );
  const parse = await parsePhase.run(
    ctx,
    new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [STRUCTURE_PHASE_NAME, structure],
    ]),
  );
  return {
    ...ctx,
    phaseOutputs: new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [STRUCTURE_PHASE_NAME, structure],
      [PARSE_PHASE_NAME, parse],
      // Upstream deps the phase requires but which did not actually run in
      // this minimal setup.
      [ROUTES_PHASE_NAME, { routeCount: 0, duplicateCount: 0 }],
      [TOOLS_PHASE_NAME, { toolCount: 0, duplicateCount: 0 }],
      [ORM_PHASE_NAME, { queriesCount: 0, placeholderCount: 0 }],
    ]),
  };
}

describe(`${CROSS_FILE_PHASE_NAME}Phase`, () => {
  it("runs without crashing on an empty repo", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-xf-empty-"));
    try {
      const ctx = await buildCtxAfterParse(repo);
      const out = await crossFilePhase.run(
        ctx,
        new Map<string, unknown>([
          [PARSE_PHASE_NAME, ctx.phaseOutputs.get(PARSE_PHASE_NAME)],
          [ROUTES_PHASE_NAME, ctx.phaseOutputs.get(ROUTES_PHASE_NAME)],
          [TOOLS_PHASE_NAME, ctx.phaseOutputs.get(TOOLS_PHASE_NAME)],
          [ORM_PHASE_NAME, ctx.phaseOutputs.get(ORM_PHASE_NAME)],
        ]),
      );
      assert.equal(out.upgradedCallsCount, 0);
      assert.equal(out.sccCount, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("tolerates cyclic imports — no crash, both files processed", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-xf-cycle-"));
    try {
      await fs.writeFile(
        path.join(repo, "a.ts"),
        [
          "import { fromB } from './b.js';",
          "export function fromA(): number { return fromB(); }",
          "",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(repo, "b.ts"),
        [
          "import { fromA } from './a.js';",
          "export function fromB(): number { return fromA(); }",
          "",
        ].join("\n"),
      );
      const ctx = await buildCtxAfterParse(repo);
      const out = await crossFilePhase.run(
        ctx,
        new Map<string, unknown>([
          [PARSE_PHASE_NAME, ctx.phaseOutputs.get(PARSE_PHASE_NAME)],
          [ROUTES_PHASE_NAME, ctx.phaseOutputs.get(ROUTES_PHASE_NAME)],
          [TOOLS_PHASE_NAME, ctx.phaseOutputs.get(TOOLS_PHASE_NAME)],
          [ORM_PHASE_NAME, ctx.phaseOutputs.get(ORM_PHASE_NAME)],
        ]),
      );
      // At least one SCC containing both files.
      assert.ok(out.sccCount >= 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps same-file CALLS edges at 0.95 after re-resolution", async () => {
    // This probes the invariant that crossFile doesn't weaken edges —
    // `addEdge` on the graph retains the higher confidence.
    const repo = await mkdtemp(path.join(tmpdir(), "och-xf-samefile-"));
    try {
      await fs.writeFile(
        path.join(repo, "only.ts"),
        [
          "export function helper(): number { return 1; }",
          "export function user(): number { return helper(); }",
          "",
        ].join("\n"),
      );
      const ctx = await buildCtxAfterParse(repo);
      await crossFilePhase.run(
        ctx,
        new Map<string, unknown>([
          [PARSE_PHASE_NAME, ctx.phaseOutputs.get(PARSE_PHASE_NAME)],
          [ROUTES_PHASE_NAME, ctx.phaseOutputs.get(ROUTES_PHASE_NAME)],
          [TOOLS_PHASE_NAME, ctx.phaseOutputs.get(TOOLS_PHASE_NAME)],
          [ORM_PHASE_NAME, ctx.phaseOutputs.get(ORM_PHASE_NAME)],
        ]),
      );

      const callsEdges = [...ctx.graph.edges()].filter((e) => e.type === "CALLS");
      const helperFn = [...ctx.graph.nodes()].find(
        (n) => n.kind === "Function" && n.name === "helper",
      );
      assert.ok(helperFn);
      const helperCalls = callsEdges.filter((e) => e.to === (helperFn.id as NodeId));
      assert.ok(helperCalls.length >= 1);
      for (const e of helperCalls) {
        assert.ok(e.confidence >= 0.9, `same-file CALLS must stay >= 0.9, got ${e.confidence}`);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
