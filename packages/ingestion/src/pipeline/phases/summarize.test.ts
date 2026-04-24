/**
 * Unit tests for the `summarize` ingestion phase.
 *
 * All tests substitute a fake `SummarizerAdapter` via the phase's test
 * hooks, so Bedrock is never contacted. The fake source reader avoids
 * touching the filesystem — we feed in inline strings keyed by file path.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import {
  KnowledgeGraph,
  makeNodeId,
  type NodeId,
  type RelationType,
} from "@opencodehub/core-types";
import type { SymbolSummaryRow } from "@opencodehub/storage";
import type { SummarizeInput, SummarizerResult } from "@opencodehub/summarizer";
import type { PipelineContext } from "../types.js";
import {
  __setSummarizePhaseTestHooks__,
  SUMMARIZE_PHASE_NAME,
  SUMMARY_CACHE_OPTIONS_KEY,
  type SummarizerAdapter,
  summarizePhase,
} from "./summarize.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HarnessOptions {
  readonly summaries?: boolean;
  readonly offline?: boolean;
  readonly maxSummariesPerRun?: number;
  readonly summaryCache?: {
    readonly lookup: (
      nodeId: string,
      contentHash: string,
      promptVersion: string,
    ) => Promise<SymbolSummaryRow | undefined>;
  };
}

function buildHarnessContext(graph: KnowledgeGraph, opts: HarnessOptions = {}): PipelineContext {
  const options: Record<string, unknown> = {};
  if (opts.summaries !== undefined) options["summaries"] = opts.summaries;
  if (opts.offline !== undefined) options["offline"] = opts.offline;
  if (opts.maxSummariesPerRun !== undefined) {
    options["maxSummariesPerRun"] = opts.maxSummariesPerRun;
  }
  if (opts.summaryCache !== undefined) {
    options[SUMMARY_CACHE_OPTIONS_KEY] = opts.summaryCache;
  }
  return {
    repoPath: "/unused",
    options: options as PipelineContext["options"],
    graph,
    phaseOutputs: new Map(),
  };
}

/**
 * Helper that adds an LSP-confirmed edge (confidence 1.0, `pyright@`
 * reason) so the trust filter lets the node through.
 */
function addConfirmedEdge(
  graph: KnowledgeGraph,
  from: NodeId,
  to: NodeId,
  type: RelationType = "CALLS",
): void {
  graph.addEdge({
    from,
    to,
    type,
    confidence: 1.0,
    reason: "pyright@1.1.390",
  });
}

/**
 * Build the smallest well-formed `SummarizerResult` the phase needs.
 */
function okResult(purpose: string, typeSummary: string): SummarizerResult {
  return {
    summary: {
      purpose,
      inputs: [{ name: "x", type: "int", description: "the thing to process deeply" }],
      returns: {
        type: "int",
        type_summary: typeSummary,
        details: "The computed value after processing.",
      },
      side_effects: [],
      invariants: null,
      citations: [
        { field_name: "purpose", line_start: 1, line_end: 2 },
        { field_name: "returns", line_start: 3, line_end: 4 },
      ],
    },
    attempts: 1,
    usageByAttempt: [{ inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0 }],
    wallClockMs: 10,
    validationFailures: [],
  };
}

/**
 * Fake summarizer that records each call so tests can assert invocations.
 */
function makeFakeSummarizer(resultForInput: (input: SummarizeInput) => SummarizerResult): {
  adapter: SummarizerAdapter;
  calls: SummarizeInput[];
} {
  const calls: SummarizeInput[] = [];
  const adapter: SummarizerAdapter = {
    summarize: async (input) => {
      calls.push(input);
      return resultForInput(input);
    },
  };
  return { adapter, calls };
}

function makeFixedSourceReader(bySpan: ReadonlyMap<string, string>): (absPath: string) => string {
  return (absPath: string) => {
    const hit = bySpan.get(absPath);
    if (hit === undefined) {
      throw new Error(`no fixture source for ${absPath}`);
    }
    return hit;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  __setSummarizePhaseTestHooks__(undefined);
});

