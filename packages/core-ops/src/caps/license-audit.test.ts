/**
 * Unit tests for `licenseAuditCapability.execute` — the shared reader/classifier
 * lifted from the MCP `license_audit` tool. Exercises `execute` directly against
 * a fake `CapabilityStore`; the tier logic itself is covered exhaustively in
 * `@opencodehub/analysis` `license-classify.test.ts`, so here we assert only the
 * read + projection + hand-off to `classifyDependencies`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DependencyNode, NodeId } from "@opencodehub/core-types";
import type { IGraphStore, ListDependenciesOptions } from "@opencodehub/storage";
import type { CapabilityContext, CapabilityStore } from "../capability.js";
import { type LicenseAuditInput, licenseAuditCapability } from "./license-audit.js";

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

function fakeStore(corpus: readonly DependencyNode[]): CapabilityStore {
  const graph = new Proxy({} as IGraphStore, {
    get(_t, prop) {
      if (prop === "listDependencies") {
        return async (_opts?: ListDependenciesOptions): Promise<readonly DependencyNode[]> =>
          corpus;
      }
      throw new Error(`unexpected IGraphStore.${String(prop)} in license-audit capability test`);
    },
  });
  return { graph, temporal: {} as CapabilityStore["temporal"] };
}

async function run(corpus: readonly DependencyNode[], input: LicenseAuditInput = {}) {
  const ctx: CapabilityContext = { store: fakeStore(corpus), repoName: "demo-repo" };
  return licenseAuditCapability.execute(input, ctx);
}

test("license-audit: echoes repoName and classifies an all-clear set as OK", async () => {
  const out = await run([
    dep({ id: "lodash", license: "MIT" }),
    dep({ id: "axios", license: "Apache-2.0" }),
  ]);
  assert.equal(out.repoName, "demo-repo");
  assert.equal(out.result.tier, "OK");
  assert.equal(out.result.summary.total, 2);
  assert.equal(out.result.summary.flaggedCount, 0);
});

test("license-audit: missing license → UNKNOWN sentinel → WARN tier", async () => {
  // `dep()` sets no default license, so `mystery` arrives with license absent —
  // the projection's `stringOr(d.license, "UNKNOWN")` yields the UNKNOWN sentinel.
  const out = await run([dep({ id: "mystery" }), dep({ id: "good", license: "MIT" })]);
  assert.equal(out.result.tier, "WARN");
  assert.equal(out.result.flagged.unknown.length, 1);
  assert.equal(out.result.flagged.unknown[0]?.name, "mystery");
});

test("license-audit: a copyleft dep drives BLOCK", async () => {
  const out = await run([
    dep({ id: "readline", license: "GPL-3.0" }),
    dep({ id: "good", license: "MIT" }),
  ]);
  assert.equal(out.result.tier, "BLOCK");
  assert.equal(out.result.flagged.copyleft.length, 1);
});

test("license-audit: empty corpus classifies as OK with zero total", async () => {
  const out = await run([]);
  assert.equal(out.result.tier, "OK");
  assert.equal(out.result.summary.total, 0);
});
