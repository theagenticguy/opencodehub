import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { markdownPhase } from "./markdown.js";
import { SCAN_PHASE_NAME, type ScanOutput, scanPhase } from "./scan.js";
import { STRUCTURE_PHASE_NAME, type StructureOutput, structurePhase } from "./structure.js";

async function buildCtx(repoPath: string): Promise<{
  ctx: PipelineContext;
  scan: ScanOutput;
  structure: StructureOutput;
}> {
  const ctx: PipelineContext = {
    repoPath,
    options: { skipGit: true },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
  };
  const scan = await scanPhase.run(ctx, new Map());
  const structure = await structurePhase.run(
    ctx,
    new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
  );
  // Re-seat phaseOutputs so markdown can read scan indirectly.
  const liveOutputs = new Map<string, unknown>([
    [SCAN_PHASE_NAME, scan],
    [STRUCTURE_PHASE_NAME, structure],
  ]);
  const liveCtx: PipelineContext = { ...ctx, phaseOutputs: liveOutputs };
  return { ctx: liveCtx, scan, structure };
}

describe("markdownPhase", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-md-"));
    await fs.writeFile(
      path.join(repo, "README.md"),
      [
        "# Top",
        "",
        "Intro paragraph links to [guide](./docs/guide.md) and [api](./docs/api.md#usage).",
        "",
        "## Features",
        "",
        "Body of features.",
        "",
        "### Subfeature",
        "",
        "Details. External [site](https://example.com) should not create an edge.",
        "",
        "## Usage",
        "",
        "See also [guide](./docs/guide.md).",
        "",
      ].join("\n"),
    );
    await fs.mkdir(path.join(repo, "docs"));
    await fs.writeFile(
      path.join(repo, "docs", "guide.md"),
      ["# Guide", "", "Back to [readme](../README.md).", ""].join("\n"),
    );
    await fs.writeFile(
      path.join(repo, "docs", "api.md"),
      ["# API", "", "## Usage", "", "Usage body.", ""].join("\n"),
    );
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits section nodes for each heading with the right levels and ids", async () => {
    const { ctx } = await buildCtx(repo);
    const out = await markdownPhase.run(
      ctx,
      new Map<string, unknown>([
        [STRUCTURE_PHASE_NAME, ctx.phaseOutputs.get(STRUCTURE_PHASE_NAME)],
      ]),
    );

    assert.ok(out.sectionCount >= 5, `expected at least 5 sections, got ${out.sectionCount}`);
    const nodes = [...ctx.graph.nodes()];
    const sections = nodes.filter((n) => n.kind === "Section");
    // README: Top(1), Features(2), Subfeature(3), Usage(2)
    // guide.md: Guide(1)
    // api.md: API(1), Usage(2)
    assert.equal(sections.length, 7);
    const readmeSections = sections.filter((s) => s.filePath === "README.md");
    const levels = readmeSections.map((s) => (s as { level?: number }).level ?? 0).sort();
    assert.deepEqual(levels, [1, 2, 2, 3]);
  });

  it("emits CONTAINS edges from file to top-level and parent-to-child sections", async () => {
    const { ctx } = await buildCtx(repo);
    await markdownPhase.run(
      ctx,
      new Map<string, unknown>([
        [STRUCTURE_PHASE_NAME, ctx.phaseOutputs.get(STRUCTURE_PHASE_NAME)],
      ]),
    );

    const edges = [...ctx.graph.edges()];
    // File -> Top-level section contains.
    const fileToSection = edges.filter(
      (e) => e.type === "CONTAINS" && e.reason === "file-to-section",
    );
    assert.ok(fileToSection.length >= 3, "expected file-to-section edges for each top-level H1");

    const sectionToSubsection = edges.filter(
      (e) => e.type === "CONTAINS" && e.reason === "section-to-subsection",
    );
    // Top -> Features, Top -> Usage, Features -> Subfeature, API -> Usage
    assert.ok(sectionToSubsection.length >= 4);
  });

  it("emits REFERENCES edges for internal markdown links only", async () => {
    const { ctx } = await buildCtx(repo);
    const out = await markdownPhase.run(
      ctx,
      new Map<string, unknown>([
        [STRUCTURE_PHASE_NAME, ctx.phaseOutputs.get(STRUCTURE_PHASE_NAME)],
      ]),
    );

    assert.ok(out.linkCount >= 2, `expected at least 2 links, got ${out.linkCount}`);
    const refs = [...ctx.graph.edges()].filter((e) => e.type === "REFERENCES");
    // README -> docs/guide.md (intro + Usage), README -> docs/api.md, guide.md -> README.md.
    assert.ok(refs.length >= 3);
    // External link should not have produced a reference.
    const externalMatches = refs.filter((e) => (e.to as string).includes("example.com"));
    assert.equal(externalMatches.length, 0);
  });

  it("is deterministic across repeated runs", async () => {
    const one = await buildCtx(repo);
    await markdownPhase.run(
      one.ctx,
      new Map<string, unknown>([
        [STRUCTURE_PHASE_NAME, one.ctx.phaseOutputs.get(STRUCTURE_PHASE_NAME)],
      ]),
    );
    const two = await buildCtx(repo);
    await markdownPhase.run(
      two.ctx,
      new Map<string, unknown>([
        [STRUCTURE_PHASE_NAME, two.ctx.phaseOutputs.get(STRUCTURE_PHASE_NAME)],
      ]),
    );
    assert.equal(one.ctx.graph.nodeCount(), two.ctx.graph.nodeCount());
    assert.equal(one.ctx.graph.edgeCount(), two.ctx.graph.edgeCount());
  });

  it("ignores headings inside fenced code blocks", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "och-md-fence-"));
    try {
      await fs.writeFile(
        path.join(scratch, "x.md"),
        ["# real", "", "```", "# not-a-heading", "```", ""].join("\n"),
      );
      const ctx: PipelineContext = {
        repoPath: scratch,
        options: { skipGit: true },
        graph: new KnowledgeGraph(),
        phaseOutputs: new Map(),
      };
      const scan = await scanPhase.run(ctx, new Map());
      const structure = await structurePhase.run(
        ctx,
        new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
      );
      const liveCtx: PipelineContext = {
        ...ctx,
        phaseOutputs: new Map<string, unknown>([
          [SCAN_PHASE_NAME, scan],
          [STRUCTURE_PHASE_NAME, structure],
        ]),
      };
      const out = await markdownPhase.run(
        liveCtx,
        new Map<string, unknown>([[STRUCTURE_PHASE_NAME, structure]]),
      );
      assert.equal(out.sectionCount, 1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
