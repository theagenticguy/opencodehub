/**
 * Unit tests for `contextCapability.execute` — the shared PROCESS_STEP reader
 * lifted from the (behaviourally identical) `fetchProcessParticipation` in the
 * MCP `context` tool and CLI `codehub context` command. Exercises `execute`
 * directly against a fake `CapabilityStore`, so it needs no real store, no repo
 * resolution, and no transport. This is the one place the shared reader is now
 * tested; the two surfaces' resolvers + presenters keep their own tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeRelation, GraphNode, NodeId } from "@opencodehub/core-types";
import type { IGraphStore, ListEdgesByTypeOptions, ListNodesOptions } from "@opencodehub/storage";
import type { CapabilityContext, CapabilityStore } from "../capability.js";
import { type ContextInput, contextCapability } from "./context.js";

interface EdgeSpec {
  readonly from: string;
  readonly to: string;
  readonly step?: number;
}

interface NodeSpec {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly inferredLabel?: string;
}

/**
 * A fake store implementing only the two finders the capability calls —
 * `listEdgesByType` (PROCESS_STEP, filtered by fromIds/toIds) and `listNodes`
 * (by ids). Everything else on IGraphStore throws so an accidental new read is
 * caught loudly.
 */
function fakeStore(edges: readonly EdgeSpec[], nodes: readonly NodeSpec[]): CapabilityStore {
  const graph = new Proxy({} as IGraphStore, {
    get(_t, prop) {
      if (prop === "listEdgesByType") {
        return async (
          type: string,
          opts?: ListEdgesByTypeOptions,
        ): Promise<readonly CodeRelation[]> => {
          assert.equal(type, "PROCESS_STEP");
          const fromIds = opts?.fromIds ? new Set(opts.fromIds.map(String)) : undefined;
          const toIds = opts?.toIds ? new Set(opts.toIds.map(String)) : undefined;
          return edges
            .filter(
              (e) => (fromIds ? fromIds.has(e.from) : true) && (toIds ? toIds.has(e.to) : true),
            )
            .map(
              (e) =>
                ({
                  from: e.from as NodeId,
                  to: e.to as NodeId,
                  type: "PROCESS_STEP",
                  ...(e.step !== undefined ? { step: e.step } : {}),
                }) as unknown as CodeRelation,
            );
        };
      }
      if (prop === "listNodes") {
        return async (opts?: ListNodesOptions): Promise<readonly GraphNode[]> => {
          const ids = opts?.ids ? new Set(opts.ids.map(String)) : undefined;
          return nodes
            .filter((n) => (ids ? ids.has(n.id) : true))
            .map(
              (n) =>
                ({
                  id: n.id as NodeId,
                  name: n.name,
                  kind: n.kind,
                  filePath: "src/x.ts",
                  ...(n.inferredLabel !== undefined ? { inferredLabel: n.inferredLabel } : {}),
                }) as unknown as GraphNode,
            );
        };
      }
      throw new Error(`unexpected IGraphStore.${String(prop)} in context capability test`);
    },
  });
  return { graph, temporal: {} as CapabilityStore["temporal"] };
}

async function run(input: ContextInput, edges: readonly EdgeSpec[], nodes: readonly NodeSpec[]) {
  const ctx: CapabilityContext = { store: fakeStore(edges, nodes), repoName: "demo-repo" };
  return contextCapability.execute(input, ctx);
}

test("context: no PROCESS_STEP edges yields empty processes and echoes repoName", async () => {
  const out = await run({ targetId: "F:foo" }, [], []);
  assert.equal(out.repoName, "demo-repo");
  assert.deepEqual(out.processes, []);
});

test("context: collects Process partners in both edge directions", async () => {
  const out = await run(
    { targetId: "F:foo" },
    [
      { from: "F:foo", to: "P:out", step: 2 },
      { from: "P:in", to: "F:foo", step: 1 },
    ],
    [
      { id: "P:out", name: "outbound-process", kind: "Process" },
      { id: "P:in", name: "inbound-process", kind: "Process" },
    ],
  );
  // Sorted by step asc: P:in (1) before P:out (2).
  assert.deepEqual(out.processes, [
    { id: "P:in", label: "inbound-process", step: 1 },
    { id: "P:out", label: "outbound-process", step: 2 },
  ]);
});

test("context: non-Process partners are dropped", async () => {
  const out = await run(
    { targetId: "F:foo" },
    [
      { from: "F:foo", to: "F:notaprocess", step: 1 },
      { from: "F:foo", to: "P:real", step: 2 },
    ],
    [
      { id: "F:notaprocess", name: "sibling", kind: "Function" },
      { id: "P:real", name: "real-process", kind: "Process" },
    ],
  );
  assert.equal(out.processes.length, 1);
  assert.equal(out.processes[0]?.id, "P:real");
});

test("context: inferredLabel wins over name when present, else falls back to name", async () => {
  const out = await run(
    { targetId: "F:foo" },
    [
      { from: "F:foo", to: "P:a", step: 1 },
      { from: "F:foo", to: "P:b", step: 2 },
    ],
    [
      { id: "P:a", name: "raw-name-a", kind: "Process", inferredLabel: "Nice Label A" },
      { id: "P:b", name: "raw-name-b", kind: "Process" },
    ],
  );
  assert.equal(out.processes[0]?.label, "Nice Label A");
  assert.equal(out.processes[1]?.label, "raw-name-b");
});

test("context: step is null when absent or non-positive; nulls sort last, id tiebreak", async () => {
  const out = await run(
    { targetId: "F:foo" },
    [
      { from: "F:foo", to: "P:nostep" },
      { from: "F:foo", to: "P:zero", step: 0 },
      { from: "F:foo", to: "P:one", step: 1 },
    ],
    [
      { id: "P:nostep", name: "no-step", kind: "Process" },
      { id: "P:zero", name: "zero-step", kind: "Process" },
      { id: "P:one", name: "one-step", kind: "Process" },
    ],
  );
  // step=1 first; the two null-step (absent + zero) sort by id: P:nostep < P:zero.
  assert.deepEqual(
    out.processes.map((p) => [p.id, p.step]),
    [
      ["P:one", 1],
      ["P:nostep", null],
      ["P:zero", null],
    ],
  );
});

test("context: caps participation at 20 partners", async () => {
  const edges: EdgeSpec[] = [];
  const nodes: NodeSpec[] = [];
  for (let i = 0; i < 30; i += 1) {
    const id = `P:${String(i).padStart(2, "0")}`;
    edges.push({ from: "F:foo", to: id, step: i + 1 });
    nodes.push({ id, name: `proc-${i}`, kind: "Process" });
  }
  const out = await run({ targetId: "F:foo" }, edges, nodes);
  assert.equal(out.processes.length, 20);
});
