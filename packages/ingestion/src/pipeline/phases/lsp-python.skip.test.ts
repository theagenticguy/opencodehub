/**
 * lsp-python skip-path tests.
 *
 * Proves that the phase returns `{enabled: false}` fast without ever
 * touching pyright in three common non-Python scenarios:
 *
 *   1. `profile.languages` does not include "python".
 *   2. The graph has no Python symbols at all (e.g. Python files existed
 *      but parse failed).
 *   3. The `CODEHUB_DISABLE_LSP=1` escape hatch is set.
 *
 * We use an in-memory `PipelineContext` with a synthetic profile node and
 * assert that the graph ends identical to the starting graph — no stray
 * edges added when the phase short-circuits.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { KnowledgeGraph, makeNodeId, type NodeId } from "@opencodehub/core-types";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { LSP_PYTHON_PHASE_NAME, lspPythonPhase } from "./lsp-python.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { PROFILE_PHASE_NAME } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";

function makeCtx(opts: {
  readonly languages: readonly string[];
  readonly withPythonSymbol: boolean;
  readonly events?: ProgressEvent[];
}): PipelineContext {
  const graph = new KnowledgeGraph();

  graph.addNode({
    id: makeNodeId("ProjectProfile", "", "repo"),
    kind: "ProjectProfile",
    name: "project-profile",
    filePath: "",
    languages: opts.languages,
    frameworks: [],
    iacTypes: [],
    apiContracts: [],
    manifests: [],
    srcDirs: [],
  });

  if (opts.withPythonSymbol) {
    const id = makeNodeId("Function", "src/x.py", "hello") as NodeId;
    graph.addNode({
      id,
      kind: "Function",
      name: "hello",
      filePath: "src/x.py",
      startLine: 1,
      endLine: 3,
    });
  }

  const ctx: PipelineContext = {
    repoPath: "/tmp/nonexistent-for-lsp-skip-test",
    options: { skipGit: true },
    graph,
    phaseOutputs: new Map<string, unknown>([
      [SCAN_PHASE_NAME, { files: [] }],
      [
        PROFILE_PHASE_NAME,
        {
          profileEmitted: true,
          languagesDetected: opts.languages.length,
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
          symbolIndex: {
            byFile: new Map(),
            byGlobal: new Map(),
            importEdges: new Map(),
          },
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
    ...(opts.events !== undefined
      ? {
          onProgress: (ev: ProgressEvent) => {
            opts.events?.push(ev);
          },
        }
      : {}),
  };
  return ctx;
}

function edgeCountOf(ctx: PipelineContext): number {
  return ctx.graph.edgeCount();
}

describe("lsp-python phase — skip paths", () => {
  const originalEnv = process.env["CODEHUB_DISABLE_LSP"];

  beforeEach(() => {
    delete process.env["CODEHUB_DISABLE_LSP"];
  });
  afterEach(() => {
    if (originalEnv !== undefined) process.env["CODEHUB_DISABLE_LSP"] = originalEnv;
    else delete process.env["CODEHUB_DISABLE_LSP"];
  });

  it("returns enabled:false when profile.languages has no python", async () => {
    const ctx = makeCtx({ languages: ["typescript"], withPythonSymbol: false });
    const before = edgeCountOf(ctx);
    const out = await lspPythonPhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "no-python-in-profile");
    assert.equal(out.symbolsQueried, 0);
    assert.equal(out.callEdgesAdded, 0);
    assert.equal(edgeCountOf(ctx), before);
  });

  it("returns enabled:false when no Python symbols exist in the graph", async () => {
    const ctx = makeCtx({ languages: ["python"], withPythonSymbol: false });
    const before = edgeCountOf(ctx);
    const out = await lspPythonPhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "no-python-symbols-in-graph");
    assert.equal(edgeCountOf(ctx), before);
  });

  it("returns enabled:false when CODEHUB_DISABLE_LSP=1 is set", async () => {
    process.env["CODEHUB_DISABLE_LSP"] = "1";
    const ctx = makeCtx({ languages: ["python"], withPythonSymbol: true });
    const before = edgeCountOf(ctx);
    const out = await lspPythonPhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "CODEHUB_DISABLE_LSP=1");
    assert.equal(edgeCountOf(ctx), before);
  });

  it("declares the expected DAG dependencies", () => {
    const deps = new Set(lspPythonPhase.deps);
    assert.ok(deps.has(SCAN_PHASE_NAME));
    assert.ok(deps.has(PROFILE_PHASE_NAME));
    assert.ok(deps.has(PARSE_PHASE_NAME));
    assert.ok(deps.has(CROSS_FILE_PHASE_NAME));
    assert.ok(deps.has(INCREMENTAL_SCOPE_PHASE_NAME));
    assert.equal(lspPythonPhase.name, LSP_PYTHON_PHASE_NAME);
  });
});
