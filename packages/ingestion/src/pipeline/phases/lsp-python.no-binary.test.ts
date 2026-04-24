/**
 * lsp-python no-binary / start-failure tests.
 *
 * Verifies the phase degrades gracefully when pyright is either not
 * resolvable OR its `start()` call rejects. Both paths must:
 *   - emit a single warn ProgressEvent,
 *   - return `{enabled: false, skippedReason: "..."}`,
 *   - leave the graph's edge count unchanged.
 *
 * We install the phase's test hooks to simulate each failure mode without
 * needing to actually uninstall pyright or feed it a broken workspace.
 * The production code path is unchanged — when the hooks are absent the
 * phase uses the real `PyrightClient` + `require.resolve` logic.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { KnowledgeGraph, makeNodeId, type NodeId } from "@opencodehub/core-types";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { __setLspPythonTestHooks__, type LspClientLike, lspPythonPhase } from "./lsp-python.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { PROFILE_PHASE_NAME } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";

function makeCtxWithOnePythonSymbol(events: ProgressEvent[]): PipelineContext {
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
    srcDirs: ["src"],
  });

  const funcId = makeNodeId("Function", "src/x.py", "hello") as NodeId;
  graph.addNode({
    id: funcId,
    kind: "Function",
    name: "hello",
    filePath: "src/x.py",
    startLine: 1,
    endLine: 3,
  });

  return {
    repoPath: "/tmp/nonexistent-for-lsp-no-binary-test",
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
          fileCount: 0,
          cacheHits: 0,
          cacheMisses: 0,
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
          totalFiles: 0,
          closureRatio: 0,
        },
      ],
    ]),
    onProgress: (ev: ProgressEvent) => {
      events.push(ev);
    },
  };
}

function makeFailingClient(reason: string): LspClientLike {
  return {
    async start() {
      throw new Error(reason);
    },
    async stop() {
      // no-op; start() never completed so there's nothing to clean up
    },
    async queryCallers() {
      throw new Error("never called — start() failed");
    },
    async queryReferences() {
      throw new Error("never called — start() failed");
    },
    async queryImplementations() {
      throw new Error("never called — start() failed");
    },
  };
}

describe("lsp-python phase — pyright failure modes", () => {
  afterEach(() => {
    __setLspPythonTestHooks__(undefined);
  });

  it("returns enabled:false when version reader throws (pyright not resolvable)", async () => {
    __setLspPythonTestHooks__({
      versionReader: () => {
        throw new Error("Cannot find package 'pyright'");
      },
    });
    const events: ProgressEvent[] = [];
    const ctx = makeCtxWithOnePythonSymbol(events);
    const before = ctx.graph.edgeCount();

    const out = await lspPythonPhase.run(ctx, ctx.phaseOutputs);

    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "pyright-not-resolvable");
    assert.equal(out.symbolsQueried, 0);
    assert.equal(out.callEdgesAdded, 0);
    assert.equal(ctx.graph.edgeCount(), before);
    assert.equal(events.length, 1, "exactly one warn event");
    assert.equal(events[0]?.kind, "warn");
    assert.match(events[0]?.message ?? "", /pyright not resolvable/);
  });

  it("returns enabled:false when PyrightClient.start() throws", async () => {
    __setLspPythonTestHooks__({
      versionReader: () => "1.1.390",
      clientFactory: () => makeFailingClient("pyright-langserver: ENOENT"),
    });
    const events: ProgressEvent[] = [];
    const ctx = makeCtxWithOnePythonSymbol(events);
    const before = ctx.graph.edgeCount();

    const out = await lspPythonPhase.run(ctx, ctx.phaseOutputs);

    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "pyright-start-failed");
    assert.equal(out.symbolsQueried, 0);
    assert.equal(out.callEdgesAdded, 0);
    assert.equal(ctx.graph.edgeCount(), before);
    assert.equal(events.length, 1, "exactly one warn event");
    assert.equal(events[0]?.kind, "warn");
    assert.match(events[0]?.message ?? "", /pyright failed to start/);
  });
});
