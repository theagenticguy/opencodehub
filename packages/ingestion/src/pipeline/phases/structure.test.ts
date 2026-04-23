import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";
import { structurePhase } from "./structure.js";

function mockScan(files: ReadonlyArray<Pick<ScanOutput["files"][number], "relPath">>): ScanOutput {
  return {
    files: files.map((f) => ({
      absPath: `/virtual/${f.relPath}`,
      relPath: f.relPath,
      byteSize: 0,
      sha256: "0".repeat(64),
      grammarSha: null,
    })),
    totalBytes: 0,
  };
}

function makeCtx(): PipelineContext {
  return {
    repoPath: "/virtual",
    options: {},
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
  };
}

describe("structurePhase", () => {
  it("emits File + Folder nodes and CONTAINS edges", async () => {
    const ctx = makeCtx();
    const scan = mockScan([
      { relPath: "a.ts" },
      { relPath: "src/b.ts" },
      { relPath: "src/sub/c.ts" },
    ]);
    const deps = new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]);
    const out = await structurePhase.run(ctx, deps);

    const nodes = [...ctx.graph.nodes()];
    const files = nodes.filter((n) => n.kind === "File");
    const folders = nodes.filter((n) => n.kind === "Folder");

    assert.equal(files.length, 3);
    assert.deepEqual(files.map((f) => f.filePath).sort(), ["a.ts", "src/b.ts", "src/sub/c.ts"]);

    // Folders: root `.`, `src`, `src/sub`.
    const folderPaths = folders.map((f) => f.filePath).sort();
    assert.deepEqual(folderPaths, [".", "src", "src/sub"]);

    const edges = [...ctx.graph.edges()];
    const contains = edges.filter((e) => e.type === "CONTAINS");

    // CONTAINS edges we expect:
    //   . -> a.ts (file)
    //   . -> src (folder)
    //   src -> src/b.ts (file)
    //   src -> src/sub (folder)
    //   src/sub -> src/sub/c.ts (file)
    assert.ok(contains.length >= 5);

    assert.equal(out.fileCount, 3);
    assert.equal(out.folderCount, 3);
    assert.ok(out.pathSet.has("a.ts"));
  });

  it("is idempotent for the same input (deterministic node + edge counts)", async () => {
    const scan = mockScan([{ relPath: "a.ts" }, { relPath: "src/b.ts" }]);
    const deps = new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]);
    const ctx1 = makeCtx();
    await structurePhase.run(ctx1, deps);
    const ctx2 = makeCtx();
    await structurePhase.run(ctx2, deps);
    assert.equal(ctx1.graph.nodeCount(), ctx2.graph.nodeCount());
    assert.equal(ctx1.graph.edgeCount(), ctx2.graph.edgeCount());
  });
});
