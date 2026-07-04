/**
 * Unit tests for `dependenciesCapability.execute` — the shared reader/filter/
 * projection lifted from the MCP `dependencies` tool. Exercises `execute`
 * directly against a fake `CapabilityStore`, so it needs no real store, no repo
 * resolution, and no transport.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DependencyNode, NodeId } from "@opencodehub/core-types";
import type { IGraphStore, ListDependenciesOptions } from "@opencodehub/storage";
import type { CapabilityContext, CapabilityStore } from "../capability.js";
import { type DependenciesInput, dependenciesCapability } from "./dependencies.js";

/** Build a Dependency fixture from a plain string id (kept verbatim). */
function dep(over: Omit<Partial<DependencyNode>, "id"> & { id: string }): DependencyNode {
  return {
    kind: "Dependency",
    name: over.id,
    filePath: "package.json",
    version: "1.0.0",
    ecosystem: "npm",
    lockfileSource: "package-lock.json",
    ...over,
    id: over.id as NodeId,
  } as DependencyNode;
}

function fakeStore(corpus: readonly DependencyNode[]): {
  store: CapabilityStore;
  lastOpts: () => ListDependenciesOptions | undefined;
} {
  let captured: ListDependenciesOptions | undefined;
  const graph = new Proxy({} as IGraphStore, {
    get(_t, prop) {
      if (prop === "listDependencies") {
        return async (opts?: ListDependenciesOptions): Promise<readonly DependencyNode[]> => {
          captured = opts;
          let rows = corpus;
          if (opts?.ecosystem !== undefined)
            rows = rows.filter((d) => d.ecosystem === opts.ecosystem);
          if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit);
          return rows;
        };
      }
      throw new Error(`unexpected IGraphStore.${String(prop)} in dependencies capability test`);
    },
  });
  const store: CapabilityStore = { graph, temporal: {} as CapabilityStore["temporal"] };
  return { store, lastOpts: () => captured };
}

async function run(input: DependenciesInput, corpus: readonly DependencyNode[]) {
  const { store, lastOpts } = fakeStore(corpus);
  const ctx: CapabilityContext = { store, repoName: "demo-repo" };
  const out = await dependenciesCapability.execute(input, ctx);
  return { out, lastOpts };
}

test("dependencies: projects rows, echoes repoName, defaults limit to 500", async () => {
  const { out, lastOpts } = await run({}, [dep({ id: "a" }), dep({ id: "b" })]);
  assert.equal(out.repoName, "demo-repo");
  assert.equal(out.total, 2);
  assert.equal(out.dependencies.length, 2);
  assert.equal(lastOpts()?.limit, 500, "default limit pushed to the storage tier");
  const r = out.dependencies[0];
  assert.equal(r?.id, "a");
  assert.equal(r?.ecosystem, "npm");
  assert.equal(r?.version, "1.0.0");
});

test("dependencies: ecosystem is pushed to the storage tier", async () => {
  const { out, lastOpts } = await run({ ecosystem: "cargo" }, [
    dep({ id: "rust", ecosystem: "cargo" }),
    dep({ id: "node", ecosystem: "npm" }),
  ]);
  assert.equal(lastOpts()?.ecosystem, "cargo", "ecosystem pushed down");
  assert.equal(out.total, 1);
  assert.equal(out.dependencies[0]?.id, "rust");
});

test("dependencies: filePath substring is applied in the TS post-finder over lockfileSource", async () => {
  const { out } = await run({ filePath: "apps/web/" }, [
    dep({ id: "hit", lockfileSource: "apps/web/package-lock.json" }),
    dep({ id: "miss", lockfileSource: "apps/api/package-lock.json" }),
  ]);
  assert.equal(out.total, 1);
  assert.equal(out.dependencies[0]?.id, "hit");
});

test("dependencies: missing/loose fields fall back through stringOr; lockfile falls back to filePath", async () => {
  // A deliberately loose runtime row built WITHOUT the `dep()` defaults: no
  // lockfileSource, no license. Production rehydration can produce rows looser
  // than the typed shape, which is exactly why the projection uses `stringOr` +
  // the `lockfileSource ?? filePath` guard.
  const loose = {
    kind: "Dependency",
    id: "loose" as NodeId,
    name: "loose",
    filePath: "pkg.json",
    version: "1.0.0",
    ecosystem: "npm",
  } as unknown as DependencyNode;
  const { out } = await run({}, [loose]);
  const r = out.dependencies[0];
  assert.equal(r?.license, "UNKNOWN", "missing license → UNKNOWN sentinel");
  assert.equal(r?.lockfileSource, "pkg.json", "missing lockfileSource → filePath fallback");
});

test("dependencies: empty corpus yields total 0", async () => {
  const { out } = await run({}, []);
  assert.equal(out.total, 0);
  assert.equal(out.dependencies.length, 0);
});