describe("summarizePhase — gating", () => {
  it("skips with reason=offline when ctx.options.offline is true", async () => {
    const graph = new KnowledgeGraph();
    const ctx = buildHarnessContext(graph, { summaries: true, offline: true });

    const { adapter, calls } = makeFakeSummarizer(() => okResult("x", "n int"));
    __setSummarizePhaseTestHooks__({ summarizerFactory: () => adapter });

    const out = await summarizePhase.run(ctx, new Map());
    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "offline");
    assert.equal(out.summarized, 0);
    assert.equal(out.wouldHaveSummarized, 0);
    assert.equal(calls.length, 0);
  });

  it("skips with reason=not-enabled when summaries flag is false", async () => {
    const graph = new KnowledgeGraph();
    const ctx = buildHarnessContext(graph, { summaries: false });

    const { adapter, calls } = makeFakeSummarizer(() => okResult("x", "n int"));
    __setSummarizePhaseTestHooks__({ summarizerFactory: () => adapter });

    const out = await summarizePhase.run(ctx, new Map());
    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "not-enabled");
    assert.equal(calls.length, 0);
  });

  it("records a stable promptVersion on skip outputs", async () => {
    const graph = new KnowledgeGraph();
    const ctx = buildHarnessContext(graph, { offline: true });
    const out = await summarizePhase.run(ctx, new Map());
    assert.equal(typeof out.promptVersion, "string");
    assert.ok(out.promptVersion.length > 0);
  });
});

describe("summarizePhase — dry run (maxSummariesPerRun=0)", () => {
  it("reports wouldHaveSummarized for every eligible symbol without calling Bedrock", async () => {
    const graph = new KnowledgeGraph();
    const funcId = makeNodeId("Function", "src/a.py", "alpha") as NodeId;
    const callerId = makeNodeId("Function", "src/b.py", "driver") as NodeId;
    graph.addNode({
      id: funcId,
      kind: "Function",
      name: "alpha",
      filePath: "src/a.py",
      startLine: 1,
      endLine: 3,
    });
    graph.addNode({
      id: callerId,
      kind: "Function",
      name: "driver",
      filePath: "src/b.py",
      startLine: 1,
      endLine: 2,
    });
    addConfirmedEdge(graph, callerId, funcId);

    const sourceMap = new Map<string, string>([
      ["/unused/src/a.py", "def alpha(x):\n    return x\n    # tail\n"],
      ["/unused/src/b.py", "def driver():\n    alpha(1)\n"],
    ]);
    const { adapter, calls } = makeFakeSummarizer(() => okResult("x", "n int"));
    __setSummarizePhaseTestHooks__({
      summarizerFactory: () => adapter,
      sourceReader: makeFixedSourceReader(sourceMap),
    });

    const ctx = buildHarnessContext(graph, { summaries: true, maxSummariesPerRun: 0 });
    const out = await summarizePhase.run(ctx, new Map());

    assert.equal(out.enabled, true);
    assert.equal(out.considered, 2); // alpha (Function) + driver (Function)
    // driver has an outgoing LSP edge so it's also confirmed.
    assert.equal(out.skippedUnconfirmed, 0);
    assert.equal(out.wouldHaveSummarized, 2);
    assert.equal(out.summarized, 0);
    assert.equal(calls.length, 0, "Bedrock must not be called in dry-run mode");
    assert.equal(out.rows.length, 0);
  });
});

