import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { PARSE_PHASE_NAME, parsePhase } from "./parse.js";
import { routesPhase } from "./routes.js";
import { SCAN_PHASE_NAME, scanPhase } from "./scan.js";
import { STRUCTURE_PHASE_NAME, structurePhase } from "./structure.js";

async function runScanStructureParse(repo: string): Promise<{
  ctx: PipelineContext;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const onProgress = (ev: ProgressEvent): void => {
    if (ev.kind === "warn" && ev.message) warnings.push(ev.message);
  };
  const ctx: PipelineContext = {
    repoPath: repo,
    options: { skipGit: true },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
    onProgress,
  };
  const scan = await scanPhase.run(ctx, new Map());
  const structure = await structurePhase.run(
    ctx,
    new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
  );
  const parse = await parsePhase.run(
    ctx,
    new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [STRUCTURE_PHASE_NAME, structure],
    ]),
  );
  const liveOutputs = new Map<string, unknown>([
    [SCAN_PHASE_NAME, scan],
    [STRUCTURE_PHASE_NAME, structure],
    [PARSE_PHASE_NAME, parse],
  ]);
  const liveCtx: PipelineContext = { ...ctx, phaseOutputs: liveOutputs };
  return { ctx: liveCtx, warnings };
}

describe("routesPhase", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-routes-"));
    // Next.js App Router: app/api/users/route.ts with GET + POST
    await fs.mkdir(path.join(repo, "app", "api", "users"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "app", "api", "users", "route.ts"),
      [
        "export async function GET(): Promise<Response> { return new Response(); }",
        "export async function POST(): Promise<Response> { return new Response(); }",
        "",
      ].join("\n"),
    );
    // Express router file.
    await fs.writeFile(
      path.join(repo, "server.ts"),
      [
        "import express from 'express';",
        "const app = express();",
        "app.get('/health', (_req, res) => res.json({ ok: true }));",
        "app.post('/users', (_req, res) => res.json({ id: 1 }));",
        "",
      ].join("\n"),
    );
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits Route nodes and HANDLES_ROUTE edges for Next.js and Express", async () => {
    const { ctx } = await runScanStructureParse(repo);
    const out = await routesPhase.run(
      ctx,
      new Map<string, unknown>([[PARSE_PHASE_NAME, ctx.phaseOutputs.get(PARSE_PHASE_NAME)]]),
    );

    assert.ok(out.routeCount >= 4, `expected 4+ routes, got ${out.routeCount}`);

    const nodes = [...ctx.graph.nodes()];
    const routes = nodes.filter((n) => n.kind === "Route");
    const urls = routes.map((r) => (r as { url: string }).url).sort();
    assert.ok(urls.includes("/api/users"));
    assert.ok(urls.includes("/health"));
    assert.ok(urls.includes("/users"));

    const edges = [...ctx.graph.edges()];
    const handles = edges.filter((e) => e.type === "HANDLES_ROUTE");
    assert.ok(handles.length >= 4);
    for (const e of handles) {
      assert.equal(e.confidence, 0.9, "HANDLES_ROUTE confidence should be 0.9");
    }
  });

  it("warns and counts duplicate URL+method registrations", async () => {
    const dup = await mkdtemp(path.join(tmpdir(), "och-routes-dup-"));
    try {
      await fs.writeFile(
        path.join(dup, "a.ts"),
        [
          "const app = require('express')();",
          "app.get('/dupe', (_req, res) => res.json({}));",
          "",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(dup, "b.ts"),
        [
          "const router = require('express').Router();",
          "router.get('/dupe', (_req, res) => res.json({}));",
          "",
        ].join("\n"),
      );

      const warnings: string[] = [];
      const ctx: PipelineContext = {
        repoPath: dup,
        options: { skipGit: true },
        graph: new KnowledgeGraph(),
        phaseOutputs: new Map(),
        onProgress: (ev) => {
          if (ev.kind === "warn" && ev.message) warnings.push(ev.message);
        },
      };
      const scan = await scanPhase.run(ctx, new Map());
      const structure = await structurePhase.run(
        ctx,
        new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
      );
      const parse = await parsePhase.run(
        ctx,
        new Map<string, unknown>([
          [SCAN_PHASE_NAME, scan],
          [STRUCTURE_PHASE_NAME, structure],
        ]),
      );
      const liveCtx: PipelineContext = {
        ...ctx,
        phaseOutputs: new Map<string, unknown>([
          [SCAN_PHASE_NAME, scan],
          [STRUCTURE_PHASE_NAME, structure],
          [PARSE_PHASE_NAME, parse],
        ]),
      };
      const out = await routesPhase.run(
        liveCtx,
        new Map<string, unknown>([[PARSE_PHASE_NAME, parse]]),
      );
      assert.ok(out.duplicateCount >= 1);
      assert.ok(warnings.some((w) => w.includes("duplicate registration")));
    } finally {
      await rm(dup, { recursive: true, force: true });
    }
  });
});
