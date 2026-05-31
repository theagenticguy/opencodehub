/**
 * Tests for `runPackCodebase` (the `pack_codebase` MCP tool handler).
 *
 * Strategy: inject `_runPackEngine` and `_runRepomixEngine` test seams
 * so the tests assert engine routing (default to "pack", explicit
 * "repomix", input-schema validation) without touching native bindings
 * or shelling out to `npx repomix`.
 */

// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { ConnectionPool } from "../connection-pool.js";
import {
  DEFAULT_PACK_BUDGET,
  DEFAULT_PACK_TOKENIZER,
  type PackCodebaseDeps,
  runPackCodebase,
} from "./pack-codebase.js";
import type { ToolContext } from "./shared.js";

interface Harness {
  readonly home: string;
  readonly repoPath: string;
  readonly ctx: ToolContext;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-pack-"));
  try {
    const repoPath = resolve(home, "fakerepo");
    await mkdir(repoPath, { recursive: true });
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    await writeFile(
      resolve(regDir, "registry.json"),
      JSON.stringify({
        fakerepo: {
          name: "fakerepo",
          path: repoPath,
          indexedAt: "2026-04-18T00:00:00Z",
          nodeCount: 0,
          edgeCount: 0,
          lastCommit: "abc123",
        },
      }),
    );
    // The connection pool is unused on the pack-codebase code paths
    // (engine handlers don't acquire stores via ctx.pool — pack uses
    // generatePack with an injected store, repomix shells `npx`). We
    // satisfy the type with a stub.
    const pool = {
      acquire: async () => {
        throw new Error("pool.acquire should not be called by pack_codebase");
      },
      release: async () => {},
      shutdown: async () => {},
      // biome-ignore lint/suspicious/noExplicitAny: stub doesn't implement the full ConnectionPool surface
    } as any as ConnectionPool;
    const ctx: ToolContext = { pool, home };
    await fn({ home, repoPath, ctx });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("DEFAULT_PACK_BUDGET is 100_000", () => {
  assert.equal(DEFAULT_PACK_BUDGET, 100_000);
});

test("DEFAULT_PACK_TOKENIZER matches the spec pin", () => {
  assert.equal(DEFAULT_PACK_TOKENIZER, "openai:o200k_base@tiktoken-0.8.0");
});

test("pack_codebase defaults to engine='pack' and dispatches to the pack engine", async () => {
  await withHarness(async ({ ctx, repoPath }) => {
    let packCalled = false;
    let repomixCalled = false;
    const deps: PackCodebaseDeps = {
      _runPackEngine: async ({ repo, budget, tokenizer }) => {
        packCalled = true;
        assert.equal(repo, repoPath);
        assert.equal(budget, DEFAULT_PACK_BUDGET);
        assert.equal(tokenizer, DEFAULT_PACK_TOKENIZER);
        return {
          outDir: resolve(repoPath, ".codehub", "packs", "deadbeef"),
          packHash: "deadbeef",
          bomItemCount: 8,
        };
      },
      _runRepomixEngine: async () => {
        repomixCalled = true;
        return { outputPath: "x", bytes: 0, durationMs: 0 };
      },
    };
    // Call with bare-minimum input — zod fills in defaults via .default().
    const result = await runPackCodebase(
      ctx,
      {
        repo: "fakerepo",
        engine: "pack",
        budget: DEFAULT_PACK_BUDGET,
        tokenizer: DEFAULT_PACK_TOKENIZER,
        style: "xml",
        compress: true,
        removeComments: false,
      },
      deps,
    );

    assert.equal(packCalled, true);
    assert.equal(repomixCalled, false);
    assert.equal(result.isError, undefined);
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc["engine"], "pack");
    assert.equal(sc["packHash"], "deadbeef");
    assert.equal(sc["bomItemCount"], 8);
    assert.match(result.text, /Packed fakerepo via @opencodehub\/pack/);
    assert.match(result.text, /bomItemCount: 8/);
  });
});

test("pack_codebase engine='repomix' runs the legacy repomix path", async () => {
  await withHarness(async ({ ctx, repoPath }) => {
    let packCalled = false;
    let repomixCalled = false;
    const deps: PackCodebaseDeps = {
      _runPackEngine: async () => {
        packCalled = true;
        return { outDir: "x", packHash: "x", bomItemCount: 0 };
      },
      _runRepomixEngine: async ({ repoPath: rp, style, compress, removeComments }) => {
        repomixCalled = true;
        assert.equal(rp, repoPath);
        assert.equal(style, "markdown");
        assert.equal(compress, false);
        assert.equal(removeComments, true);
        return {
          outputPath: resolve(repoPath, ".codehub", "pack", "repo.md"),
          bytes: 4242,
          durationMs: 11,
        };
      },
    };

    const result = await runPackCodebase(
      ctx,
      {
        repo: "fakerepo",
        engine: "repomix",
        budget: DEFAULT_PACK_BUDGET,
        tokenizer: DEFAULT_PACK_TOKENIZER,
        style: "markdown",
        compress: false,
        removeComments: true,
      },
      deps,
    );

    assert.equal(packCalled, false);
    assert.equal(repomixCalled, true);
    assert.equal(result.isError, undefined);
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc["engine"], "repomix");
    assert.equal(sc["bytes"], 4242);
    assert.equal(sc["style"], "markdown");
    // _meta.engine carries the legacy marker so callers can detect.
    const meta = sc["_meta"] as Record<string, unknown> | undefined;
    assert.equal(meta?.["engine"], "repomix");
    assert.match(result.text, /Packed fakerepo via repomix/);
    // next_steps mention the M7 deprecation.
    const nextSteps = sc["next_steps"] as string[];
    assert.ok(
      nextSteps.some((s) => /repomix engine is opt-in/.test(s)),
      "next_steps should flag repomix as opt-in",
    );
  });
});