describe("summarizePhase — live summarize with cap", () => {
  it("calls the summarizer for each batched candidate and returns rows", async () => {
    const graph = new KnowledgeGraph();
    const funcId = makeNodeId("Function", "src/a.py", "alpha") as NodeId;
    const callerId = makeNodeId("Function", "src/b.py", "driver") as NodeId;
    graph.addNode({
      id: funcId,
      kind: "Function",
      name: "alpha",
      filePath: "src/a.py",
      startLine: 1,
      endLine: 4,
    });
    graph.addNode({
      id: callerId,
      kind: "Function",
      name: "driver",
      filePath: "src/b.py",
      startLine: 1,
      endLine: 4,
    });
    addConfirmedEdge(graph, callerId, funcId);

    const sourceMap = new Map<string, string>([
      ["/unused/src/a.py", "def alpha(x):\n    return x\n    # tail\n    # tail\n"],
      ["/unused/src/b.py", "def driver():\n    alpha(1)\n    return 0\n    # tail\n"],
    ]);
    const { adapter, calls } = makeFakeSummarizer((input) =>
      okResult(`purpose for ${input.filePath}`, `gist for ${input.filePath}`),
    );
    __setSummarizePhaseTestHooks__({
      summarizerFactory: () => adapter,
      sourceReader: makeFixedSourceReader(sourceMap),
      now: () => new Date("2026-04-22T12:00:00.000Z"),
    });

    const ctx = buildHarnessContext(graph, { summaries: true, maxSummariesPerRun: 10 });
    const out = await summarizePhase.run(ctx, new Map());

    assert.equal(out.enabled, true);
    assert.equal(out.summarized, 2);
    assert.equal(out.failed, 0);
    assert.equal(out.wouldHaveSummarized, 0);
    assert.equal(out.rows.length, 2);
    assert.equal(calls.length, 2);
    // Rows carry deterministic metadata from the fake summarizer.
    for (const row of out.rows) {
      assert.equal(row.promptVersion, out.promptVersion);
      assert.equal(row.createdAt, "2026-04-22T12:00:00.000Z");
      assert.ok(row.summaryText.startsWith("purpose for "));
      assert.ok((row.returnsTypeSummary ?? "").startsWith("gist for "));
    }
  });
});

describe("summarizePhase — trust filter", () => {
  it("skips symbols without an LSP-confirmed edge", async () => {
    const graph = new KnowledgeGraph();
    const confirmedId = makeNodeId("Function", "src/a.py", "good") as NodeId;
    const unconfirmedId = makeNodeId("Function", "src/c.py", "bad") as NodeId;
    const callerId = makeNodeId("Function", "src/b.py", "driver") as NodeId;
    graph.addNode({
      id: confirmedId,
      kind: "Function",
      name: "good",
      filePath: "src/a.py",
      startLine: 1,
      endLine: 3,
    });
    graph.addNode({
      id: unconfirmedId,
      kind: "Function",
      name: "bad",
      filePath: "src/c.py",
      startLine: 1,
      endLine: 3,
    });
    graph.addNode({
      id: callerId,
      kind: "Function",
      name: "driver",
      filePath: "src/b.py",
      startLine: 1,
      endLine: 3,
    });
    addConfirmedEdge(graph, callerId, confirmedId);
    // Low-confidence heuristic edge on the unconfirmed node.
    graph.addEdge({
      from: callerId,
      to: unconfirmedId,
      type: "CALLS",
      confidence: 0.5,
      reason: "tree-sitter",
    });

    const sourceMap = new Map<string, string>([
      ["/unused/src/a.py", "def good():\n    pass\n    pass\n"],
      ["/unused/src/b.py", "def driver():\n    good()\n    bad()\n"],
    ]);
    const { adapter, calls } = makeFakeSummarizer(() => okResult("p", "ts"));
    __setSummarizePhaseTestHooks__({
      summarizerFactory: () => adapter,
      sourceReader: makeFixedSourceReader(sourceMap),
    });

    const ctx = buildHarnessContext(graph, { summaries: true, maxSummariesPerRun: 10 });
    const out = await summarizePhase.run(ctx, new Map());

    assert.equal(out.considered, 3);
    assert.equal(out.skippedUnconfirmed, 1);
    // bad (unconfirmed) is dropped; good + driver are both LSP-confirmed.
    assert.equal(out.summarized, 2);
    assert.equal(calls.length, 2);
  });
});

