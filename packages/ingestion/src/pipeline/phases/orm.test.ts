import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { ORM_EXTERNAL_PATH, ormPhase } from "./orm.js";
import { PARSE_PHASE_NAME, parsePhase } from "./parse.js";
import { SCAN_PHASE_NAME, scanPhase } from "./scan.js";
import { STRUCTURE_PHASE_NAME, structurePhase } from "./structure.js";

async function buildCtxWithParse(repo: string): Promise<{ ctx: PipelineContext }> {
  const ctx: PipelineContext = {
    repoPath: repo,
    options: { skipGit: true },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
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
  return { ctx: liveCtx };
}

describe("ormPhase", () => {
  it("emits QUERIES edges with placeholder targets for Prisma calls", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-orm-prisma-"));
    try {
      await fs.writeFile(
        path.join(repo, "repo.ts"),
        [
          "import { prisma } from './client.js';",
          "export async function loadUsers() {",
          "  return prisma.User.findMany();",
          "}",
          "export async function createUser(name: string) {",
          "  return prisma.User.create({ data: { name } });",
          "}",
          "",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(repo, "client.ts"),
        ["export const prisma = { User: {} };", ""].join("\n"),
      );
      const { ctx } = await buildCtxWithParse(repo);
      const out = await ormPhase.run(
        ctx,
        new Map<string, unknown>([[PARSE_PHASE_NAME, ctx.phaseOutputs.get(PARSE_PHASE_NAME)]]),
      );
      assert.ok(out.queriesCount >= 2);
      assert.ok(out.placeholderCount >= 1);

      const queries = [...ctx.graph.edges()].filter((e) => e.type === "QUERIES");
      assert.ok(queries.length >= 2);
      // Reason string must carry orm + operation.
      const reasons = queries.map((e) => e.reason).filter(Boolean);
      assert.ok(reasons.some((r) => r === "prisma-findMany"));
      assert.ok(reasons.some((r) => r === "prisma-create"));

      // Placeholder node path must be <external>.
      const placeholders = [...ctx.graph.nodes()].filter(
        (n) => n.kind === "CodeElement" && n.filePath === ORM_EXTERNAL_PATH,
      );
      assert.ok(placeholders.length >= 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("prefers an existing model Class/Interface over a placeholder", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-orm-class-"));
    try {
      await fs.writeFile(
        path.join(repo, "models.ts"),
        ["export class User {}", "export class Post {}", ""].join("\n"),
      );
      await fs.writeFile(
        path.join(repo, "repo.ts"),
        [
          "import { prisma } from './client.js';",
          "import { User } from './models.js';",
          "export async function r() {",
          "  return prisma.User.findMany();",
          "}",
          "",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(repo, "client.ts"),
        ["export const prisma = { User: {} };", ""].join("\n"),
      );

      const { ctx } = await buildCtxWithParse(repo);
      const out = await ormPhase.run(
        ctx,
        new Map<string, unknown>([[PARSE_PHASE_NAME, ctx.phaseOutputs.get(PARSE_PHASE_NAME)]]),
      );
      assert.ok(out.queriesCount >= 1);
      assert.equal(out.placeholderCount, 0, "no placeholder needed when Class exists");

      const queries = [...ctx.graph.edges()].filter((e) => e.type === "QUERIES");
      assert.ok(queries.length >= 1);
      const target = queries[0]?.to as string;
      assert.ok(target.startsWith("Class:"), `expected edge to Class:..., got ${target}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("handles Supabase `.from().select()` patterns", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-orm-supabase-"));
    try {
      await fs.writeFile(
        path.join(repo, "q.ts"),
        [
          "import { supabase } from './client.js';",
          "export async function q() {",
          "  return supabase.from('users').select('*');",
          "}",
          "",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(repo, "client.ts"),
        [
          "export const supabase = { from: (_t: string) => ({ select: (_c: string) => null }) };",
          "",
        ].join("\n"),
      );
      const { ctx } = await buildCtxWithParse(repo);
      const out = await ormPhase.run(
        ctx,
        new Map<string, unknown>([[PARSE_PHASE_NAME, ctx.phaseOutputs.get(PARSE_PHASE_NAME)]]),
      );
      assert.ok(out.queriesCount >= 1);
      const queries = [...ctx.graph.edges()].filter((e) => e.type === "QUERIES");
      assert.ok(queries.some((e) => e.reason === "supabase-select"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
