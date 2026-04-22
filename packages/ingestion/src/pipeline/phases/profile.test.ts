import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ProjectProfileNode } from "@opencodehub/core-types";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { profilePhase } from "./profile.js";
import { SCAN_PHASE_NAME, scanPhase } from "./scan.js";

async function buildCtx(repoPath: string): Promise<PipelineContext> {
  const ctx: PipelineContext = {
    repoPath,
    options: { skipGit: true },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
  };
  const scan = await scanPhase.run(ctx, new Map());
  return {
    ...ctx,
    phaseOutputs: new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
  };
}

function findProfile(ctx: PipelineContext): ProjectProfileNode | undefined {
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "ProjectProfile") return n as ProjectProfileNode;
  }
  return undefined;
}

describe("profilePhase — polyglot TS + Python + Terraform + OpenAPI + Next.js + Django", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-profile-"));

    // Top-level manifests
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify(
        {
          name: "polyglot",
          version: "0.0.0",
          dependencies: { next: "14.0.0", express: "4.18.0" },
          devDependencies: { typescript: "5.4.0" },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(repo, "next.config.js"),
      "module.exports = { reactStrictMode: true };\n",
    );
    await fs.writeFile(
      path.join(repo, "pyproject.toml"),
      [
        "[project]",
        'name = "polyglot-svc"',
        'version = "0.0.1"',
        "dependencies = [",
        '  "django>=4.0",',
        '  "fastapi>=0.100",',
        "]",
      ].join("\n") + "\n",
    );
    // requirements.txt should be shadowed by pyproject in the cascade
    await fs.writeFile(path.join(repo, "requirements.txt"), "flask==2.2.0\n");
    await fs.writeFile(path.join(repo, "manage.py"), "# django manage\n");

    // Terraform
    await fs.mkdir(path.join(repo, "infra"), { recursive: true });
    await fs.writeFile(path.join(repo, "infra", "main.tf"), 'resource "aws_s3_bucket" "b" {}\n');

    // OpenAPI
    await fs.mkdir(path.join(repo, "api"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "api", "openapi.yaml"),
      ["openapi: 3.0.3", "info:", "  title: Sample", "  version: 1.0.0", "paths: {}"].join("\n") +
        "\n",
    );

    // Docker
    await fs.writeFile(path.join(repo, "Dockerfile"), 'FROM node:20\nCMD ["node"]\n');

    // Kubernetes (content-sniffed)
    await fs.mkdir(path.join(repo, "deploy"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "deploy", "pod.yaml"),
      ["apiVersion: v1", "kind: Pod", "metadata:", "  name: demo"].join("\n") + "\n",
    );

    // Source code directories. Python side:
    await fs.mkdir(path.join(repo, "backend", "src"), { recursive: true });
    for (let i = 0; i < 12; i++) {
      await fs.writeFile(
        path.join(repo, "backend", "src", `mod_${i}.py`),
        `def fn_${i}(): return ${i}\n`,
      );
    }
    // TypeScript side:
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    for (let i = 0; i < 12; i++) {
      await fs.writeFile(path.join(repo, "src", `m${i}.ts`), `export const v${i} = ${i};\n`);
    }
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits exactly one ProjectProfile node", async () => {
    const ctx = await buildCtx(repo);
    const out = await profilePhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.profileEmitted, true);

    const profiles = [...ctx.graph.nodes()].filter((n) => n.kind === "ProjectProfile");
    assert.equal(profiles.length, 1);
    const p = profiles[0] as ProjectProfileNode;
    assert.equal(p.name, "project-profile");
    assert.equal(p.filePath, "");
  });

  it("detects languages (TS + Python) sorted by count desc, then alphabetical", async () => {
    const ctx = await buildCtx(repo);
    await profilePhase.run(ctx, ctx.phaseOutputs);
    const p = findProfile(ctx);
    assert.ok(p);
    assert.ok(p.languages.includes("typescript"));
    assert.ok(p.languages.includes("python"));
  });

  it("detects frameworks: nextjs, express, django, fastapi", async () => {
    const ctx = await buildCtx(repo);
    await profilePhase.run(ctx, ctx.phaseOutputs);
    const p = findProfile(ctx);
    assert.ok(p);
    // Output is sorted alphabetically
    assert.deepEqual(
      p.frameworks.filter((f) => ["django", "express", "fastapi", "nextjs"].includes(f)).sort(),
      ["django", "express", "fastapi", "nextjs"],
    );
  });

  it("detects IaC: terraform + docker + kubernetes", async () => {
    const ctx = await buildCtx(repo);
    await profilePhase.run(ctx, ctx.phaseOutputs);
    const p = findProfile(ctx);
    assert.ok(p);
    assert.ok(p.iacTypes.includes("terraform"));
    assert.ok(p.iacTypes.includes("docker"));
    assert.ok(p.iacTypes.includes("kubernetes"));
    // sorted
    const sorted = [...p.iacTypes].sort();
    assert.deepEqual(p.iacTypes, sorted);
  });

  it("detects openapi contract", async () => {
    const ctx = await buildCtx(repo);
    await profilePhase.run(ctx, ctx.phaseOutputs);
    const p = findProfile(ctx);
    assert.ok(p);
    assert.deepEqual(p.apiContracts, ["openapi"]);
  });

  it("cascades manifests: pyproject.toml wins over requirements.txt", async () => {
    const ctx = await buildCtx(repo);
    await profilePhase.run(ctx, ctx.phaseOutputs);
    const p = findProfile(ctx);
    assert.ok(p);
    assert.ok(p.manifests.includes("pyproject.toml"));
    assert.ok(!p.manifests.includes("requirements.txt"));
    assert.ok(p.manifests.includes("package.json"));
    // sorted
    const sorted = [...p.manifests].sort();
    assert.deepEqual(p.manifests, sorted);
  });

  it("detects src dirs and excludes node_modules / build", async () => {
    const ctx = await buildCtx(repo);
    await profilePhase.run(ctx, ctx.phaseOutputs);
    const p = findProfile(ctx);
    assert.ok(p);
    assert.ok(p.srcDirs.includes("backend/src"));
    assert.ok(p.srcDirs.includes("src"));
    assert.ok(!p.srcDirs.some((d) => d.startsWith("node_modules")));
  });

  it("is deterministic (two runs produce byte-identical profiles)", async () => {
    const ctx1 = await buildCtx(repo);
    await profilePhase.run(ctx1, ctx1.phaseOutputs);
    const ctx2 = await buildCtx(repo);
    await profilePhase.run(ctx2, ctx2.phaseOutputs);
    const p1 = findProfile(ctx1);
    const p2 = findProfile(ctx2);
    assert.ok(p1 && p2);
    assert.equal(p1.id, p2.id);
    assert.equal(JSON.stringify(p1), JSON.stringify(p2));
  });
});

describe("profilePhase — empty repo (only .git)", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-profile-empty-"));
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    await fs.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("does not crash and emits an empty-but-valid profile node", async () => {
    const ctx = await buildCtx(repo);
    const out = await profilePhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.profileEmitted, true);
    assert.equal(out.languagesDetected, 0);
    assert.equal(out.frameworksDetected, 0);

    const p = findProfile(ctx);
    assert.ok(p);
    assert.deepEqual([...p.languages], []);
    assert.deepEqual([...p.frameworks], []);
    assert.deepEqual([...p.iacTypes], []);
    assert.deepEqual([...p.apiContracts], []);
    assert.deepEqual([...p.manifests], []);
    assert.deepEqual([...p.srcDirs], []);
  });
});
