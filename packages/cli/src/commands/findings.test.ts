/**
 * Tests for `codehub findings` CLI command.
 *
 * The command reuses the same storage reader and TS post-finder as the MCP
 * `list_findings` tool. The fake store implements `listFindings` over an
 * in-memory fixture so the tests stay tied to the production interface.
 *
 * Covers:
 *   - JSON mode emits a `{ findings, total }` payload.
 *   - `severity="none"` is filtered entirely in the TS post-finder (never
 *     pushed to listFindings) and drops non-`none` rows.
 *   - `scanner` / `filePath` substring narrowing is applied post-finder.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { FindingNode } from "@opencodehub/core-types";
import type { IGraphStore, ITemporalStore, ListFindingsOptions, Store } from "@opencodehub/storage";
import { runFindings } from "./findings.js";

function finding(over: Omit<Partial<FindingNode>, "id"> & { id: string }): FindingNode {
  return {
    kind: "Finding",
    ruleId: "R1",
    severity: "warning",
    scannerId: "semgrep",
    message: "m",
    filePath: "src/a.ts",
    propertiesBag: {},
    startLine: 1,
    ...over,
  } as unknown as FindingNode;
}

interface FakeHandle {
  closed: boolean;
  lastFindingsOpts?: ListFindingsOptions;
  store: Store;
}

function makeFakeStore(rows: readonly FindingNode[]): FakeHandle {
  const handle: FakeHandle = { closed: false, store: {} as Store };
  const graph: Partial<IGraphStore> = {
    listFindings: async (opts: ListFindingsOptions = {}) => {
      handle.lastFindingsOpts = opts;
      // Mirror the storage tier: narrow by severity / ruleId only.
      let out = [...rows];
      if (opts.severity !== undefined) {
        const set = new Set(opts.severity);
        out = out.filter((f) => set.has(f.severity as "note" | "warning" | "error"));
      }
      if (opts.ruleId !== undefined) out = out.filter((f) => f.ruleId === opts.ruleId);
      return out;
    },
  };
  handle.store = {
    graph: graph as unknown as IGraphStore,
    temporal: {} as unknown as ITemporalStore,
    graphFile: "/tmp/fake.lbug",
    temporalFile: "/tmp/fake.duckdb",
    close: async () => {
      handle.closed = true;
    },
  } as Store;
  return handle;
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

test("findings --json emits a findings payload", async () => {
  const handle = makeFakeStore([finding({ id: "x", severity: "error" })]);
  const out = await captureStdout(async () => {
    await runFindings({
      json: true,
      storeFactory: async () => ({ store: handle.store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as { findings: unknown[]; total: number };
  assert.equal(parsed.total, 1);
  assert.equal((parsed.findings[0] as { severity: string }).severity, "error");
  assert.ok(handle.closed, "store must be closed");
});

test("findings severity=none filters in TS post-finder, never passed to listFindings", async () => {
  const handle = makeFakeStore([
    finding({ id: "a", severity: "none" }),
    finding({ id: "b", severity: "warning" }),
  ]);
  const out = await captureStdout(async () => {
    await runFindings({
      severity: "none",
      json: true,
      storeFactory: async () => ({ store: handle.store, repoPath: "/tmp/r" }),
    });
  });
  // `none` must NOT be forwarded to listFindings (which only accepts the trio).
  assert.equal(handle.lastFindingsOpts?.severity, undefined);
  const parsed = JSON.parse(out) as { findings: Array<{ id: string }>; total: number };
  assert.equal(parsed.total, 1);
  assert.equal(parsed.findings[0]?.id, "a");
});

test("findings scanner + filePath narrowing is applied post-finder", async () => {
  const handle = makeFakeStore([
    finding({ id: "a", scannerId: "semgrep", filePath: "src/keep.ts" }),
    finding({ id: "b", scannerId: "osv-scanner", filePath: "src/keep.ts" }),
    finding({ id: "c", scannerId: "semgrep", filePath: "src/drop.ts" }),
  ]);
  const out = await captureStdout(async () => {
    await runFindings({
      scanner: "semgrep",
      filePath: "keep",
      json: true,
      storeFactory: async () => ({ store: handle.store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as { findings: Array<{ id: string }>; total: number };
  assert.equal(parsed.total, 1);
  assert.equal(parsed.findings[0]?.id, "a");
});
