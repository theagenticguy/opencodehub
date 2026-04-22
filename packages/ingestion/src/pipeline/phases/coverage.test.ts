/**
 * Coverage phase tests (Stream Q.2).
 *
 * Exercises the overlay end-to-end against a synthetic File graph:
 *   - lcov fixture at `coverage/lcov.info` → coveragePercent populated.
 *   - phase is a silent no-op when `options.coverage` is unset.
 *   - unmatched report entries count is surfaced but does not corrupt the graph.
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { type FileNode, KnowledgeGraph, makeNodeId } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { coveragePhase } from "./coverage.js";
import { PROFILE_PHASE_NAME } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";
import { STRUCTURE_PHASE_NAME } from "./structure.js";

function makeFileNode(relPath: string): FileNode {
  return {
    id: makeNodeId("File", relPath, relPath),
    kind: "File",
    name: relPath.split("/").pop() ?? relPath,
    filePath: relPath,
    contentHash: "x".repeat(64),
    language: "typescript",
  };
}

function seedGraph(paths: readonly string[]): KnowledgeGraph {
  const g = new KnowledgeGraph();
  for (const p of paths) g.addNode(makeFileNode(p));
  return g;
}

function mkCtx(repo: string, graph: KnowledgeGraph, coverage: boolean): PipelineContext {
  return {
    repoPath: repo,
    options: { coverage, skipGit: true },
    graph,
    phaseOutputs: new Map<string, unknown>([
      [SCAN_PHASE_NAME, { files: [], totalBytes: 0 }],
      [PROFILE_PHASE_NAME, {}],
      [STRUCTURE_PHASE_NAME, {}],
    ]),
  };
}

describe("coveragePhase — opt-in", () => {
  it("is a silent no-op when options.coverage is not set", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-cov-noop-"));
    try {
      const graph = seedGraph(["src/foo.ts"]);
      const ctx = mkCtx(repo, graph, false);
      const out = await coveragePhase.run(ctx, ctx.phaseOutputs);
      assert.equal(out.ran, false);
      assert.equal(out.annotatedFileCount, 0);
      // FileNode must not have gained coverage fields.
      const foo = [...graph.nodes()].find(
        (n): n is FileNode => n.kind === "File" && n.filePath === "src/foo.ts",
      );
      assert.equal(foo?.coveragePercent, undefined);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("populates coveragePercent + coveredLines from coverage/lcov.info", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-cov-lcov-"));
    try {
      await fs.mkdir(path.join(repo, "coverage"), { recursive: true });
      const lcov = [
        "TN:",
        "SF:src/foo.ts",
        "DA:1,1",
        "DA:2,0",
        "DA:3,7",
        "DA:4,0",
        "end_of_record",
      ].join("\n");
      await fs.writeFile(path.join(repo, "coverage", "lcov.info"), lcov);

      const graph = seedGraph(["src/foo.ts", "src/bar.ts"]);
      const ctx = mkCtx(repo, graph, true);
      const out = await coveragePhase.run(ctx, ctx.phaseOutputs);
      assert.equal(out.ran, true);
      assert.equal(out.format, "lcov");
      assert.equal(out.annotatedFileCount, 1);
      assert.equal(out.unmatchedFileCount, 0);

      const foo = [...graph.nodes()].find(
        (n): n is FileNode => n.kind === "File" && n.filePath === "src/foo.ts",
      );
      assert.equal(foo?.coveragePercent, 0.5);
      assert.deepEqual(foo?.coveredLines, [1, 3]);

      // Non-covered file should remain untouched.
      const bar = [...graph.nodes()].find(
        (n): n is FileNode => n.kind === "File" && n.filePath === "src/bar.ts",
      );
      assert.equal(bar?.coveragePercent, undefined);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("surfaces unmatched entries when the report names unknown files", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-cov-unmatched-"));
    try {
      await fs.mkdir(path.join(repo, "coverage"), { recursive: true });
      const lcov = ["SF:src/missing.ts", "DA:1,1", "end_of_record"].join("\n");
      await fs.writeFile(path.join(repo, "coverage", "lcov.info"), lcov);

      const graph = seedGraph(["src/present.ts"]);
      const ctx = mkCtx(repo, graph, true);
      const out = await coveragePhase.run(ctx, ctx.phaseOutputs);
      assert.equal(out.ran, true);
      assert.equal(out.annotatedFileCount, 0);
      assert.equal(out.unmatchedFileCount, 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("emits a warning when enabled but no report is present", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-cov-missing-"));
    try {
      const graph = seedGraph(["src/foo.ts"]);
      const warnings: string[] = [];
      const ctx: PipelineContext = {
        repoPath: repo,
        options: { coverage: true, skipGit: true },
        graph,
        phaseOutputs: new Map<string, unknown>([
          [SCAN_PHASE_NAME, { files: [], totalBytes: 0 }],
          [PROFILE_PHASE_NAME, {}],
          [STRUCTURE_PHASE_NAME, {}],
        ]),
        onProgress: (ev) => {
          if (ev.kind === "warn" && ev.message) warnings.push(ev.message);
        },
      };
      const out = await coveragePhase.run(ctx, ctx.phaseOutputs);
      assert.equal(out.ran, true);
      assert.equal(out.annotatedFileCount, 0);
      assert.ok(
        warnings.some((w) => w.includes("no report found")),
        `expected missing-report warning, got: ${warnings.join(" | ")}`,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
