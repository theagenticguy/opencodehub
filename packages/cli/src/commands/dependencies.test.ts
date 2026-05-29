/**
 * Tests for `codehub dependencies` CLI command.
 *
 * The command reads `store.graph.listDependencies(opts)` and applies a TS
 * `filePath` substring post-filter, mirroring the MCP `dependencies` tool.
 *
 * Covers:
 *   - JSON mode emits a `{ dependencies, total }` payload.
 *   - The ecosystem flag is forwarded to the storage reader.
 *   - The `filePath` substring narrows the result post-finder.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DependencyNode } from "@opencodehub/core-types";
import type {
  IGraphStore,
  ITemporalStore,
  ListDependenciesOptions,
  Store,
} from "@opencodehub/storage";
import { runDependencies } from "./dependencies.js";

function dep(
  over: Omit<Partial<DependencyNode>, "id" | "name"> & { id: string; name: string },
): DependencyNode {
  return {
    kind: "Dependency",
    version: "1.0.0",
    ecosystem: "npm",
    lockfileSource: "package-lock.json",
    license: "MIT",
    filePath: "package-lock.json",
    ...over,
  } as unknown as DependencyNode;
}

interface FakeHandle {
  closed: boolean;
  lastOpts?: ListDependenciesOptions;
  store: Store;
}

function makeFakeStore(deps: readonly DependencyNode[]): FakeHandle {
  const handle: FakeHandle = { closed: false, store: {} as Store };
  const graph: Partial<IGraphStore> = {
    listDependencies: async (opts: ListDependenciesOptions = {}) => {
      handle.lastOpts = opts;
      let out = [...deps];
      if (opts.ecosystem !== undefined) out = out.filter((d) => d.ecosystem === opts.ecosystem);
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

test("dependencies --json emits a dependencies payload and forwards ecosystem", async () => {
  const handle = makeFakeStore([
    dep({ id: "d1", name: "a", ecosystem: "npm" }),
    dep({ id: "d2", name: "b", ecosystem: "pypi" }),
  ]);
  const out = await captureStdout(async () => {
    await runDependencies({
      json: true,
      ecosystem: "npm",
      storeFactory: async () => ({ store: handle.store, repoPath: "/tmp/r" }),
    });
  });
  assert.equal(handle.lastOpts?.ecosystem, "npm");
  const parsed = JSON.parse(out) as { dependencies: Array<{ name: string }>; total: number };
  assert.equal(parsed.total, 1);
  assert.equal(parsed.dependencies[0]?.name, "a");
  assert.ok(handle.closed, "store must be closed");
});

test("dependencies --file-path narrows the result post-finder", async () => {
  const handle = makeFakeStore([
    dep({ id: "d1", name: "a", lockfileSource: "apps/web/package-lock.json" }),
    dep({ id: "d2", name: "b", lockfileSource: "apps/api/package-lock.json" }),
  ]);
  const out = await captureStdout(async () => {
    await runDependencies({
      json: true,
      filePath: "apps/web",
      storeFactory: async () => ({ store: handle.store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as { dependencies: Array<{ name: string }>; total: number };
  assert.equal(parsed.total, 1);
  assert.equal(parsed.dependencies[0]?.name, "a");
});
