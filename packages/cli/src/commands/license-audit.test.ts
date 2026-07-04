/**
 * Tests for `codehub license-audit` CLI command.
 *
 * The command reads `store.graph.listDependencies()`, maps to DependencyRef,
 * and runs `classifyDependencies` from `@opencodehub/analysis`. The fake
 * store returns a fixed Dependency list.
 *
 * Covers:
 *   - A copyleft (GPL) dep drives tier=BLOCK.
 *   - An all-permissive set drives tier=OK with cleared output.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DependencyNode } from "@opencodehub/core-types";
import type { IGraphStore, ITemporalStore, Store } from "@opencodehub/storage";
import { runLicenseAudit } from "./license-audit.js";

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

function makeFakeStore(deps: readonly DependencyNode[]): { store: Store; closed: () => boolean } {
  let closed = false;
  const graph: Partial<IGraphStore> = {
    listDependencies: async () => deps,
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

test("license-audit --json flags a GPL dep as tier=BLOCK", async () => {
  const { store, closed } = makeFakeStore([
    dep({ id: "d1", name: "copyleft-lib", license: "GPL-3.0" }),
    dep({ id: "d2", name: "ok-lib", license: "MIT" }),
  ]);
  const out = await captureStdout(async () => {
    await runLicenseAudit({
      json: true,
      storeFactory: async () => ({ store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as {
    tier: string;
    flagged: { copyleft: Array<{ name: string }> };
  };
  assert.equal(parsed.tier, "BLOCK");
  assert.equal(parsed.flagged.copyleft[0]?.name, "copyleft-lib");
  assert.ok(closed(), "store must be closed");
});

test("license-audit --json clears an all-permissive set to tier=OK", async () => {
  const { store } = makeFakeStore([dep({ id: "d1", name: "ok-lib", license: "Apache-2.0" })]);
  const out = await captureStdout(async () => {
    await runLicenseAudit({
      json: true,
      storeFactory: async () => ({ store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as { tier: string };
  assert.equal(parsed.tier, "OK");
});
