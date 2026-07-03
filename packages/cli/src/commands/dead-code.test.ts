/**
 * Tests for `codehub dead-code` CLI command.
 *
 * The command reuses `classifyDeadness` from `@opencodehub/analysis`. The
 * fake graph implements just the readers `classifyDeadness` calls
 * (`listNodes`, `listEdges`, `listEdgesByType`) over an in-memory fixture, so
 * the test drives the real classifier rather than stubbing it.
 *
 * Covers:
 *   - A non-exported symbol with no referrers classifies dead and renders.
 *   - `--file-path-pattern` filters the dead set.
 *   - `--include-unreachable-exports` toggles the unreachable-export set in.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphNode, NodeId, NodeKind } from "@opencodehub/core-types";
import type { IGraphStore, ITemporalStore, Store } from "@opencodehub/storage";
import { runDeadCode } from "./dead-code.js";

interface FakeSym {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly isExported?: boolean;
  readonly startLine?: number;
}

function makeFakeStore(syms: readonly FakeSym[]): { store: Store; closed: () => boolean } {
  let closed = false;
  const toNode = (s: FakeSym): GraphNode =>
    ({
      id: s.id as NodeId,
      kind: "Function" as NodeKind,
      name: s.name,
      filePath: s.filePath,
      isExported: s.isExported === true,
      startLine: s.startLine ?? 1,
    }) as unknown as GraphNode;

  const graph: Partial<IGraphStore> = {
    listNodes: async (opts) => {
      if (opts?.ids !== undefined) {
        const ids = new Set(opts.ids.map(String));
        return syms.filter((s) => ids.has(s.id)).map(toNode);
      }
      // kinds-filtered fetch (Function is in SYMBOL_KINDS).
      return syms.map(toNode);
    },
    listEdges: async () => [],
    listEdgesByType: async () => [],
  };
  const store = {
    graph: graph as unknown as IGraphStore,
    temporal: {} as unknown as ITemporalStore,
    graphFile: "/tmp/fake.sqlite",
    temporalFile: "/tmp/fake.sqlite",
    close: async () => {
      closed = true;
    },
  } as Store;
  return { store, closed: () => closed };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return chunks.join("\n");
}

test("dead-code --json reports a dead non-exported symbol", async () => {
  const { store, closed } = makeFakeStore([
    { id: "Function:src/a.ts:dead", name: "dead", filePath: "src/a.ts", isExported: false },
  ]);
  const out = await captureStdout(async () => {
    await runDeadCode({ json: true, storeFactory: async () => ({ store, repoPath: "/tmp/r" }) });
  });
  const parsed = JSON.parse(out) as {
    summary: { dead: number };
    symbols: Array<{ name: string; deadness: string }>;
  };
  assert.equal(parsed.summary.dead, 1);
  assert.equal(parsed.symbols[0]?.name, "dead");
  assert.equal(parsed.symbols[0]?.deadness, "dead");
  assert.ok(closed(), "store must be closed");
});

test("dead-code --file-path-pattern narrows the dead set", async () => {
  const { store } = makeFakeStore([
    { id: "Function:src/keep.ts:a", name: "a", filePath: "src/keep.ts" },
    { id: "Function:src/drop.ts:b", name: "b", filePath: "src/drop.ts" },
  ]);
  const out = await captureStdout(async () => {
    await runDeadCode({
      json: true,
      filePathPattern: "keep",
      storeFactory: async () => ({ store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as { symbols: Array<{ filePath: string }> };
  assert.equal(parsed.symbols.length, 1);
  assert.equal(parsed.symbols[0]?.filePath, "src/keep.ts");
});

test("dead-code --include-unreachable-exports folds the export set in", async () => {
  const { store } = makeFakeStore([
    // exported, no cross-module referrer → unreachable-export.
    { id: "Function:src/x.ts:exp", name: "exp", filePath: "src/x.ts", isExported: true },
  ]);
  const withoutFlag = await captureStdout(async () => {
    await runDeadCode({ json: true, storeFactory: async () => ({ store, repoPath: "/tmp/r" }) });
  });
  const a = JSON.parse(withoutFlag) as {
    symbols: unknown[];
    summary: { unreachableExports: number };
  };
  assert.equal(a.symbols.length, 0, "default excludes unreachable exports from symbols");
  assert.equal(a.summary.unreachableExports, 1);

  const { store: store2 } = makeFakeStore([
    { id: "Function:src/x.ts:exp", name: "exp", filePath: "src/x.ts", isExported: true },
  ]);
  const withFlag = await captureStdout(async () => {
    await runDeadCode({
      json: true,
      includeUnreachableExports: true,
      storeFactory: async () => ({ store: store2, repoPath: "/tmp/r" }),
    });
  });
  const b = JSON.parse(withFlag) as { symbols: Array<{ deadness: string }> };
  assert.equal(b.symbols.length, 1);
  assert.equal(b.symbols[0]?.deadness, "unreachable-export");
});
