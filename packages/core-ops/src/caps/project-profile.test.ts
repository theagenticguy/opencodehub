/**
 * Unit tests for `projectProfileCapability.execute` — the shared singleton
 * reader/decoder lifted from the MCP `project_profile` tool. Exercises `execute`
 * directly against a fake `CapabilityStore`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeId, ProjectProfileNode } from "@opencodehub/core-types";
import type { IGraphStore, ListNodesByKindOptions } from "@opencodehub/storage";
import type { CapabilityContext, CapabilityStore } from "../capability.js";
import { projectProfileCapability } from "./project-profile.js";

function profileNode(over: Partial<ProjectProfileNode>): ProjectProfileNode {
  return {
    kind: "ProjectProfile",
    id: "ProjectProfile:.:profile" as NodeId,
    name: "profile",
    filePath: ".",
    languages: [],
    frameworks: [],
    iacTypes: [],
    apiContracts: [],
    manifests: [],
    srcDirs: [],
    ...over,
  } as ProjectProfileNode;
}

function fakeStore(nodes: readonly ProjectProfileNode[]): CapabilityStore {
  const graph = new Proxy({} as IGraphStore, {
    get(_t, prop) {
      if (prop === "listNodesByKind") {
        return async (
          _kind: string,
          _opts?: ListNodesByKindOptions,
        ): Promise<readonly ProjectProfileNode[]> => nodes;
      }
      throw new Error(`unexpected IGraphStore.${String(prop)} in project-profile capability test`);
    },
  });
  return { graph, temporal: {} as CapabilityStore["temporal"] };
}

async function run(nodes: readonly ProjectProfileNode[]) {
  const ctx: CapabilityContext = { store: fakeStore(nodes), repoName: "demo-repo" };
  return projectProfileCapability.execute({}, ctx);
}

test("project-profile: decodes arrays, echoes repoName, flags profileExists", async () => {
  const out = await run([
    profileNode({
      languages: ["typescript", "python"],
      frameworks: ["nextjs"],
      iacTypes: ["terraform"],
      apiContracts: ["openapi"],
      manifests: ["package.json"],
      srcDirs: ["src"],
    }),
  ]);
  assert.equal(out.repoName, "demo-repo");
  assert.equal(out.profileExists, true);
  assert.deepEqual([...out.profile.languages], ["typescript", "python"]);
  assert.deepEqual([...out.profile.frameworks], ["nextjs"]);
  assert.deepEqual([...out.profile.iacTypes], ["terraform"]);
  assert.deepEqual([...out.profile.apiContracts], ["openapi"]);
  assert.equal(out.profile.frameworksDetected.length, 0, "absent frameworksDetected → empty array");
});

test("project-profile: carries structured frameworksDetected when present", async () => {
  const out = await run([
    profileNode({
      frameworks: ["nextjs"],
      frameworksDetected: [
        {
          name: "nextjs",
          category: "meta",
          variant: "app-router",
          confidence: "deterministic",
          evidence: [],
        },
      ],
    }),
  ]);
  assert.equal(out.profile.frameworksDetected.length, 1);
  assert.equal(out.profile.frameworksDetected[0]?.variant, "app-router");
});

test("project-profile: no node → profileExists false with empty arrays", async () => {
  const out = await run([]);
  assert.equal(out.profileExists, false);
  assert.equal(out.profile.languages.length, 0);
  assert.equal(out.profile.srcDirs.length, 0);
});
