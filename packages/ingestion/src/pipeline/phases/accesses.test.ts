import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { graphHash, KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { ACCESSES_PHASE_NAME, accessesPhase } from "./accesses.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import { PARSE_PHASE_NAME, parsePhase } from "./parse.js";
import { SCAN_PHASE_NAME, scanPhase } from "./scan.js";
import { STRUCTURE_PHASE_NAME, structurePhase } from "./structure.js";

async function buildCtxAfterParse(repo: string): Promise<PipelineContext> {
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
  return {
    ...ctx,
    phaseOutputs: new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [STRUCTURE_PHASE_NAME, structure],
      [PARSE_PHASE_NAME, parse],
      // crossFile has not run — the phase only requires parse output for
      // its actual work, so we substitute an empty sentinel.
      [CROSS_FILE_PHASE_NAME, { upgradedCallsCount: 0 }],
    ]),
  };
}

async function runAccesses(
  ctx: PipelineContext,
): Promise<Awaited<ReturnType<typeof accessesPhase.run>>> {
  return accessesPhase.run(
    ctx,
    new Map<string, unknown>([
      [PARSE_PHASE_NAME, ctx.phaseOutputs.get(PARSE_PHASE_NAME)],
      [CROSS_FILE_PHASE_NAME, ctx.phaseOutputs.get(CROSS_FILE_PHASE_NAME)],
    ]),
  );
}

describe(`${ACCESSES_PHASE_NAME}Phase — TypeScript`, () => {
  it("emits one read + one write for `u.name` / `u.email = 'x'`", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-accesses-ts-"));
    try {
      await fs.writeFile(
        path.join(repo, "m.ts"),
        [
          "export function f(u: { name: string; email: string }): string {",
          '  u.email = "x";',
          "  return u.name;",
          "}",
          "",
        ].join("\n"),
      );
      const ctx = await buildCtxAfterParse(repo);
      const out = await runAccesses(ctx);
      assert.equal(out.edgeCount, 2);
      const accesses = [...ctx.graph.edges()].filter((e) => e.type === "ACCESSES");
      assert.equal(accesses.length, 2);
      const byReason = new Map<string, string[]>();
      for (const e of accesses) {
        const nodes = [...ctx.graph.nodes()];
        const target = nodes.find((n) => n.id === e.to);
        assert.ok(target, "ACCESSES edge target must be a graph node");
        const bucket = byReason.get(e.reason ?? "") ?? [];
        bucket.push(target.name);
        byReason.set(e.reason ?? "", bucket);
      }
      assert.deepEqual(byReason.get("read"), ["name"]);
      assert.deepEqual(byReason.get("write"), ["email"]);
      // Confidence on all ACCESSES edges is 0.8.
      for (const e of accesses) assert.equal(e.confidence, 0.8);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("re-running on the same input is byte-identical (graphHash stable)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-accesses-ts-det-"));
    try {
      await fs.writeFile(
        path.join(repo, "m.ts"),
        [
          "export function g(u: { a: string; b: string; c: string }): string {",
          '  u.a = "1";',
          "  return u.b + u.c;",
          "}",
          "",
        ].join("\n"),
      );
      const first = await buildCtxAfterParse(repo);
      await runAccesses(first);
      const firstHash = graphHash(first.graph);

      const second = await buildCtxAfterParse(repo);
      await runAccesses(second);
      const secondHash = graphHash(second.graph);

      assert.equal(firstHash, secondHash);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("caps per-file accesses at 50_000 and warns", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-accesses-cap-"));
    try {
      // Build a huge function body whose every line is `u.xN = 1;` so the
      // walker yields well over 50k write-accesses.
      const lines: string[] = ["export function huge(u: Record<string, number>): number {"];
      const TOTAL = 60_000;
      for (let i = 0; i < TOTAL; i += 1) {
        lines.push(`  u.x${i} = ${i};`);
      }
      lines.push("  return 0;", "}", "");
      await fs.writeFile(path.join(repo, "huge.ts"), lines.join("\n"));

      const ctx = await buildCtxAfterParse(repo);
      const warnings: string[] = [];
      const ctxWithSink: PipelineContext = {
        ...ctx,
        onProgress: (ev) => {
          if (ev.kind === "warn" && ev.message !== undefined) warnings.push(ev.message);
        },
      };
      const out = await accessesPhase.run(
        ctxWithSink,
        new Map<string, unknown>([
          [PARSE_PHASE_NAME, ctx.phaseOutputs.get(PARSE_PHASE_NAME)],
          [CROSS_FILE_PHASE_NAME, ctx.phaseOutputs.get(CROSS_FILE_PHASE_NAME)],
        ]),
      );
      assert.equal(out.edgeCount, 50_000);
      assert.deepEqual(out.truncatedFiles, ["huge.ts"]);
      assert.ok(warnings.some((w) => w.includes("50000")));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("silent no-op for languages without extractPropertyAccesses", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-accesses-none-"));
    try {
      await fs.writeFile(
        path.join(repo, "m.go"),
        ["package main", "", "func main() { _ = 1 }", ""].join("\n"),
      );
      const ctx = await buildCtxAfterParse(repo);
      const out = await runAccesses(ctx);
      assert.equal(out.edgeCount, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe(`${ACCESSES_PHASE_NAME}Phase — Python`, () => {
  it("emits one read + one write in `def f(u): u.email = 'x'; u.name`", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-accesses-py-"));
    try {
      await fs.writeFile(
        path.join(repo, "m.py"),
        ["def f(u):", "    u.email = 'x'", "    return u.name", ""].join("\n"),
      );
      const ctx = await buildCtxAfterParse(repo);
      const out = await runAccesses(ctx);
      assert.equal(out.edgeCount, 2);
      const edges = [...ctx.graph.edges()].filter((e) => e.type === "ACCESSES");
      const names = edges
        .map((e) => {
          const target = [...ctx.graph.nodes()].find((n) => n.id === e.to);
          return `${e.reason}:${target?.name ?? "?"}`;
        })
        .sort();
      assert.deepEqual(names, ["read:name", "write:email"]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
