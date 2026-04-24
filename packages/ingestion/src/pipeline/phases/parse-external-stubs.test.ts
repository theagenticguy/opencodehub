/**
 * Parse phase — external-specifier stubs (DET-E-003).
 *
 * Previously, unresolved external imports (`import { foo } from "some-lib"`)
 * were silently dropped by the parse phase. P06 emits one
 * `CodeElement:<external>:<pkg>:<symbol>` stub per (specifier, imported-name)
 * pair and an IMPORTS edge from the importer file to the stub. Downstream
 * phases (impact, wiki, cross-repo contracts) can then reason about the
 * boundary crossing.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { parsePhase } from "./parse.js";
import { SCAN_PHASE_NAME, scanPhase } from "./scan.js";
import { STRUCTURE_PHASE_NAME, structurePhase } from "./structure.js";

async function runParseOn(repo: string): Promise<PipelineContext> {
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
  await parsePhase.run(
    ctx,
    new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [STRUCTURE_PHASE_NAME, structure],
    ]),
  );
  return ctx;
}

describe("parsePhase external-specifier stubs", () => {
  it("emits CodeElement:<external>:<pkg>:<symbol> stubs for unresolved imports", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-extstub-"));
    try {
      await fs.writeFile(
        path.join(repo, "app.ts"),
        [
          "import { PrismaClient } from '@prisma/client';",
          "import express from 'express';",
          "const prisma = new PrismaClient();",
          "const app = express();",
          "",
        ].join("\n"),
      );
      const ctx = await runParseOn(repo);

      const externalStubs = [...ctx.graph.nodes()].filter(
        (n) => n.kind === "CodeElement" && n.filePath === "<external>",
      );
      // Two imports → at least one stub per import (named import becomes one
      // per symbol; default import becomes one for the localAlias).
      const stubIds = externalStubs.map((n) => n.id);
      assert.ok(
        stubIds.some((id) => id.includes(":@prisma/client:PrismaClient")),
        `expected a Prisma stub; got ${stubIds.join(", ")}`,
      );
      assert.ok(
        stubIds.some((id) => id.includes(":express:express")),
        `expected an express stub; got ${stubIds.join(", ")}`,
      );

      // Each stub must have an IMPORTS edge from the importer file.
      const imports = [...ctx.graph.edges()].filter((e) => e.type === "IMPORTS");
      const externalEdges = imports.filter((e) =>
        (e.to as string).includes(":<external>:"),
      );
      assert.ok(externalEdges.length >= 2, "expected IMPORTS edges to stubs");
      for (const e of externalEdges) {
        assert.equal(e.reason, "file-imports-external");
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("skips purely-relative specifiers that fail to resolve", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-extstub-rel-"));
    try {
      await fs.writeFile(
        path.join(repo, "app.ts"),
        // Relative import to a file that doesn't exist — we expect NO
        // external stub (relative specifiers aren't external packages).
        "import { foo } from './missing.js';\nconst x = foo();\n",
      );
      const ctx = await runParseOn(repo);

      const externalStubs = [...ctx.graph.nodes()].filter(
        (n) => n.kind === "CodeElement" && n.filePath === "<external>",
      );
      assert.equal(externalStubs.length, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("dedupes stubs when the same external specifier is imported from multiple files", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-extstub-dedup-"));
    try {
      await fs.writeFile(
        path.join(repo, "a.ts"),
        "import { PrismaClient } from '@prisma/client';\n",
      );
      await fs.writeFile(
        path.join(repo, "b.ts"),
        "import { PrismaClient } from '@prisma/client';\n",
      );
      const ctx = await runParseOn(repo);

      const prismaStubs = [...ctx.graph.nodes()].filter(
        (n) =>
          n.kind === "CodeElement" &&
          n.id.includes(":@prisma/client:PrismaClient"),
      );
      assert.equal(prismaStubs.length, 1, "stub node must be deduped across files");

      // Two IMPORTS edges — one from each file.
      const imports = [...ctx.graph.edges()].filter(
        (e) => e.type === "IMPORTS" && (e.to as string).includes(":@prisma/client:"),
      );
      assert.equal(imports.length, 2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
