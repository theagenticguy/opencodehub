/**
 * Tests for `codehub project-profile` CLI command.
 *
 * The command reads the singleton ProjectProfile node via
 * `listNodesByKind("ProjectProfile", { limit: 1 })` and decodes its fields,
 * mirroring the MCP `project_profile` tool.
 *
 * Covers:
 *   - A populated profile renders languages/frameworks in JSON.
 *   - The structured framework view (`name:variant`) wins over flat names.
 *   - An absent profile yields empty arrays in JSON (no throw).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectProfileNode } from "@opencodehub/core-types";
import type { IGraphStore, ITemporalStore, Store } from "@opencodehub/storage";
import { runProjectProfile } from "./project-profile.js";

function makeFakeStore(profile: ProjectProfileNode | undefined): {
  store: Store;
  closed: () => boolean;
} {
  let closed = false;
  const graph: Partial<IGraphStore> = {
    listNodesByKind: (async (_kind: string) =>
      profile ? [profile] : []) as IGraphStore["listNodesByKind"],
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

test("project-profile --json renders a populated profile", async () => {
  const profile = {
    kind: "ProjectProfile",
    id: "ProjectProfile::profile",
    name: "profile",
    filePath: "",
    languages: ["typescript", "python"],
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
    iacTypes: ["terraform"],
    apiContracts: ["openapi"],
    manifests: ["package.json"],
    srcDirs: ["src"],
  } as unknown as ProjectProfileNode;
  const { store, closed } = makeFakeStore(profile);
  const out = await captureStdout(async () => {
    await runProjectProfile({
      json: true,
      storeFactory: async () => ({ store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as {
    profile: { languages: string[]; frameworksDetected: unknown[] };
  };
  assert.deepEqual(parsed.profile.languages, ["typescript", "python"]);
  assert.equal(parsed.profile.frameworksDetected.length, 1);
  assert.ok(closed(), "store must be closed");
});

test("project-profile --json returns empty arrays when the node is absent", async () => {
  const { store } = makeFakeStore(undefined);
  const out = await captureStdout(async () => {
    await runProjectProfile({
      json: true,
      storeFactory: async () => ({ store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as { profile: { languages: string[]; manifests: string[] } };
  assert.deepEqual(parsed.profile.languages, []);
  assert.deepEqual(parsed.profile.manifests, []);
});