describe("summarizePhase — symbol kind filter", () => {
  it("summarizes Function/Method/Class but skips other kinds", async () => {
    const graph = new KnowledgeGraph();
    const classId = makeNodeId("Class", "src/a.py", "Alpha") as NodeId;
    const methodId = makeNodeId("Method", "src/a.py", "Alpha.run") as NodeId;
    const interfaceId = makeNodeId("Interface", "src/a.ts", "IThing") as NodeId;
    const variableId = makeNodeId("Variable", "src/a.py", "TOP_LEVEL") as NodeId;
    const callerId = makeNodeId("Function", "src/b.py", "driver") as NodeId;
    graph.addNode({
      id: classId,
      kind: "Class",
      name: "Alpha",
      filePath: "src/a.py",
      startLine: 1,
      endLine: 4,
    });
    graph.addNode({
      id: methodId,
      kind: "Method",
      name: "run",
      filePath: "src/a.py",
      startLine: 2,
      endLine: 3,
      owner: "Alpha",
    });
    graph.addNode({
      id: interfaceId,
      kind: "Interface",
      name: "IThing",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 3,
    });
    graph.addNode({
      id: variableId,
      kind: "Variable",
      name: "TOP_LEVEL",
      filePath: "src/a.py",
      startLine: 5,
      endLine: 5,
    });
    graph.addNode({
      id: callerId,
      kind: "Function",
      name: "driver",
      filePath: "src/b.py",
      startLine: 1,
      endLine: 3,
    });
    // Confirm every summarizable kind so the trust filter doesn't mask the
    // kind filter we're testing here.
    addConfirmedEdge(graph, callerId, classId);
    addConfirmedEdge(graph, callerId, methodId);
    addConfirmedEdge(graph, callerId, interfaceId);
    addConfirmedEdge(graph, callerId, variableId);

    const sourceMap = new Map<string, string>([
      ["/unused/src/a.py", "class Alpha:\n    def run(self):\n        return 1\n        # tail\n"],
      ["/unused/src/b.py", "def driver():\n    Alpha().run()\n    return 0\n"],
      ["/unused/src/a.ts", "interface IThing {\n  x: number;\n}\n"],
    ]);
    const { adapter, calls } = makeFakeSummarizer(() => okResult("p", "ts"));
    __setSummarizePhaseTestHooks__({
      summarizerFactory: () => adapter,
      sourceReader: makeFixedSourceReader(sourceMap),
    });

    const ctx = buildHarnessContext(graph, { summaries: true, maxSummariesPerRun: 20 });
    const out = await summarizePhase.run(ctx, new Map());

    // considered counts only summarizable kinds.
    assert.equal(out.considered, 3); // Class, Method, Function(driver)
    assert.equal(out.summarized, 3);
    assert.equal(calls.length, 3);
    // Interface + Variable never appeared in the summarizer call list.
    const filePaths = new Set(calls.map((c) => c.filePath));
    assert.ok(filePaths.has("src/a.py"));
    assert.ok(filePaths.has("src/b.py"));
    assert.ok(!filePaths.has("src/a.ts"));
  });
});

describe("summarizePhase — cache hits", () => {
  it("does not call Bedrock when a prior summary row covers the content hash", async () => {
    const graph = new KnowledgeGraph();
    const funcId = makeNodeId("Function", "src/a.py", "alpha") as NodeId;
    const callerId = makeNodeId("Function", "src/b.py", "driver") as NodeId;
    graph.addNode({
      id: funcId,
      kind: "Function",
      name: "alpha",
      filePath: "src/a.py",
      startLine: 1,
      endLine: 3,
    });
    graph.addNode({
      id: callerId,
      kind: "Function",
      name: "driver",
      filePath: "src/b.py",
      startLine: 1,
      endLine: 3,
    });
    addConfirmedEdge(graph, callerId, funcId);

    const sourceMap = new Map<string, string>([
      ["/unused/src/a.py", "def alpha():\n    return 1\n    # tail\n"],
      ["/unused/src/b.py", "def driver():\n    alpha()\n    return 0\n"],
    ]);

    // Pre-populate the cache with a row for EVERY candidate, so the phase
    // short-circuits each of them.
    const cachedRow: SymbolSummaryRow = {
      nodeId: "unused",
      contentHash: "unused",
      promptVersion: "1",
      modelId: "m",
      summaryText: "cached",
      createdAt: "2026-04-22T00:00:00.000Z",
    };
    const cache = {
      lookup: async (): Promise<SymbolSummaryRow | undefined> => cachedRow,
    };

    const { adapter, calls } = makeFakeSummarizer(() => okResult("p", "ts"));
    __setSummarizePhaseTestHooks__({
      summarizerFactory: () => adapter,
      sourceReader: makeFixedSourceReader(sourceMap),
    });

    const ctx = buildHarnessContext(graph, {
      summaries: true,
      maxSummariesPerRun: 10,
      summaryCache: cache,
    });
    const out = await summarizePhase.run(ctx, new Map());

    assert.equal(out.cacheHits, 2);
    assert.equal(out.summarized, 0);
    assert.equal(out.wouldHaveSummarized, 0);
    assert.equal(calls.length, 0);
  });
});

