/**
 * `codehub change-pack` CLI surface tests.
 *
 * Covers:
 *   1. `--json` → raw camelCase ChangePack on stdout (changePackHash +
 *      costAttribution.estimate === true), exit code = verdict.exitCode.
 *   2. Default (no `--json`) → human summary, exit code = verdict.exitCode.
 *   3. The query envelope (base/head/depth/min-confidence/budget/
 *      include-tests) is threaded through to the injected runner verbatim.
 *   4. The store is always closed (finally), even on the summary path.
 *
 * Each test injects an `_openStore` factory + an `_runChangePack` stand-in
 * so nothing hits lbug/DuckDB or git. The CLI's contract under test is the
 * exit-code passthrough (`pack.verdict.exitCode`) and the JSON shape — not
 * the analysis module's compose logic, which has its own suite.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangePack, ChangePackQuery } from "@opencodehub/analysis";
import type { IGraphStore, Store } from "@opencodehub/storage";
import { type ChangePackOptions, runChangePackCmd } from "./change-pack.js";

// --- fixtures --------------------------------------------------------------

const FAKE_GRAPH: IGraphStore = {
  open: async () => undefined,
  close: async () => undefined,
} as unknown as IGraphStore;

interface FakeStoreHandle {
  readonly store: Store;
  closed(): boolean;
}

function fakeStore(): FakeStoreHandle {
  let wasClosed = false;
  const store = {
    graph: FAKE_GRAPH,
    temporal: {} as unknown,
    graphFile: "/tmp/fake-repo/.codehub/graph.lbug",
    temporalFile: "/tmp/fake-repo/.codehub/temporal.duckdb",
    close: async () => {
      wasClosed = true;
    },
  } as unknown as Store;
  return { store, closed: () => wasClosed };
}

function packFixture(exitCode: 0 | 1 | 2, overrides: Partial<ChangePack> = {}): ChangePack {
  const base: ChangePack = {
    changedFiles: ["src/a.ts"],
    changedSymbols: [
      { id: "Function:src/a.ts:foo#0", name: "foo", filePath: "src/a.ts", kind: "Function" },
    ],
    impactedSubgraph: {
      nodes: [
        {
          id: "Function:src/b.ts:bar#0",
          name: "bar",
          filePath: "src/b.ts",
          kind: "Function",
          minDepth: 1,
        },
      ],
      edges: [
        {
          fromId: "Function:src/b.ts:bar#0",
          toId: "Function:src/a.ts:foo#0",
          type: "CALLS",
          confidence: 1,
        },
      ],
      nodeCount: 1,
      edgeCount: 1,
      truncated: false,
    },
    verdict: {
      verdict: exitCode === 0 ? "single_review" : exitCode === 1 ? "dual_review" : "expert_review",
      confidence: 0.85,
      decisionBoundary: { distancePercent: 50, nextTier: "dual_review" },
      reasoningChain: [{ label: "blast_radius", value: 3, severity: "warn" }],
      recommendedReviewers: [],
      githubLabels: ["review:single"],
      reviewCommentMarkdown: "",
      exitCode,
      blastRadius: 3,
      communitiesTouched: [],
      changedFileCount: 1,
      changedFiles: ["src/a.ts"],
      affectedSymbolCount: 1,
    },
    affectedTests: [
      {
        id: "Function:src/foo.test.ts:itFoo#0",
        name: "itFoo",
        filePath: "src/foo.test.ts",
        reachedFromSymbol: "Function:src/a.ts:foo#0",
        depth: 1,
      },
    ],
    costAttribution: {
      estimate: true,
      tokenizerModel: "char-heuristic-v1",
      changePackTokens: 120,
      blindBaselineTokens: 480,
      tokensSaved: 360,
      tokensSavedPct: 75,
      affectedTestCount: 1,
      totalTestCount: 4,
      ciTestsSkipped: 3,
    },
    changePackHash: "deadbeef".repeat(8),
  };
  return { ...base, ...overrides };
}

function stubRun(
  pack: ChangePack,
  capture?: (query: ChangePackQuery) => void,
): NonNullable<ChangePackOptions["_runChangePack"]> {
  return async (_store: IGraphStore, query: ChangePackQuery) => {
    capture?.(query);
    return pack;
  };
}

interface StdoutCapture {
  readonly chunks: string[];
  restore(): void;
}

function captureLog(): StdoutCapture {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  return {
    chunks,
    restore: () => {
      console.log = orig;
    },
  };
}

async function withExitCode<T>(fn: () => Promise<T>): Promise<{ result: T; exitCode: number }> {
  const prev = process.exitCode;
  process.exitCode = 0;
  try {
    const result = await fn();
    const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    return { result, exitCode };
  } finally {
    process.exitCode = prev;
  }
}

// --- tests -----------------------------------------------------------------

test("runChangePackCmd --json emits raw camelCase ChangePack, exit = verdict.exitCode", async () => {
  const handle = fakeStore();
  const cap = captureLog();
  const { exitCode } = await withExitCode(async () => {
    try {
      await runChangePackCmd({
        json: true,
        _openStore: async () => ({ store: handle.store, repoPath: "/tmp/fake-repo" }),
        _runChangePack: stubRun(packFixture(2)),
      });
    } finally {
      cap.restore();
    }
  });
  const output = cap.chunks.join("\n");
  const fixture = packFixture(2);
  const parsed = JSON.parse(output) as ChangePack;
  assert.equal(parsed.changePackHash, "deadbeef".repeat(8));
  assert.equal(parsed.costAttribution.estimate, true);
  assert.equal(parsed.verdict.verdict, "expert_review");
  // CLI<->MCP parity (CLI half): `--json` is a PURE passthrough — the emitted
  // object deep-equals the analysis ChangePack with zero reshaping. The MCP
  // half (that toStructured recases the same values losslessly) is asserted in
  // packages/mcp/src/tools/change-pack.parity.test.ts. Together they prove both
  // surfaces serialize identical values.
  assert.deepEqual(parsed, fixture, "CLI --json must emit the raw ChangePack unchanged");
  // No human-summary prose leaks into JSON mode.
  assert.doesNotMatch(output, /^change-pack: /m);
  // Exit code is the verdict's own code (expert_review → 2).
  assert.equal(exitCode, 2);
  assert.ok(handle.closed(), "store must be closed in finally");
});

test("runChangePackCmd default (no --json) → human summary, exit = verdict.exitCode", async () => {
  const handle = fakeStore();
  const cap = captureLog();
  const { exitCode } = await withExitCode(async () => {
    try {
      await runChangePackCmd({
        _openStore: async () => ({ store: handle.store, repoPath: "/tmp/fake-repo" }),
        _runChangePack: stubRun(packFixture(1)),
      });
    } finally {
      cap.restore();
    }
  });
  const output = cap.chunks.join("\n");
  assert.match(output, /change-pack: 1 file\(s\), 1 symbol\(s\) changed\. Verdict: dual_review\./);
  assert.match(output, /Impacted subgraph: 1 node\(s\), 1 edge\(s\)\./);
  assert.match(output, /Affected tests \(1\):/);
  assert.match(output, /• itFoo — src\/foo\.test\.ts/);
  assert.match(
    output,
    /Est\. tokens saved: 360 \(75%\) vs blind read; CI tests skippable: 3\/4 \(est\.\)/,
  );
  // Summary mode is not JSON.
  assert.doesNotMatch(output, /"changePackHash"/);
  // dual_review → exit 1.
  assert.equal(exitCode, 1);
  assert.ok(handle.closed(), "store must be closed in finally");
});

test("runChangePackCmd: auto_merge-tier exit code is 0", async () => {
  const handle = fakeStore();
  const cap = captureLog();
  const { exitCode } = await withExitCode(async () => {
    try {
      await runChangePackCmd({
        json: true,
        _openStore: async () => ({ store: handle.store, repoPath: "/tmp/fake-repo" }),
        _runChangePack: stubRun(packFixture(0)),
      });
    } finally {
      cap.restore();
    }
  });
  assert.equal(exitCode, 0);
});

test("runChangePackCmd: subgraph truncation surfaces in the summary", async () => {
  const handle = fakeStore();
  const cap = captureLog();
  await withExitCode(async () => {
    try {
      await runChangePackCmd({
        _openStore: async () => ({ store: handle.store, repoPath: "/tmp/fake-repo" }),
        _runChangePack: stubRun(
          packFixture(0, {
            impactedSubgraph: {
              nodes: [],
              edges: [],
              nodeCount: 5000,
              edgeCount: 9000,
              truncated: true,
            },
          }),
        ),
      });
    } finally {
      cap.restore();
    }
  });
  const output = cap.chunks.join("\n");
  assert.match(output, /Impacted subgraph: 5000 node\(s\), 9000 edge\(s\) \(truncated\)\./);
});

test("runChangePackCmd threads base/head/depth/min-confidence/budget/include-tests into the runner", async () => {
  const handle = fakeStore();
  const cap = captureLog();
  let seen: ChangePackQuery | undefined;
  await withExitCode(async () => {
    try {
      await runChangePackCmd({
        base: "release",
        head: "feature/x",
        depth: 6,
        minConfidence: 0.5,
        budget: 50_000,
        includeTestsInSubgraph: true,
        json: true,
        _openStore: async () => ({ store: handle.store, repoPath: "/tmp/fake-repo" }),
        _runChangePack: stubRun(packFixture(0), (q) => {
          seen = q;
        }),
      });
    } finally {
      cap.restore();
    }
  });
  assert.ok(seen);
  assert.equal(seen?.repoPath, "/tmp/fake-repo");
  assert.equal(seen?.base, "release");
  assert.equal(seen?.head, "feature/x");
  assert.equal(seen?.depth, 6);
  assert.equal(seen?.minConfidence, 0.5);
  assert.equal(seen?.budget, 50_000);
  assert.equal(seen?.includeTestsInSubgraph, true);
});

test("runChangePackCmd omits unset query fields (defaults handled in the analysis layer)", async () => {
  const handle = fakeStore();
  const cap = captureLog();
  let seen: ChangePackQuery | undefined;
  await withExitCode(async () => {
    try {
      await runChangePackCmd({
        json: true,
        _openStore: async () => ({ store: handle.store, repoPath: "/tmp/fake-repo" }),
        _runChangePack: stubRun(packFixture(0), (q) => {
          seen = q;
        }),
      });
    } finally {
      cap.restore();
    }
  });
  assert.ok(seen);
  assert.equal(seen?.repoPath, "/tmp/fake-repo");
  assert.equal(seen?.base, undefined);
  assert.equal(seen?.head, undefined);
  assert.equal(seen?.depth, undefined);
  assert.equal(seen?.minConfidence, undefined);
  assert.equal(seen?.budget, undefined);
  assert.equal(seen?.includeTestsInSubgraph, undefined);
});
