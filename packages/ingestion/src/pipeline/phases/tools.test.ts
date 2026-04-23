import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { PARSE_PHASE_NAME, parsePhase } from "./parse.js";
import { SCAN_PHASE_NAME, scanPhase } from "./scan.js";
import { STRUCTURE_PHASE_NAME, structurePhase } from "./structure.js";
import { toolsPhase } from "./tools.js";

async function buildCtxWithParse(repo: string): Promise<{
  ctx: PipelineContext;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const onProgress = (ev: ProgressEvent): void => {
    if (ev.kind === "warn" && ev.message) warnings.push(ev.message);
  };
  const ctx: PipelineContext = {
    repoPath: repo,
    options: { skipGit: true },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
    onProgress,
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
  const liveCtx: PipelineContext = {
    ...ctx,
    phaseOutputs: new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [STRUCTURE_PHASE_NAME, structure],
      [PARSE_PHASE_NAME, parse],
    ]),
  };
  return { ctx: liveCtx, warnings };
}

describe("toolsPhase", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-tools-"));
    await fs.mkdir(path.join(repo, "tools"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "tools", "echo-tool.ts"),
      [
        "export const echoTool = {",
        "  name: 'echo',",
        "  description: 'Repeat the input string back',",
        "  execute: async (s: string) => s,",
        "};",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(repo, "tools", "sum-tool.ts"),
      [
        "export const sumTool = {",
        "  name: 'sum',",
        "  description: 'Sum two numbers',",
        "  execute: (a: number, b: number) => a + b,",
        "};",
        "",
      ].join("\n"),
    );
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits Tool nodes and HANDLES_TOOL edges with 0.85 confidence", async () => {
    const { ctx } = await buildCtxWithParse(repo);
    const out = await toolsPhase.run(
      ctx,
      new Map<string, unknown>([[PARSE_PHASE_NAME, ctx.phaseOutputs.get(PARSE_PHASE_NAME)]]),
    );
    assert.ok(out.toolCount >= 2, `expected at least 2 tools, got ${out.toolCount}`);

    const tools = [...ctx.graph.nodes()].filter((n) => n.kind === "Tool");
    const names = tools.map((t) => (t as { toolName: string }).toolName).sort();
    assert.deepEqual(names, ["echo", "sum"]);

    const handles = [...ctx.graph.edges()].filter((e) => e.type === "HANDLES_TOOL");
    assert.ok(handles.length >= 2);
    for (const e of handles) {
      assert.equal(e.confidence, 0.85);
    }
  });

  it("warns on duplicate tool names across files", async () => {
    const dup = await mkdtemp(path.join(tmpdir(), "och-tools-dup-"));
    try {
      await fs.mkdir(path.join(dup, "tools"), { recursive: true });
      await fs.writeFile(
        path.join(dup, "tools", "a-tool.ts"),
        ["export const tool = {", "  name: 'same',", "  description: 'one',", "};", ""].join("\n"),
      );
      await fs.writeFile(
        path.join(dup, "tools", "b-tool.ts"),
        ["export const tool = {", "  name: 'same',", "  description: 'two',", "};", ""].join("\n"),
      );
      const { ctx, warnings } = await buildCtxWithParse(dup);
      const out = await toolsPhase.run(
        ctx,
        new Map<string, unknown>([[PARSE_PHASE_NAME, ctx.phaseOutputs.get(PARSE_PHASE_NAME)]]),
      );
      assert.equal(out.duplicateCount, 1);
      assert.ok(warnings.some((w) => w.includes("duplicate tool name 'same'")));
    } finally {
      await rm(dup, { recursive: true, force: true });
    }
  });
});
