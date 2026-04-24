/**
 * lsp-python happy-path integration test.
 *
 * Spawns the real pyright subprocess against a tiny Python fixture and
 * asserts the phase emits at least one `CALLS` edge tagged with
 * `reason: "pyright@<version>"`. We also check the dedupe / upgrade
 * semantics: a pre-seeded low-confidence CALLS edge on the same endpoint
 * pair must be upgraded to `confidence: 1.0` with the pyright reason.
 *
 * Tagged as `integration` via the filename so CI policies that split
 * unit from integration test runs can pick it up; Node's built-in
 * `--test` runner just sees it as another test file.
 *
 * Runtime on a warm machine: ~6-8s (pyright cold-start dominates).
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { KnowledgeGraph, makeNodeId, type NodeId } from "@opencodehub/core-types";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { lspPythonPhase } from "./lsp-python.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { PROFILE_PHASE_NAME } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";

async function writeFixture(repo: string): Promise<void> {
  // Two-file Python module: `greeter` defines `Greeter.hello()`, and
  // `app.py` calls it via `g.hello()`. We want pyright to produce a
  // CALLS edge from `run_app` (the enclosing function) to `Greeter.hello`.
  await writeFile(
    path.join(repo, "greeter.py"),
    [
      "class Greeter:",
      "    def __init__(self, name: str) -> None:",
      "        self.name = name",
      "",
      "    def hello(self) -> str:",
      '        return f"hi {self.name}"',
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repo, "app.py"),
    [
      "from greeter import Greeter",
      "",
      "def run_app() -> str:",
      '    g = Greeter("world")',
      "    return g.hello()",
      "",
    ].join("\n"),
  );
  // Empty pyproject keeps pyright happy about rootness.
  await writeFile(
    path.join(repo, "pyproject.toml"),
    ["[project]", 'name = "lsp-happy-path-fixture"', 'version = "0.0.0"', ""].join("\n"),
  );
}

function buildCtx(repo: string, events: ProgressEvent[]): PipelineContext {
  const graph = new KnowledgeGraph();

  graph.addNode({
    id: makeNodeId("ProjectProfile", "", "repo"),
    kind: "ProjectProfile",
    name: "project-profile",
    filePath: "",
    languages: ["python"],
    frameworks: [],
    iacTypes: [],
    apiContracts: [],
    manifests: [],
    srcDirs: [],
  });

  // Mirror the definitions the parse phase would produce against this
  // fixture. Line numbers match the `writeFixture` output above.
  const classGreeterId = makeNodeId("Class", "greeter.py", "Greeter") as NodeId;
  graph.addNode({
    id: classGreeterId,
    kind: "Class",
    name: "Greeter",
    filePath: "greeter.py",
    startLine: 1,
    endLine: 6,
  });
  const helloId = makeNodeId("Method", "greeter.py", "Greeter.hello") as NodeId;
  graph.addNode({
    id: helloId,
    kind: "Method",
    name: "hello",
    filePath: "greeter.py",
    startLine: 5,
    endLine: 6,
    owner: "Greeter",
  });
  const initId = makeNodeId("Method", "greeter.py", "Greeter.__init__") as NodeId;
  graph.addNode({
    id: initId,
    kind: "Method",
    name: "__init__",
    filePath: "greeter.py",
    startLine: 2,
    endLine: 3,
    owner: "Greeter",
  });
  const runAppId = makeNodeId("Function", "app.py", "run_app") as NodeId;
  graph.addNode({
    id: runAppId,
    kind: "Function",
    name: "run_app",
    filePath: "app.py",
    startLine: 3,
    endLine: 5,
  });

  // Seed a low-confidence CALLS edge from `run_app` to `Greeter.__init__`
  // (as parse/cross-file would emit for an unresolved-at-parse-time
  // constructor call). The pyright edge for the `Greeter("world")` call
  // site should upgrade its confidence to 1.0 and the phase's summary
  // should count it as an upgrade, not a new add. Pyright attaches ctor
  // references to the class; our client does the constructor-redirect
  // and surfaces the edge as caller → `__init__`.
  graph.addEdge({
    from: runAppId,
    to: initId,
    type: "CALLS",
    confidence: 0.5,
    reason: "tree-sitter-global",
  });

  return {
    repoPath: repo,
    options: { skipGit: true },
    graph,
    phaseOutputs: new Map<string, unknown>([
      [SCAN_PHASE_NAME, { files: [] }],
      [
        PROFILE_PHASE_NAME,
        {
          profileEmitted: true,
          languagesDetected: 1,
          frameworksDetected: 0,
        },
      ],
      [
        PARSE_PHASE_NAME,
        {
          definitionsByFile: new Map(),
          callsByFile: new Map(),
          importsByFile: new Map(),
          heritageByFile: new Map(),
          symbolIndex: { byFile: new Map(), byGlobal: new Map(), importEdges: new Map() },
          sourceByFile: new Map(),
          parseTimeMs: 0,
          fileCount: 2,
          cacheHits: 0,
          cacheMisses: 2,
        },
      ],
      [
        CROSS_FILE_PHASE_NAME,
        { upgradedCallsCount: 0, unresolvedRemaining: 0, sccCount: 0, largeSccs: [] },
      ],
      [
        INCREMENTAL_SCOPE_PHASE_NAME,
        {
          mode: "full" as const,
          changedFiles: [],
          closureFiles: [],
          totalFiles: 2,
          closureRatio: 0,
        },
      ],
    ]),
    onProgress: (ev: ProgressEvent) => {
      events.push(ev);
    },
  };
}

describe("lsp-python happy path (integration)", () => {
  it("spawns pyright, emits a CALLS edge with reason=pyright@<version>, upgrades the seeded heuristic edge", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "lsp-happy-"));
    try {
      await writeFixture(repo);
      const events: ProgressEvent[] = [];
      const ctx = buildCtx(repo, events);

      const initNodeId = makeNodeId("Method", "greeter.py", "Greeter.__init__");
      const runAppNodeId = makeNodeId("Function", "app.py", "run_app");

      const out = await lspPythonPhase.run(ctx, ctx.phaseOutputs);

      if (!out.enabled) {
        process.stderr.write(
          `lsp-python happy-path skippedReason=${out.skippedReason} events=${JSON.stringify(events)}\n`,
        );
      }
      assert.equal(out.enabled, true, "phase should be enabled when pyright is resolvable");
      assert.ok(
        typeof out.pyrightVersion === "string" && out.pyrightVersion.length > 0,
        "pyrightVersion should be populated",
      );
      assert.ok(out.symbolsQueried >= 1, "at least one symbol must be queried");

      // Scan the graph for the upgraded CALLS edge and assert provenance.
      // pyright's constructor-redirect attaches `Greeter("world")` to
      // `__init__`, so we look for the edge run_app → Greeter.__init__.
      let matchingEdge: { readonly reason?: string; readonly confidence: number } | undefined;
      for (const e of ctx.graph.edges()) {
        if (e.type !== "CALLS") continue;
        if (e.from !== runAppNodeId) continue;
        if (e.to !== initNodeId) continue;
        matchingEdge = e;
        break;
      }
      assert.ok(
        matchingEdge !== undefined,
        "expected a CALLS edge run_app → Greeter.__init__ in the graph",
      );
      assert.equal(matchingEdge.confidence, 1.0, "pyright CALLS edge should have confidence 1.0");
      assert.ok(
        matchingEdge.reason?.startsWith("pyright@"),
        `edge reason should start with "pyright@" — got ${matchingEdge.reason}`,
      );
      // When the phase runs on a fixture whose seed edge is upgradeable,
      // `edgesUpgraded` must be >= 1. We don't assert strict equality —
      // pyright may also emit a direct edge not seeded by us.
      assert.ok(out.edgesUpgraded >= 1, "should report at least one upgrade");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