describe("summarizePhase — cap enforcement", () => {
  it("summarizes exactly maxSummariesPerRun candidates and records overflow", async () => {
    const graph = new KnowledgeGraph();
    const callerId = makeNodeId("Function", "src/caller.py", "driver") as NodeId;
    graph.addNode({
      id: callerId,
      kind: "Function",
      name: "driver",
      filePath: "src/caller.py",
      startLine: 1,
      endLine: 30,
    });
    const sourceMap = new Map<string, string>([
      ["/unused/src/caller.py", Array.from({ length: 30 }, () => "    pass").join("\n")],
    ]);

    // 20 eligible Function symbols, each LSP-confirmed via an edge from
    // the shared driver node.
    for (let i = 0; i < 20; i += 1) {
      const id = makeNodeId("Function", `src/f${i}.py`, `f${i}`) as NodeId;
      graph.addNode({
        id,
        kind: "Function",
        name: `f${i}`,
        filePath: `src/f${i}.py`,
        startLine: 1,
        endLine: 3,
      });
      addConfirmedEdge(graph, callerId, id);
      sourceMap.set(`/unused/src/f${i}.py`, `def f${i}():\n    return ${i}\n    # ${i}\n`);
    }

    const { adapter, calls } = makeFakeSummarizer(() => okResult("p", "ts"));
    __setSummarizePhaseTestHooks__({
      summarizerFactory: () => adapter,
      sourceReader: makeFixedSourceReader(sourceMap),
    });

    const ctx = buildHarnessContext(graph, { summaries: true, maxSummariesPerRun: 5 });
    const out = await summarizePhase.run(ctx, new Map());

    assert.equal(calls.length, 5, "cap must bound Bedrock invocations exactly");
    assert.equal(out.summarized, 5);
    // 20 candidates + 1 driver = 21 total; 16 remain beyond the cap.
    assert.equal(out.wouldHaveSummarized, 16);
  });
});

describe("summarizePhase — phase name constant", () => {
  it("exports a stable string literal for the phase name", () => {
    assert.equal(SUMMARIZE_PHASE_NAME, "summarize");
    assert.equal(summarizePhase.name, "summarize");
  });
});

