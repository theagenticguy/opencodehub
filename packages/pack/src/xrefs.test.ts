/**
 * Tests for the xrefs BOM body (AC-M5-5 — item 6/9).
 *
 * Covers:
 *   - A. Determinism across two consecutive calls.
 *   - B. Community rows lead the output, alpha-sorted by id.
 *   - C. Call rows trail community rows, sorted (from, to, id).
 *   - D. Non-CALLS relations are excluded by `listEdgesByType('CALLS')`
 *        on the storage layer — the mock honours the type filter directly.
 *   - E. Empty graph produces `[]`.
 *   - F. Community node optional fields round-trip (`inferredLabel`,
 *        `memberCount` from `symbolCount`).
 *   - G. Missing/non-numeric `confidence` coerces to 0.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CodeRelation, CommunityNode, GraphNode } from "@opencodehub/core-types";
import { canonicalJson } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";
import { buildXrefs, type XrefRow } from "./xrefs.js";

function makeStore(nodes: readonly GraphNode[], rels: readonly CodeRelation[] = []): IGraphStore {
  return {
    listNodesByKind: async (kind: string) => {
      const filtered = nodes.filter((n) => n.kind === kind);
      filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return filtered as readonly CommunityNode[];
    },
    listEdgesByType: async (type: string) => {
      return rels
        .filter((r) => r.type === type)
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  } as unknown as IGraphStore;
}

const COMMUNITIES: readonly GraphNode[] = [
  {
    id: "comm:b" as GraphNode["id"],
    kind: "Community",
    name: "cluster-b",
    filePath: ".",
    inferredLabel: "auth",
    symbolCount: 12,
  },
  {
    id: "comm:a" as GraphNode["id"],
    kind: "Community",
    name: "cluster-a",
    filePath: ".",
    inferredLabel: "billing",
    symbolCount: 5,
  },
];

const CALLS: readonly CodeRelation[] = [
  {
    id: "rel:2" as CodeRelation["id"],
    from: "fn:a" as CodeRelation["from"],
    to: "fn:c" as CodeRelation["to"],
    type: "CALLS",
    confidence: 1,
  },
  {
    id: "rel:1" as CodeRelation["id"],
    from: "fn:a" as CodeRelation["from"],
    to: "fn:b" as CodeRelation["to"],
    type: "CALLS",
    confidence: 1,
  },
  // Non-CALLS edge filtered by `listEdgesByType('CALLS')`.
  {
    id: "rel:3" as CodeRelation["id"],
    from: "fn:a" as CodeRelation["from"],
    to: "cls:S" as CodeRelation["to"],
    type: "REFERENCES",
    confidence: 1,
  },
  // Tiebreak — same (from, to), different id. Lower id should come first.
  {
    id: "rel:5" as CodeRelation["id"],
    from: "fn:b" as CodeRelation["from"],
    to: "fn:c" as CodeRelation["to"],
    type: "CALLS",
    confidence: 1,
  },
  {
    id: "rel:4" as CodeRelation["id"],
    from: "fn:b" as CodeRelation["from"],
    to: "fn:c" as CodeRelation["to"],
    type: "CALLS",
    confidence: 1,
  },
];

test("A. buildXrefs is deterministic across two consecutive calls", async () => {
  const store = makeStore(COMMUNITIES, CALLS);
  const first = await buildXrefs({ store });
  const second = await buildXrefs({ store });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first, second);
});

test("B. community rows lead, alpha-sorted by id", async () => {
  const store = makeStore(COMMUNITIES, CALLS);
  const rows = await buildXrefs({ store });
  // First two rows are communities by id ASC: "comm:a" then "comm:b".
  assert.equal(rows[0]?.kind, "community");
  assert.equal((rows[0] as XrefRow & { kind: "community" }).id, "comm:a");
  assert.equal(rows[1]?.kind, "community");
  assert.equal((rows[1] as XrefRow & { kind: "community" }).id, "comm:b");
});

test("C. call rows trail communities, sorted by (from, to, id)", async () => {
  const store = makeStore(COMMUNITIES, CALLS);
  const rows = await buildXrefs({ store });
  const callRows = rows.filter((r): r is Extract<XrefRow, { kind: "call" }> => r.kind === "call");
  // (fn:a → fn:b) before (fn:a → fn:c) before (fn:b → fn:c, id rel:4) before (… id rel:5).
  assert.equal(callRows.length, 4);
  assert.equal(callRows[0]?.id, "rel:1");
  assert.equal(callRows[1]?.id, "rel:2");
  assert.equal(callRows[2]?.id, "rel:4");
  assert.equal(callRows[3]?.id, "rel:5");
});

test("D. non-CALLS relations are filtered by listEdgesByType", async () => {
  const store = makeStore(COMMUNITIES, CALLS);
  const rows = await buildXrefs({ store });
  // No row should reference cls:S — that edge was REFERENCES.
  for (const r of rows) {
    if (r.kind === "call") {
      assert.notEqual(r.to, "cls:S");
    }
  }
});

test("E. empty graph returns []", async () => {
  const store = makeStore([], []);
  const rows = await buildXrefs({ store });
  assert.deepEqual(rows, []);
});

test("F. Community optional fields round-trip", async () => {
  const store = makeStore(COMMUNITIES, []);
  const rows = await buildXrefs({ store });
  const a = rows.find(
    (r): r is Extract<XrefRow, { kind: "community" }> =>
      r.kind === "community" && r.id === "comm:a",
  );
  assert.ok(a !== undefined);
  assert.equal(a.inferredLabel, "billing");
  assert.equal(a.memberCount, 5);
});

test("G. NaN confidence coerces to 0", async () => {
  const rels: readonly CodeRelation[] = [
    {
      id: "rel:1" as CodeRelation["id"],
      from: "fn:a" as CodeRelation["from"],
      to: "fn:b" as CodeRelation["to"],
      type: "CALLS",
      confidence: Number.NaN,
    },
  ];
  const store = makeStore([], rels);
  const rows = await buildXrefs({ store });
  // No communities → first row is the call.
  const call = rows[0] as Extract<XrefRow, { kind: "call" }> | undefined;
  assert.ok(call !== undefined);
  assert.equal(call.kind, "call");
  // Non-finite confidence coerces to 0 by the buildXrefs guard.
  assert.equal(call.confidence, 0);
});

test("H. only Community nodes seed community rows", async () => {
  const mixed: readonly GraphNode[] = [
    ...COMMUNITIES,
    {
      id: "fn:noise" as GraphNode["id"],
      kind: "Function",
      name: "noise",
      filePath: "noise.ts",
      startLine: 1,
      endLine: 1,
    },
  ];
  const store = makeStore(mixed, []);
  const rows = await buildXrefs({ store });
  for (const r of rows) {
    assert.equal(r.kind, "community");
  }
});
