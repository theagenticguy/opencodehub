/**
 * Tests for the PageRank-ranked symbol skeleton (AC-M5-4 — item 2/9).
 *
 * Covers:
 *   - A. Determinism: two consecutive calls return deep-equal output.
 *   - B. Score-DESC + id-ASC ordering on a known fixture.
 *   - C. CALLS-edge filtering (other relation types must NOT influence
 *        the call graph).
 *   - D. Empty graph short-circuit returns `[]`.
 *   - E. `limit` truncates after sorting.
 *   - F. Method `owner` round-trips; non-Method nodes omit it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { GraphNode } from "@opencodehub/core-types";
import { canonicalJson } from "@opencodehub/core-types";
import type { IGraphStore, ListNodesOptions } from "@opencodehub/storage";
import { buildSkeleton, type SkeletonRow } from "./skeleton.js";

interface RawEdge {
  readonly from_id: string;
  readonly to_id: string;
  readonly type: string;
}

/**
 * Build a thin in-memory `IGraphStore` mock that satisfies only the
 * methods `buildSkeleton` reaches: `listNodes` (kind-filtered) and
 * `query` (the single CALLS-edge SQL).
 */
function makeStore(nodes: readonly GraphNode[], edges: readonly RawEdge[] = []): IGraphStore {
  return {
    listNodes: async (opts: ListNodesOptions = {}) => {
      const kinds = opts.kinds;
      if (kinds !== undefined && kinds.length === 0) return [];
      const set = kinds === undefined ? undefined : new Set(kinds);
      const filtered = set === undefined ? [...nodes] : nodes.filter((n) => set.has(n.kind));
      // Mirror the storage-layer contract: ORDER BY id ASC + JS-side lex tiebreak.
      filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return filtered;
    },
    query: async (sql: string) => {
      // The skeleton calls exactly one SQL: "... FROM relations WHERE type = 'CALLS'".
      // We surface only the CALLS rows; any other SQL throws so the test
      // surfaces an unintended call.
      if (!/from\s+relations\s+where\s+type\s*=\s*'CALLS'/i.test(sql)) {
        throw new Error(`unexpected SQL in skeleton mock: ${sql}`);
      }
      return edges
        .filter((e) => e.type === "CALLS")
        .map((e) => ({
          from_id: e.from_id,
          to_id: e.to_id,
        }));
    },
  } as unknown as IGraphStore;
}

const NODES: readonly GraphNode[] = [
  // Three functions; "fn:c" is called by both A and B (highest in-degree).
  {
    id: "fn:a" as GraphNode["id"],
    kind: "Function",
    name: "a",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 5,
  },
  {
    id: "fn:b" as GraphNode["id"],
    kind: "Function",
    name: "b",
    filePath: "src/b.ts",
    startLine: 1,
    endLine: 5,
  },
  {
    id: "fn:c" as GraphNode["id"],
    kind: "Function",
    name: "c",
    filePath: "src/c.ts",
    startLine: 1,
    endLine: 5,
  },
  {
    id: "cls:S" as GraphNode["id"],
    kind: "Class",
    name: "S",
    filePath: "src/s.ts",
    startLine: 1,
    endLine: 30,
  },
  {
    id: "mtd:S.greet" as GraphNode["id"],
    kind: "Method",
    name: "greet",
    filePath: "src/s.ts",
    startLine: 5,
    endLine: 9,
    owner: "S",
  },
];

const CALLS: readonly RawEdge[] = [
  { from_id: "fn:a", to_id: "fn:c", type: "CALLS" },
  { from_id: "fn:b", to_id: "fn:c", type: "CALLS" },
  // A non-CALLS edge that must be ignored.
  { from_id: "fn:a", to_id: "cls:S", type: "REFERENCES" },
];

test("A. buildSkeleton is deterministic across two consecutive calls", async () => {
  const store = makeStore(NODES, CALLS);
  const first = await buildSkeleton({ store });
  const second = await buildSkeleton({ store });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first, second);
});

test("B. rows are sorted score DESC with id ASC tiebreak", async () => {
  const store = makeStore(NODES, CALLS);
  const rows = await buildSkeleton({ store });
  // Only callable kinds appear (Function/Class/Method).
  for (const r of rows) {
    assert.ok(["Function", "Class", "Method"].includes(r.kind));
  }
  // fn:c receives the most inbound mass — it should rank first.
  assert.equal(rows[0]?.id, "fn:c");
  // Strictly non-increasing score.
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const cur = rows[i];
    assert.ok(prev !== undefined && cur !== undefined);
    assert.ok(
      prev.score > cur.score || (prev.score === cur.score && prev.id <= cur.id),
      `ordering broken at ${i}: ${JSON.stringify({ prev, cur })}`,
    );
  }
});

test("C. non-CALLS relations do not feed the PageRank call graph", async () => {
  const onlyRefs: readonly RawEdge[] = [
    // A "REFERENCES" edge that would skew scores if it leaked through.
    { from_id: "fn:a", to_id: "fn:b", type: "REFERENCES" },
  ];
  const store = makeStore(NODES, onlyRefs);
  const rows = await buildSkeleton({ store });
  // With no CALLS edges, every callable receives the teleport-only baseline
  // (`1/n`) and ties resolve via id ASC — so the leading row is the
  // lex-min id `cls:S`.
  assert.equal(rows[0]?.id, "cls:S");
});

test("D. empty graph returns []", async () => {
  const store = makeStore([], []);
  const rows = await buildSkeleton({ store });
  assert.deepEqual(rows, []);
});

test("E. limit truncates after sorting", async () => {
  const store = makeStore(NODES, CALLS);
  const all = await buildSkeleton({ store });
  const top2 = await buildSkeleton({ store, limit: 2 });
  assert.equal(top2.length, 2);
  assert.deepEqual(top2, all.slice(0, 2));
});

test("F. Method.owner round-trips; non-Method rows omit owner", async () => {
  const store = makeStore(NODES, CALLS);
  const rows = await buildSkeleton({ store });
  const method = rows.find((r) => r.kind === "Method");
  const fn = rows.find((r) => r.kind === "Function");
  const cls = rows.find((r) => r.kind === "Class");
  assert.equal(method?.owner, "S");
  assert.equal(fn?.owner, undefined);
  assert.equal(cls?.owner, undefined);
});

test("G. limit=0 returns []", async () => {
  const store = makeStore(NODES, CALLS);
  const rows = await buildSkeleton({ store, limit: 0 });
  assert.deepEqual(rows, []);
});

test("H. SkeletonRow shape carries startLine/endLine when present", async () => {
  const store = makeStore(NODES, CALLS);
  const rows = await buildSkeleton({ store });
  const row = rows.find((r) => r.id === "fn:a") as SkeletonRow | undefined;
  assert.ok(row);
  assert.equal(row.startLine, 1);
  assert.equal(row.endLine, 5);
  assert.equal(row.filePath, "src/a.ts");
});
