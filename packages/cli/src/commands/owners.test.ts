/**
 * Tests for `codehub owners <target>` CLI command.
 *
 * The command calls the shared `listOwners` fn from `@opencodehub/analysis`
 * (the same impl the MCP `owners` tool uses). The fake graph supplies
 * OWNED_BY edges + Contributor nodes so the confidence-desc sort,
 * slice-before-join, and `.to` ASC tiebreak are exercised end-to-end.
 *
 * Covers:
 *   - Owners are ranked confidence-desc and rendered.
 *   - `--limit` slices BEFORE the Contributor join (a low-confidence owner
 *     past the limit is dropped).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeRelation, GraphNode, NodeId, RelationType } from "@opencodehub/core-types";
import type { IGraphStore, ITemporalStore, Store } from "@opencodehub/storage";
import { runOwners } from "./owners.js";

interface FakeEdge {
  readonly from: string;
  readonly to: string;
  readonly confidence: number;
}

interface FakeContrib {
  readonly id: string;
  readonly name: string;
  readonly emailHash: string;
  readonly emailPlain?: string;
}

function makeFakeStore(
  edges: readonly FakeEdge[],
  contribs: readonly FakeContrib[],
): { store: Store; closed: () => boolean } {
  let closed = false;
  const toRel = (e: FakeEdge): CodeRelation =>
    ({
      from: e.from as NodeId,
      to: e.to as NodeId,
      type: "OWNED_BY" as RelationType,
      confidence: e.confidence,
    }) as CodeRelation;
  const toNode = (c: FakeContrib): GraphNode =>
    ({
      id: c.id as NodeId,
      kind: "Contributor",
      name: c.name,
      filePath: "",
      emailHash: c.emailHash,
      ...(c.emailPlain !== undefined ? { emailPlain: c.emailPlain } : {}),
    }) as unknown as GraphNode;

  const graph: Partial<IGraphStore> = {
    listEdgesByType: async (_type, opts) => {
      const from = opts?.fromIds?.[0];
      return edges.filter((e) => from === undefined || e.from === from).map(toRel);
    },
    listNodesByKind: (async () => contribs.map(toNode)) as IGraphStore["listNodesByKind"],
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

test("owners --json ranks contributors confidence-descending", async () => {
  const { store, closed } = makeFakeStore(
    [
      { from: "File:src/a.ts", to: "Contributor:bob", confidence: 0.3 },
      { from: "File:src/a.ts", to: "Contributor:alice", confidence: 0.7 },
    ],
    [
      { id: "Contributor:alice", name: "Alice", emailHash: "aaa", emailPlain: "alice@x.com" },
      { id: "Contributor:bob", name: "Bob", emailHash: "bbb" },
    ],
  );
  const out = await captureStdout(async () => {
    await runOwners("File:src/a.ts", {
      json: true,
      storeFactory: async () => ({ store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as {
    owners: Array<{ name: string; weight: number }>;
    total: number;
  };
  assert.equal(parsed.total, 2);
  assert.equal(parsed.owners[0]?.name, "Alice");
  assert.equal(parsed.owners[1]?.name, "Bob");
  assert.ok(closed(), "store must be closed");
});

test("owners --limit slices BEFORE the Contributor join", async () => {
  const { store } = makeFakeStore(
    [
      { from: "File:src/a.ts", to: "Contributor:alice", confidence: 0.9 },
      { from: "File:src/a.ts", to: "Contributor:bob", confidence: 0.1 },
    ],
    [
      { id: "Contributor:alice", name: "Alice", emailHash: "aaa" },
      { id: "Contributor:bob", name: "Bob", emailHash: "bbb" },
    ],
  );
  const out = await captureStdout(async () => {
    await runOwners("File:src/a.ts", {
      json: true,
      limit: 1,
      storeFactory: async () => ({ store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as { owners: Array<{ name: string }>; total: number };
  assert.equal(parsed.total, 1);
  assert.equal(parsed.owners[0]?.name, "Alice");
});