test("pack_codebase honors budget+tokenizer overrides on the pack engine", async () => {
  await withHarness(async ({ ctx, repoPath }) => {
    let captured: { budget?: number; tokenizer?: string } = {};
    const deps: PackCodebaseDeps = {
      _runPackEngine: async ({ budget, tokenizer }) => {
        captured = { budget, tokenizer };
        return {
          outDir: resolve(repoPath, ".codehub", "packs", "x"),
          packHash: "x",
          bomItemCount: 8,
        };
      },
    };

    await runPackCodebase(
      ctx,
      {
        repo: "fakerepo",
        engine: "pack",
        budget: 25_000,
        tokenizer: "anthropic:claude-3-7@1.0.0",
        style: "xml",
        compress: true,
        removeComments: false,
      },
      deps,
    );

    assert.equal(captured.budget, 25_000);
    assert.equal(captured.tokenizer, "anthropic:claude-3-7@1.0.0");
  });
});

test("pack_codebase returns a NOT_FOUND envelope when the repo is not registered", async () => {
  await withHarness(async ({ ctx }) => {
    const deps: PackCodebaseDeps = {
      _runPackEngine: async () => ({ outDir: "x", packHash: "x", bomItemCount: 0 }),
    };
    const result = await runPackCodebase(
      ctx,
      {
        repo: "does-not-exist",
        engine: "pack",
        budget: DEFAULT_PACK_BUDGET,
        tokenizer: DEFAULT_PACK_TOKENIZER,
        style: "xml",
        compress: true,
        removeComments: false,
      },
      deps,
    );
    assert.equal(result.isError, true);
    const err = (result.structuredContent as { error: Record<string, unknown> }).error;
    // The resolver's structured code must survive — not be flattened to INTERNAL.
    assert.equal(err["code"], "NOT_FOUND");
  });
});

test("pack_codebase surfaces the AMBIGUOUS_REPO envelope when ≥ 2 repos are registered", async () => {
  // Two registered repos with neither `repo` nor `repo_uri` supplied: the
  // resolver throws RepoResolveError(AMBIGUOUS_REPO). pack_codebase must emit
  // the structured envelope (error_code + choices + total_matches) rather than
  // flattening it to INTERNAL through the catch-all.
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-pack-ambig-"));
  try {
    const repoA = resolve(home, "repoA");
    const repoB = resolve(home, "repoB");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    await writeFile(
      resolve(regDir, "registry.json"),
      JSON.stringify({
        "github.com/org/repoA": {
          name: "github.com/org/repoA",
          path: repoA,
          indexedAt: "2026-04-18T00:00:00Z",
          nodeCount: 0,
          edgeCount: 0,
        },
        "github.com/org/repoB": {
          name: "github.com/org/repoB",
          path: repoB,
          indexedAt: "2026-04-18T00:00:00Z",
          nodeCount: 0,
          edgeCount: 0,
        },
      }),
    );
    const pool = {
      acquire: async () => {
        throw new Error("pool.acquire should not be called by pack_codebase");
      },
      release: async () => {},
      shutdown: async () => {},
      // biome-ignore lint/suspicious/noExplicitAny: stub doesn't implement the full ConnectionPool surface
    } as any as ConnectionPool;
    const ctx: ToolContext = { pool, home };
    const deps: PackCodebaseDeps = {
      _runPackEngine: async () => {
        throw new Error("pack engine should not run when repo is ambiguous");
      },
    };
    const result = await runPackCodebase(
      ctx,
      {
        // No repo / repo_uri — trigger the ambiguous path.
        engine: "pack",
        budget: DEFAULT_PACK_BUDGET,
        tokenizer: DEFAULT_PACK_TOKENIZER,
        style: "xml",
        compress: true,
        removeComments: false,
      },
      deps,
    );
    assert.equal(result.isError, true);
    const err = (result.structuredContent as { error: Record<string, unknown> }).error;
    assert.equal(err["code"], "AMBIGUOUS_REPO");
    assert.equal(err["error_code"], "AMBIGUOUS_REPO");
    assert.equal(err["jsonrpc_code"], -32602);
    assert.equal(err["total_matches"], 2);
    const choices = err["choices"] as Array<{ repo_uri: string }>;
    assert.equal(choices.length, 2);
    assert.deepEqual(choices.map((c) => c.repo_uri).sort(), [
      "github.com/org/repoA",
      "github.com/org/repoB",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
