import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import type { ContributorNode, FileNode } from "@opencodehub/core-types";
import { KnowledgeGraph, makeNodeId } from "@opencodehub/core-types";
import type { ExtractedDefinition } from "../../providers/extraction-types.js";
import type { PipelineContext } from "../types.js";
import { COMMUNITIES_PHASE_NAME } from "./communities.js";
import { filterOutSubmodules, ownershipPhase } from "./ownership.js";
import { PARSE_PHASE_NAME, type ParseOutput } from "./parse.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";
import { TEMPORAL_PHASE_NAME } from "./temporal.js";

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
    HOME: cwd,
  };
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: { ...process.env, ...base, ...(env ?? {}) },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

function buildScanOutput(
  relPaths: readonly string[],
  submodulePaths: readonly string[] = [],
): ScanOutput {
  return {
    files: relPaths.map((p) => ({
      absPath: `/virtual/${p}`,
      relPath: p,
      byteSize: 0,
      sha256: "0".repeat(64),
      grammarSha: null,
    })),
    totalBytes: 0,
    submodulePaths,
  };
}

function buildParseOutput(defs: ReadonlyMap<string, readonly ExtractedDefinition[]>): ParseOutput {
  return {
    definitionsByFile: defs,
    callsByFile: new Map(),
    importsByFile: new Map(),
    heritageByFile: new Map(),
    symbolIndex: {
      findInFile: () => undefined,
      findInImports: () => undefined,
      findGlobal: () => [],
    } as ParseOutput["symbolIndex"],
    sourceByFile: new Map(),
    parseTimeMs: 0,
    fileCount: defs.size,
    cacheHits: 0,
    cacheMisses: defs.size,
  };
}

function addFileNode(graph: KnowledgeGraph, relPath: string): void {
  const node: FileNode = {
    id: makeNodeId("File", relPath, relPath),
    kind: "File",
    name: relPath.split("/").pop() ?? relPath,
    filePath: relPath,
    // Ensure H.5 runs: we inject "old contributor" signals via the temporal
    // phase when it runs; here we skip wiring them because the fixture repo
    // is fresh — orphan detection defers on insufficient history.
    topContributorLastSeenDays: 0,
    coauthorCount: 0,
    decayedChurn: 0.5,
  };
  graph.addNode(node);
}

function makeCtx(
  repo: string,
  graph: KnowledgeGraph,
  options: Record<string, unknown> = {},
): PipelineContext {
  return {
    repoPath: repo,
    options: options as PipelineContext["options"],
    graph,
    phaseOutputs: new Map(),
  };
}

describe("filterOutSubmodules", () => {
  it("returns input unchanged when submodulePaths is empty", () => {
    const input = ["a.ts", "b/c.ts"];
    const out = filterOutSubmodules(input, []);
    assert.deepEqual([...out], input);
  });

  it("drops paths equal to a submodule root", () => {
    const out = filterOutSubmodules(["keep.ts", "vendor/inner"], ["vendor/inner"]);
    assert.deepEqual([...out], ["keep.ts"]);
  });

  it("drops paths beneath a submodule root (prefix + slash)", () => {
    const out = filterOutSubmodules(
      ["keep.ts", "vendor/inner/deep/file.ts", "vendor/inner2/ok.ts"],
      ["vendor/inner"],
    );
    assert.deepEqual([...out], ["keep.ts", "vendor/inner2/ok.ts"]);
  });

  it("does not match partial segment prefixes", () => {
    // "vendor/in" must NOT match "vendor/inner/..."
    const out = filterOutSubmodules(["vendor/inner/file.ts"], ["vendor/in"]);
    assert.deepEqual([...out], ["vendor/inner/file.ts"]);
  });
});

