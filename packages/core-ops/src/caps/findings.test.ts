/**
 * Unit tests for `findingsCapability.execute` — the shared reader/filter/
 * projection lifted from the (byte-identical) MCP `list_findings` tool and CLI
 * `codehub findings` command. Exercises `execute` directly against a fake
 * `CapabilityStore`, so it needs no real store, no repo resolution, and no
 * transport. This is the one place the shared logic is now tested.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { FindingNode, NodeId } from "@opencodehub/core-types";
import type { IGraphStore, ListFindingsOptions } from "@opencodehub/storage";
import type { CapabilityContext, CapabilityStore } from "../capability.js";
import { type FindingsInput, findingsCapability } from "./findings.js";

/**
 * Build a Finding fixture from a plain string id. The id is kept verbatim (not
 * a real `${kind}:${path}:${name}` node id) so assertions can compare against
 * the literal; the cast satisfies the `NodeId` brand without altering the value.
 */
function finding(over: Omit<Partial<FindingNode>, "id"> & { id: string }): FindingNode {
  return {
    kind: "Finding",
    name: over.id,
    filePath: "src/a.ts",
    ruleId: "rule-x",
    severity: "warning",
    scannerId: "semgrep",
    message: "msg",
    propertiesBag: {},
    ...over,
    id: over.id as NodeId,
  } as FindingNode;
}

/**
 * A fake store whose `listFindings` records the opts it was called with and
 * returns a fixed corpus filtered by the storage-tier predicates the capability
 * pushes down (severity + ruleId + limit). Everything else on IGraphStore
 * throws so an accidental new read is caught loudly.
 */
function fakeStore(corpus: readonly FindingNode[]): {
  store: CapabilityStore;
  lastOpts: () => ListFindingsOptions | undefined;
} {
  let captured: ListFindingsOptions | undefined;
  const graph = new Proxy({} as IGraphStore, {
    get(_t, prop) {
      if (prop === "listFindings") {
        return async (opts?: ListFindingsOptions): Promise<readonly FindingNode[]> => {
          captured = opts;
          let rows = corpus;
          if (opts?.severity !== undefined) {
            const set = new Set(opts.severity);
            rows = rows.filter((f) => set.has(f.severity as "note" | "warning" | "error"));
          }
          if (opts?.ruleId !== undefined) rows = rows.filter((f) => f.ruleId === opts.ruleId);
          if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit);
          return rows;
        };
      }
      throw new Error(`unexpected IGraphStore.${String(prop)} in findings capability test`);
    },
  });
  const store: CapabilityStore = {
    graph,
    temporal: {} as CapabilityStore["temporal"],
  };
  return { store, lastOpts: () => captured };
}

function ctxFor(corpus: readonly FindingNode[]): {
  ctx: CapabilityContext;
  lastOpts: () => ListFindingsOptions | undefined;
} {
  const { store, lastOpts } = fakeStore(corpus);
  return { ctx: { store, repoName: "demo-repo" }, lastOpts };
}

async function run(input: FindingsInput, corpus: readonly FindingNode[]) {
  const { ctx, lastOpts } = ctxFor(corpus);
  const out = await findingsCapability.execute(input, ctx);
  return { out, lastOpts };
}

test("findings: projects rows, echoes repoName, defaults limit to 500", async () => {
  const { out, lastOpts } = await run({}, [finding({ id: "f1" }), finding({ id: "f2" })]);
  assert.equal(out.repoName, "demo-repo");
  assert.equal(out.total, 2);
  assert.equal(out.findings.length, 2);
  assert.equal(lastOpts()?.limit, 500, "default limit pushed to the storage tier");
  const r = out.findings[0];
  assert.equal(r?.id, "f1");
  assert.equal(r?.scanner, "semgrep");
  assert.equal(r?.severity, "warning");
});

test("findings: severity + ruleId are pushed to the storage tier", async () => {
  const { out, lastOpts } = await run({ severity: "error", ruleId: "rule-x" }, [
    finding({ id: "e1", severity: "error", ruleId: "rule-x" }),
    finding({ id: "w1", severity: "warning", ruleId: "rule-x" }),
    finding({ id: "e2", severity: "error", ruleId: "rule-y" }),
  ]);
  assert.deepEqual(lastOpts()?.severity, ["error"], "severity pushed down");
  assert.equal(lastOpts()?.ruleId, "rule-x", "ruleId pushed down");
  assert.equal(out.total, 1);
  assert.equal(out.findings[0]?.id, "e1");
  assert.deepEqual(out.filters, { severity: "error", ruleId: "rule-x" });
});

test("findings: severity='none' is NOT pushed down; filtered in TS to none-only", async () => {
  const { out, lastOpts } = await run({ severity: "none" }, [
    finding({ id: "n1", severity: "none" }),
    finding({ id: "w1", severity: "warning" }),
  ]);
  assert.equal(lastOpts()?.severity, undefined, "'none' must not reach the storage tier");
  assert.equal(out.total, 1);
  assert.equal(out.findings[0]?.id, "n1");
});

test("findings: scanner + filePath substring are applied in the TS post-finder", async () => {
  const { out } = await run({ scanner: "osv-scanner", filePath: "pkg/" }, [
    finding({ id: "a", scannerId: "osv-scanner", filePath: "pkg/dep.ts" }),
    finding({ id: "b", scannerId: "semgrep", filePath: "pkg/dep.ts" }), // wrong scanner
    finding({ id: "c", scannerId: "osv-scanner", filePath: "src/app.ts" }), // path miss
  ]);
  assert.equal(out.total, 1);
  assert.equal(out.findings[0]?.id, "a");
  assert.deepEqual(out.filters, { scanner: "osv-scanner", filePath: "pkg/" });
});

test("findings: startLine/endLine included only when finite; missing fields fall back", async () => {
  const { out } = await run({}, [
    finding({ id: "withLines", startLine: 3, endLine: 7 }),
    finding({ id: "noLines" }),
  ]);
  const withLines = out.findings.find((f) => f.id === "withLines");
  const noLines = out.findings.find((f) => f.id === "noLines");
  assert.equal(withLines?.startLine, 3);
  assert.equal(withLines?.endLine, 7);
  assert.equal(noLines?.startLine, undefined, "absent startLine stays absent");
  assert.equal(noLines?.endLine, undefined);
});

test("findings: empty corpus yields total 0 and empty filters when unfiltered", async () => {
  const { out } = await run({}, []);
  assert.equal(out.total, 0);
  assert.equal(out.findings.length, 0);
  assert.deepEqual(out.filters, {});
});
