import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import type { FileNode } from "@opencodehub/core-types";
import { KnowledgeGraph, makeNodeId } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";
import { temporalPhase } from "./temporal.js";

const execFileAsync = promisify(execFile);

async function runGit(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<string> {
  const base = {
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "author@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HOME: cwd, // avoid user config leaking in
  };
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: { ...process.env, ...base, ...(env ?? {}) },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

function makeCtx(
  repo: string,
  graph: KnowledgeGraph,
  optionsOverrides: Record<string, unknown> = {},
): PipelineContext {
  return {
    repoPath: repo,
    options: { ...optionsOverrides } as PipelineContext["options"],
    graph,
    phaseOutputs: new Map(),
  };
}

function addFileNodeToGraph(graph: KnowledgeGraph, relPath: string): void {
  const node: FileNode = {
    id: makeNodeId("File", relPath, relPath),
    kind: "File",
    name: relPath.split("/").pop() ?? relPath,
    filePath: relPath,
  };
  graph.addNode(node);
}

function buildScanOutput(relPaths: readonly string[]): ScanOutput {
  return {
    files: relPaths.map((p) => ({
      absPath: `/virtual/${p}`,
      relPath: p,
      byteSize: 0,
      sha256: "0".repeat(64),
      grammarSha: null,
    })),
    totalBytes: 0,
    submodulePaths: [],
  };
}

describe("temporalPhase — skipGit kill switch", () => {
  it("returns empty output without touching git when skipGit=true", async () => {
    const graph = new KnowledgeGraph();
    addFileNodeToGraph(graph, "foo.ts");
    const ctx = makeCtx("/nonexistent", graph, { skipGit: true });
    const deps = new Map<string, unknown>([[SCAN_PHASE_NAME, buildScanOutput(["foo.ts"])]]);
    const out = await temporalPhase.run(ctx, deps);
    assert.equal(out.signalsEmitted, 0);
    assert.equal(out.filesSkipped, 0);
    assert.equal(out.subprocessCount, 0);
  });
});

describe("temporalPhase — integration with real git repo", () => {
  let repo: string;
  const nowEpochSec = 1_700_000_000;
  // Commit times will be relative to nowEpochSec.
  const day = 86_400;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-temporal-"));
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await runGit(repo, ["config", "commit.gpgsign", "false"]);

    // Commit sequence: feat on foo.ts → fix on foo.ts within 48h →
    // feat on bar.py → revert of first feat → test for foo.ts →
    // plain-typed chore on baz.go
    const commits = [
      {
        file: "foo.ts",
        content: "export const A = 1;\n",
        msg: "feat: add A",
        when: nowEpochSec - 30 * day,
      },
      {
        file: "foo.ts",
        content: "export const A = 2;\n",
        msg: "fix(a): bump",
        when: nowEpochSec - 30 * day + day,
      }, // 24h later
      {
        file: "bar.py",
        content: "def b(): pass\n",
        msg: "feat(py): bar",
        when: nowEpochSec - 10 * day,
      },
      {
        file: "foo.ts",
        content: "export const A = 1;\n",
        msg: 'Revert "feat: add A"\n\nThis reverts commit deadbeef',
        when: nowEpochSec - 5 * day,
      },
      {
        file: "foo.test.ts",
        content: "import 'foo';\n",
        msg: "test: add foo test",
        when: nowEpochSec - 3 * day,
      },
      { file: "baz.go", content: "package main\n", msg: "chore: baz", when: nowEpochSec - 2 * day },
    ];
    for (const c of commits) {
      await fs.writeFile(path.join(repo, c.file), c.content);
      await runGit(repo, ["add", c.file]);
      const iso = new Date(c.when * 1000).toISOString();
      await runGit(repo, ["commit", "-m", c.msg], {
        GIT_AUTHOR_DATE: iso,
        GIT_COMMITTER_DATE: iso,
      });
    }
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits signals for scanned files with git history", async () => {
    const graph = new KnowledgeGraph();
    for (const p of ["foo.ts", "bar.py", "foo.test.ts", "baz.go"]) {
      addFileNodeToGraph(graph, p);
    }
    const ctx = makeCtx(repo, graph, { temporalNowEpochSec: nowEpochSec });
    const deps = new Map<string, unknown>([
      [SCAN_PHASE_NAME, buildScanOutput(["foo.ts", "bar.py", "foo.test.ts", "baz.go"])],
    ]);
    const out = await temporalPhase.run(ctx, deps);
    assert.ok(
      out.signalsEmitted >= 3,
      `expected signals for at least 3 files, got ${out.signalsEmitted}`,
    );
    assert.equal(out.windowDays, 365);
    assert.ok(out.subprocessCount >= 2 && out.subprocessCount <= 3);

    const foo = graph.getNode(makeNodeId("File", "foo.ts", "foo.ts")) as FileNode | undefined;
    assert.ok(foo !== undefined, "foo.ts FileNode must exist");
    assert.ok(foo.ccTypeCounts !== undefined);
    // foo.ts saw one feat + one fix + one revert.
    assert.equal(foo.ccTypeCounts?.["feat"], 1);
    assert.equal(foo.ccTypeCounts?.["fix"], 1);
    assert.ok(foo.revertCount !== undefined && foo.revertCount >= 1);
    assert.ok(foo.fixFollowFeatDensity !== undefined && foo.fixFollowFeatDensity > 0);
    assert.ok(foo.decayedChurn !== undefined && foo.decayedChurn > 0);
    assert.equal(foo.busFactor, 1); // only one author
    assert.ok(foo.commitIntervalMaxDays !== undefined);
    assert.ok(foo.topContributorLastSeenDays !== undefined);

    const fooTest = graph.getNode(makeNodeId("File", "foo.test.ts", "foo.test.ts")) as
      | FileNode
      | undefined;
    assert.ok(fooTest !== undefined);
    // Test files return ratio 1 by definition.
    assert.equal(fooTest.testRatio, 1);
  });

  it("is deterministic — two runs produce identical signal sets", async () => {
    const runOnce = async (): Promise<FileNode | undefined> => {
      const graph = new KnowledgeGraph();
      for (const p of ["foo.ts", "bar.py", "foo.test.ts", "baz.go"]) {
        addFileNodeToGraph(graph, p);
      }
      const ctx = makeCtx(repo, graph, { temporalNowEpochSec: nowEpochSec });
      const deps = new Map<string, unknown>([
        [SCAN_PHASE_NAME, buildScanOutput(["foo.ts", "bar.py", "foo.test.ts", "baz.go"])],
      ]);
      await temporalPhase.run(ctx, deps);
      return graph.getNode(makeNodeId("File", "foo.ts", "foo.ts")) as FileNode | undefined;
    };
    const a = await runOnce();
    const b = await runOnce();
    assert.ok(a !== undefined && b !== undefined);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});