describe("ownershipPhase — skipGit kill switch", () => {
  it("returns zero-filled output without spawning git", async () => {
    const graph = new KnowledgeGraph();
    const ctx = makeCtx("/nonexistent", graph, { skipGit: true });
    const deps = new Map<string, unknown>([
      [SCAN_PHASE_NAME, buildScanOutput(["foo.ts"])],
      [PARSE_PHASE_NAME, buildParseOutput(new Map())],
      [
        TEMPORAL_PHASE_NAME,
        { signalsEmitted: 0, filesSkipped: 0, windowDays: 365, subprocessCount: 0 },
      ],
      [
        COMMUNITIES_PHASE_NAME,
        { communityCount: 0, memberCount: 0, unclusteredCount: 0, usedFallback: false },
      ],
    ]);
    const out = await ownershipPhase.run(ctx, deps);
    assert.equal(out.contributorCount, 0);
    assert.equal(out.ownedByEdgeCount, 0);
    assert.equal(out.subprocessCount, 0);
  });
});

describe("ownershipPhase — blame integration", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-ownership-"));
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await runGit(repo, ["config", "commit.gpgsign", "false"]);
    // Two files: foo.ts (Alice) and bar.ts (Alice + Bob).
    await fs.writeFile(path.join(repo, "foo.ts"), "export const A = 1;\n");
    await runGit(repo, ["add", "foo.ts"]);
    await runGit(repo, ["commit", "-q", "-m", "feat: add foo"]);

    await fs.writeFile(path.join(repo, "bar.ts"), "export const B = 1;\nexport const C = 2;\n");
    await runGit(repo, ["add", "bar.ts"]);
    await runGit(repo, ["commit", "-q", "-m", "feat: add bar"]);

    // Edit bar.ts line 2 as Bob (Alice is the default author in runGit).
    await fs.writeFile(path.join(repo, "bar.ts"), "export const B = 1;\nexport const C = 3;\n");
    await runGit(repo, ["add", "bar.ts"], {
      GIT_AUTHOR_NAME: "Bob",
      GIT_AUTHOR_EMAIL: "bob@example.com",
      GIT_COMMITTER_NAME: "Bob",
      GIT_COMMITTER_EMAIL: "bob@example.com",
    });
    await runGit(repo, ["commit", "-q", "-m", "fix: bump C"], {
      GIT_AUTHOR_NAME: "Bob",
      GIT_AUTHOR_EMAIL: "bob@example.com",
      GIT_COMMITTER_NAME: "Bob",
      GIT_COMMITTER_EMAIL: "bob@example.com",
    });
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits Contributor nodes + OWNED_BY edges", async () => {
    const graph = new KnowledgeGraph();
    addFileNode(graph, "foo.ts");
    addFileNode(graph, "bar.ts");
    const ctx = makeCtx(repo, graph, { privacyHashEmails: true });
    const deps = new Map<string, unknown>([
      [SCAN_PHASE_NAME, buildScanOutput(["foo.ts", "bar.ts"])],
      [PARSE_PHASE_NAME, buildParseOutput(new Map())],
      [
        TEMPORAL_PHASE_NAME,
        { signalsEmitted: 0, filesSkipped: 0, windowDays: 365, subprocessCount: 0 },
      ],
      [
        COMMUNITIES_PHASE_NAME,
        { communityCount: 0, memberCount: 0, unclusteredCount: 0, usedFallback: false },
      ],
    ]);
    const out = await ownershipPhase.run(ctx, deps);
    assert.ok(out.contributorCount >= 1, "expected at least one Contributor node");
    assert.ok(out.ownedByEdgeCount >= 2, "expected file-level OWNED_BY edges for both files");
    assert.ok(out.subprocessCount >= 2, "blame should run once per file");
    // Subprocess count should not exceed 2×files + warmup-count (a generous
    // upper bound — the helper may retry failures).
    assert.ok(out.subprocessCount <= 2 * 2, "subprocess count should be bounded by file count");

    // Confirm privacy default — no Contributor node should carry emailPlain.
    for (const n of graph.nodes()) {
      if (n.kind !== "Contributor") continue;
      const contrib = n as ContributorNode;
      assert.equal(contrib.emailPlain, undefined, "privacy default should suppress emailPlain");
      assert.ok(contrib.emailHash.length === 64, "emailHash must be a 64-char sha256");
    }
  });

  it("skips submodule paths by default so blame never fires on them", async () => {
    // Wire a fake scan with two real files plus one "submodule" path. The
    // submodule path does not exist on disk, so if the filter is off we
    // would see a blame warning for it. With the filter on (the default),
    // no warning and no blame.
    const warnings: string[] = [];
    const graph = new KnowledgeGraph();
    addFileNode(graph, "foo.ts");
    const ctx: PipelineContext = {
      repoPath: repo,
      options: {} as PipelineContext["options"],
      graph,
      phaseOutputs: new Map(),
      onProgress: (ev) => {
        if (ev.kind === "warn" && ev.message !== undefined) warnings.push(ev.message);
      },
    };
    const deps = new Map<string, unknown>([
      [
        SCAN_PHASE_NAME,
        buildScanOutput(["foo.ts", "vendor/mod/does-not-exist.ts"], ["vendor/mod"]),
      ],
      [PARSE_PHASE_NAME, buildParseOutput(new Map())],
      [
        TEMPORAL_PHASE_NAME,
        { signalsEmitted: 0, filesSkipped: 0, windowDays: 365, subprocessCount: 0 },
      ],
      [
        COMMUNITIES_PHASE_NAME,
        { communityCount: 0, memberCount: 0, unclusteredCount: 0, usedFallback: false },
      ],
    ]);
    await ownershipPhase.run(ctx, deps);
    for (const msg of warnings) {
      assert.ok(
        !msg.includes("vendor/mod/does-not-exist.ts"),
        `submodule paths must be filtered before blame; got warning: ${msg}`,
      );
    }
  });

  it("blames submodule paths when excludeSubmodules=false (opt-out)", async () => {
    const warnings: string[] = [];
    const graph = new KnowledgeGraph();
    addFileNode(graph, "foo.ts");
    const ctx: PipelineContext = {
      repoPath: repo,
      options: { excludeSubmodules: false } as PipelineContext["options"],
      graph,
      phaseOutputs: new Map(),
      onProgress: (ev) => {
        if (ev.kind === "warn" && ev.message !== undefined) warnings.push(ev.message);
      },
    };
    const deps = new Map<string, unknown>([
      [
        SCAN_PHASE_NAME,
        buildScanOutput(["foo.ts", "vendor/mod/does-not-exist.ts"], ["vendor/mod"]),
      ],
      [PARSE_PHASE_NAME, buildParseOutput(new Map())],
      [
        TEMPORAL_PHASE_NAME,
        { signalsEmitted: 0, filesSkipped: 0, windowDays: 365, subprocessCount: 0 },
      ],
      [
        COMMUNITIES_PHASE_NAME,
        { communityCount: 0, memberCount: 0, unclusteredCount: 0, usedFallback: false },
      ],
    ]);
    await ownershipPhase.run(ctx, deps);
    assert.ok(
      warnings.some((m) => m.includes("vendor/mod/does-not-exist.ts")),
      "with excludeSubmodules=false, blame should run on submodule paths and emit its warning",
    );
  });

  it("emits plain emails when privacyHashEmails=false", async () => {
    const graph = new KnowledgeGraph();
    addFileNode(graph, "foo.ts");
    const ctx = makeCtx(repo, graph, { privacyHashEmails: false });
    const deps = new Map<string, unknown>([
      [SCAN_PHASE_NAME, buildScanOutput(["foo.ts"])],
      [PARSE_PHASE_NAME, buildParseOutput(new Map())],
      [
        TEMPORAL_PHASE_NAME,
        { signalsEmitted: 0, filesSkipped: 0, windowDays: 365, subprocessCount: 0 },
      ],
      [
        COMMUNITIES_PHASE_NAME,
        { communityCount: 0, memberCount: 0, unclusteredCount: 0, usedFallback: false },
      ],
    ]);
    await ownershipPhase.run(ctx, deps);
    let sawPlain = false;
    for (const n of graph.nodes()) {
      if (n.kind === "Contributor") {
        const contrib = n as ContributorNode;
        if (contrib.emailPlain?.includes("@") === true) {
          sawPlain = true;
        }
      }
    }
    assert.ok(sawPlain, "emailPlain must be populated when privacy is disabled");
  });
});