describe("summarizePhase — credential soft-fail (SUM-UN-001)", () => {
  it("returns skippedReason=no-credentials when the summarizer throws NoCredentialsError", async () => {
    const graph = new KnowledgeGraph();
    const funcId = makeNodeId("Function", "src/a.py", "alpha") as NodeId;
    const callerId = makeNodeId("Function", "src/b.py", "driver") as NodeId;
    graph.addNode({
      id: funcId,
      kind: "Function",
      name: "alpha",
      filePath: "src/a.py",
      startLine: 1,
      endLine: 3,
    });
    graph.addNode({
      id: callerId,
      kind: "Function",
      name: "driver",
      filePath: "src/b.py",
      startLine: 1,
      endLine: 3,
    });
    addConfirmedEdge(graph, callerId, funcId);

    const sourceMap = new Map<string, string>([
      ["/unused/src/a.py", "def alpha():\n    return 1\n    # tail\n"],
      ["/unused/src/b.py", "def driver():\n    alpha()\n    return 0\n"],
    ]);

    // Fake summarizer whose first call throws a credential-missing error.
    // The phase must convert that into a soft-fail (no rows, no failure
    // counter) because SUM-UN-001 guarantees analyze stays green for
    // contributors without AWS credentials.
    const credErr = new Error("Could not load credentials from any providers");
    (credErr as { name: string }).name = "CredentialsProviderError";
    const adapter: SummarizerAdapter = {
      summarize: async () => {
        throw credErr;
      },
    };
    __setSummarizePhaseTestHooks__({
      summarizerFactory: () => adapter,
      sourceReader: makeFixedSourceReader(sourceMap),
    });

    const ctx = buildHarnessContext(graph, { summaries: true, maxSummariesPerRun: 5 });
    const out = await summarizePhase.run(ctx, new Map());

    assert.equal(out.enabled, false, "credential failure must surface as enabled=false");
    assert.equal(out.skippedReason, "no-credentials");
    assert.equal(out.summarized, 0);
    assert.equal(out.failed, 0, "soft-fail must not bump the failure counter");
    assert.equal(out.rows.length, 0);
  });

  it("converts a credential error thrown by the factory itself into soft-fail", async () => {
    // When AWS_PROFILE is empty / unset and the SDK cannot resolve a
    // provider chain, the failure surfaces at `BedrockRuntimeClient`
    // construction rather than on the first .send(). Exercise that path
    // by having the factory itself throw.
    const graph = new KnowledgeGraph();
    const funcId = makeNodeId("Function", "src/a.py", "alpha") as NodeId;
    const callerId = makeNodeId("Function", "src/b.py", "driver") as NodeId;
    graph.addNode({
      id: funcId,
      kind: "Function",
      name: "alpha",
      filePath: "src/a.py",
      startLine: 1,
      endLine: 3,
    });
    graph.addNode({
      id: callerId,
      kind: "Function",
      name: "driver",
      filePath: "src/b.py",
      startLine: 1,
      endLine: 3,
    });
    addConfirmedEdge(graph, callerId, funcId);

    const sourceMap = new Map<string, string>([
      ["/unused/src/a.py", "def alpha():\n    return 1\n    # tail\n"],
      ["/unused/src/b.py", "def driver():\n    alpha()\n    return 0\n"],
    ]);

    __setSummarizePhaseTestHooks__({
      summarizerFactory: () => {
        const err = new Error("Unable to load credentials from any providers");
        (err as { name: string }).name = "CredentialsProviderError";
        throw err;
      },
      sourceReader: makeFixedSourceReader(sourceMap),
    });

    const ctx = buildHarnessContext(graph, { summaries: true, maxSummariesPerRun: 5 });
    const out = await summarizePhase.run(ctx, new Map());

    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "no-credentials");
    assert.equal(out.summarized, 0);
    assert.equal(out.failed, 0);
    assert.equal(out.rows.length, 0);
  });
});

describe("summarizePhase — summaryModel override", () => {
  it("threads opts.summaryModel through to the row.modelId", async () => {
    const graph = new KnowledgeGraph();
    const funcId = makeNodeId("Function", "src/a.py", "alpha") as NodeId;
    const callerId = makeNodeId("Function", "src/b.py", "driver") as NodeId;
    graph.addNode({
      id: funcId,
      kind: "Function",
      name: "alpha",
      filePath: "src/a.py",
      startLine: 1,
      endLine: 3,
    });
    graph.addNode({
      id: callerId,
      kind: "Function",
      name: "driver",
      filePath: "src/b.py",
      startLine: 1,
      endLine: 3,
    });
    addConfirmedEdge(graph, callerId, funcId);

    const sourceMap = new Map<string, string>([
      ["/unused/src/a.py", "def alpha():\n    return 1\n    # tail\n"],
      ["/unused/src/b.py", "def driver():\n    alpha()\n    return 0\n"],
    ]);
    // Capture the modelId the factory received so we can assert the flag
    // is plumbed end-to-end.
    let seenModelId: string | undefined;
    const { adapter } = makeFakeSummarizer(() => okResult("p", "ts"));
    __setSummarizePhaseTestHooks__({
      summarizerFactory: ({ modelId }) => {
        seenModelId = modelId;
        return adapter;
      },
      sourceReader: makeFixedSourceReader(sourceMap),
    });

    // Build a context with the override attached via the options bag —
    // mirrors how the CLI plumbs `--summary-model <id>` through
    // `PipelineOptions.summaryModel`.
    const ctx = buildHarnessContext(graph, { summaries: true, maxSummariesPerRun: 5 });
    (ctx.options as unknown as Record<string, unknown>)["summaryModel"] = "override.test-model-1";

    const out = await summarizePhase.run(ctx, new Map());
    assert.equal(seenModelId, "override.test-model-1");
    assert.equal(out.modelId, "override.test-model-1");
    for (const row of out.rows) assert.equal(row.modelId, "override.test-model-1");
  });
});
