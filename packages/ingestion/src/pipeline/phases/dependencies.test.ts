/**
 * Dependencies phase integration tests.
 *
 * Each case materialises a small fixture repo on disk, runs the scan +
 * profile phases, feeds their outputs to `dependenciesPhase.run`, and
 * asserts on the emitted Dependency nodes + DEPENDS_ON edges.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { DEPENDENCIES_PHASE_NAME, dependenciesPhase } from "./dependencies.js";
import { PROFILE_PHASE_NAME, profilePhase } from "./profile.js";
import { SCAN_PHASE_NAME, scanPhase } from "./scan.js";

async function runScanAndProfile(repo: string): Promise<{
  ctx: PipelineContext;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const onProgress = (ev: ProgressEvent): void => {
    if (ev.kind === "warn" && ev.message) warnings.push(ev.message);
  };
  const ctx0: PipelineContext = {
    repoPath: repo,
    options: { skipGit: true },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
    onProgress,
  };
  const scan = await scanPhase.run(ctx0, new Map());
  const ctx1: PipelineContext = {
    ...ctx0,
    phaseOutputs: new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
  };
  const profile = await profilePhase.run(ctx1, new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]));
  const live: PipelineContext = {
    ...ctx1,
    phaseOutputs: new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [PROFILE_PHASE_NAME, profile],
    ]),
  };
  return { ctx: live, warnings };
}

describe("dependenciesPhase — TS MVP fixture (package.json only)", () => {
  let repo: string;
  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-deps-ts-"));
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({
        name: "mvp-fixture",
        version: "0.0.0",
        dependencies: {
          express: "^4.18.2",
          zod: "^3.23.0",
        },
        devDependencies: {
          typescript: "5.4.0",
        },
      }),
    );
    // A source file so scan/profile produce non-empty output.
    await writeFile(
      path.join(repo, "index.ts"),
      "import express from 'express';\nexport const app = express();\n",
    );
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits three Dependency nodes and DEPENDS_ON edges from package.json", async () => {
    const { ctx } = await runScanAndProfile(repo);
    const out = await dependenciesPhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.dependenciesEmitted, 3);
    assert.equal(out.manifestsScanned, 1);

    const depNodes = [...ctx.graph.nodes()].filter((n) => n.kind === "Dependency");
    const names = depNodes.map((n) => n.name).sort();
    assert.deepEqual(names, ["express", "typescript", "zod"]);
    // Every node has the license sentinel v1.0 writes.
    for (const n of depNodes) {
      assert.equal((n as { license: string }).license, "UNKNOWN");
      assert.equal((n as { ecosystem: string }).ecosystem, "npm");
      assert.equal((n as { lockfileSource: string }).lockfileSource, "package.json");
    }

    const depEdges = [...ctx.graph.edges()].filter((e) => e.type === "DEPENDS_ON");
    assert.equal(depEdges.length, 3);
    for (const edge of depEdges) {
      assert.equal(edge.confidence, 1.0);
      assert.equal(edge.reason, "manifest:npm");
    }

    // skippedEcosystems lists every ecosystem except npm.
    assert.deepEqual(
      [...out.skippedEcosystems].sort(),
      ["cargo", "go", "maven", "nuget", "pypi"].sort(),
    );
  });

  it("is idempotent across runs on the same repo", async () => {
    const { ctx: ctxA } = await runScanAndProfile(repo);
    await dependenciesPhase.run(ctxA, ctxA.phaseOutputs);
    const { ctx: ctxB } = await runScanAndProfile(repo);
    await dependenciesPhase.run(ctxB, ctxB.phaseOutputs);
    const idsA = [...ctxA.graph.nodes()]
      .filter((n) => n.kind === "Dependency")
      .map((n) => n.id)
      .sort();
    const idsB = [...ctxB.graph.nodes()]
      .filter((n) => n.kind === "Dependency")
      .map((n) => n.id)
      .sort();
    assert.deepEqual(idsA, idsB);
  });
});

describe("dependenciesPhase — multi-ecosystem repo", () => {
  let repo: string;
  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-deps-multi-"));
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "m", dependencies: { "left-pad": "1.3.0" } }),
    );
    await writeFile(
      path.join(repo, "Cargo.lock"),
      ["version = 3", "", "[[package]]", 'name = "serde"', 'version = "1.0.200"', ""].join("\n"),
    );
    await writeFile(path.join(repo, "go.sum"), "github.com/pkg/errors v0.9.1 h1:xxx=\n");
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits Dependency nodes from each recognised ecosystem", async () => {
    const { ctx } = await runScanAndProfile(repo);
    const out = await dependenciesPhase.run(ctx, ctx.phaseOutputs);
    assert.ok(out.dependenciesEmitted >= 3);

    const byEco = new Map<string, number>();
    for (const n of ctx.graph.nodes()) {
      if (n.kind !== "Dependency") continue;
      const eco = (n as { ecosystem: string }).ecosystem;
      byEco.set(eco, (byEco.get(eco) ?? 0) + 1);
    }
    assert.ok((byEco.get("npm") ?? 0) >= 1);
    assert.ok((byEco.get("cargo") ?? 0) >= 1);
    assert.ok((byEco.get("go") ?? 0) >= 1);
    assert.ok(!out.skippedEcosystems.includes("npm"));
    assert.ok(!out.skippedEcosystems.includes("cargo"));
    assert.ok(!out.skippedEcosystems.includes("go"));
  });
});

describe("dependenciesPhase — phase wiring", () => {
  it("declares scan + profile as dependencies", () => {
    assert.equal(dependenciesPhase.name, DEPENDENCIES_PHASE_NAME);
    assert.ok(dependenciesPhase.deps.includes(SCAN_PHASE_NAME));
    assert.ok(dependenciesPhase.deps.includes(PROFILE_PHASE_NAME));
  });
});
