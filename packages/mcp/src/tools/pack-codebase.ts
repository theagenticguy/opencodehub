/**
 * `pack_codebase` — produce a snapshot of a registered repo for an LLM
 * to consume.
 *
 * Two engines are supported via the `engine` input field:
 *   - `pack` (DEFAULT) — `@opencodehub/pack`'s deterministic 9-item BOM
 *     written to `<repo>/.codehub/packs/<packHash>/`. The BOM is what
 *     downstream agents should consume — it carries skeleton + file-tree
 *     + deps + ast-chunks + xrefs + findings + licenses + readme +
 *     optional embeddings.parquet, all bound by a manifest with a
 *     content-addressed `pack_hash`.
 *   - `repomix` — the legacy single-file XML/Markdown snapshot under
 *     `<repo>/.codehub/pack/repo.<ext>`. Retained as an opt-in for one
 *     milestone (drop deferred to M7 per spec 005 Q-DELTA-6). Operators
 *     who relied on repomix for raw repo packing keep a stable path.
 *
 * For relational/structural questions about the repo, prefer
 * `query`/`context`/`impact` — those are backed by the SCIP graph and
 * give graph-aware answers without consuming context window.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generatePack as defaultGeneratePack } from "@opencodehub/pack";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { resolveRepo } from "../repo-resolver.js";
import { fromToolResult, type ToolContext, type ToolResult, toToolResult } from "./shared.js";

const DEFAULT_REPOMIX_VERSION = "1.14.0";

/** Default token budget passed to the pack engine when `budget` is omitted. */
export const DEFAULT_PACK_BUDGET = 100_000;

/** Default tokenizer identifier when `tokenizer` is omitted. */
export const DEFAULT_PACK_TOKENIZER = "openai:o200k_base@tiktoken-0.8.0";

const PackInput = z.object({
  repo: z
    .string()
    .optional()
    .describe(
      "Registered repo name (see list_repos). Provide `repo` or `repo_uri`; required when ≥ 2 repos are registered.",
    ),
  repo_uri: z
    .string()
    .optional()
    .describe(
      "Sourcegraph-style repo URI (e.g. `github.com/org/repo`). Accepted as an alias for `repo`; wins when both are provided.",
    ),
  engine: z
    .enum(["pack", "repomix"])
    .optional()
    .default("pack")
    .describe(
      "Engine: `pack` (default) writes the 9-item BOM via @opencodehub/pack. " +
        "`repomix` is the legacy single-file snapshot, retained as an opt-in.",
    ),
  budget: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_PACK_BUDGET)
    .describe("Token budget for the AST chunker. Pack engine only. Default 100000."),
  tokenizer: z
    .string()
    .optional()
    .default(DEFAULT_PACK_TOKENIZER)
    .describe(
      'Tokenizer pin "<vendor>:<name>@<pin>". Pack engine only. Default openai:o200k_base@tiktoken-0.8.0.',
    ),
  // Legacy repomix-only fields. Honored when engine === "repomix"; ignored
  // for the pack engine.
  style: z
    .enum(["xml", "markdown", "json", "plain"])
    .optional()
    .default("xml")
    .describe("Repomix output style. Repomix engine only."),
  compress: z
    .boolean()
    .optional()
    .default(true)
    .describe("Repomix tree-sitter signature compression. Repomix engine only."),
  removeComments: z
    .boolean()
    .optional()
    .default(false)
    .describe("Repomix --remove-comments. Repomix engine only."),
});
type PackInput = z.infer<typeof PackInput>;

/**
 * Test seam — overrides for the engine implementations. Production
 * callers leave these unset; tests inject `runCodePack` / `runRepomix`
 * stubs to avoid native bindings + npx network calls.
 */
export interface PackCodebaseDeps {
  readonly _runPackEngine?: (args: { repo: string; budget: number; tokenizer: string }) => Promise<{
    outDir: string;
    packHash: string;
    bomItemCount: number;
  }>;
  readonly _runRepomixEngine?: (args: {
    repoPath: string;
    style: "xml" | "markdown" | "json" | "plain";
    compress: boolean;
    removeComments: boolean;
  }) => Promise<{ outputPath: string; bytes: number; durationMs: number }>;
}

export async function runPackCodebase(
  ctx: ToolContext,
  input: PackInput,
  deps: PackCodebaseDeps = {},
): Promise<ToolResult> {
  try {
    const entry = await resolveRepo(
      {
        ...(input.repo !== undefined ? { repo: input.repo } : {}),
        ...(input.repo_uri !== undefined ? { repo_uri: input.repo_uri } : {}),
      },
      {
        ...(ctx.home !== undefined ? { home: ctx.home } : {}),
        skipMeta: true,
      },
    );

    if (input.engine === "repomix") {
      return await runRepomixPath(entry, input, deps);
    }
    return await runPackPath(entry, input, deps);
  } catch (err) {
    return toToolResult(toolErrorFromUnknown(err));
  }
}

async function runPackPath(
  entry: { repoPath: string; name: string },
  input: PackInput,
  deps: PackCodebaseDeps,
): Promise<ToolResult> {
  const start = Date.now();
  const result =
    deps._runPackEngine !== undefined
      ? await deps._runPackEngine({
          repo: entry.repoPath,
          budget: input.budget,
          tokenizer: input.tokenizer,
        })
      : await callRealPackEngine({
          repo: entry.repoPath,
          budget: input.budget,
          tokenizer: input.tokenizer,
        });
  const durationMs = Date.now() - start;

  const body = [
    `Packed ${entry.name} via @opencodehub/pack to ${result.outDir}`,
    `  bomItemCount: ${result.bomItemCount}`,
    `  packHash:     ${result.packHash}`,
    `  budget:       ${input.budget}`,
    `  tokenizer:    ${input.tokenizer}`,
    `  duration:     ${durationMs}ms`,
  ].join("\n");

  return toToolResult(
    withNextSteps(
      body,
      {
        engine: "pack",
        outDir: result.outDir,
        packHash: result.packHash,
        bomItemCount: result.bomItemCount,
        budget: input.budget,
        tokenizer: input.tokenizer,
        durationMs,
      },
      [
        "load .codehub/packs/<hash>/manifest.json to inspect the BOM, then read the per-BOM-item files (skeleton, file-tree, ast-chunks, xrefs, findings, licenses).",
        "structural questions go to `query`/`context`/`impact` — those answer without consuming context window.",
      ],
    ),
  );
}

async function runRepomixPath(
  entry: { repoPath: string; name: string },
  input: PackInput,
  deps: PackCodebaseDeps,
): Promise<ToolResult> {
  const result =
    deps._runRepomixEngine !== undefined
      ? await deps._runRepomixEngine({
          repoPath: entry.repoPath,
          style: input.style,
          compress: input.compress,
          removeComments: input.removeComments,
        })
      : await callRealRepomixEngine({
          repoPath: entry.repoPath,
          style: input.style,
          compress: input.compress,
          removeComments: input.removeComments,
        });

  const body = [
    `Packed ${entry.name} via repomix to ${result.outputPath}`,
    `  bytes:    ${result.bytes}`,
    `  style:    ${input.style}`,
    `  compress: ${input.compress}`,
    `  duration: ${result.durationMs}ms`,
  ].join("\n");

  // Mark the engine in `_meta.engine` so callers can detect the legacy path
  // and migrate; `next_steps` flags the M7 deprecation explicitly.
  return toToolResult(
    withNextSteps(
      body,
      {
        engine: "repomix",
        outputPath: result.outputPath,
        bytes: result.bytes,
        style: input.style,
        durationMs: result.durationMs,
        _meta: { engine: "repomix" },
      },
      [
        "repomix engine is opt-in and slated for removal in M7 — prefer engine='pack' (default) for new callers.",
        "load the output file into your context; structural questions go to `query`/`context`/`impact`.",
      ],
    ),
  );
}

/**
 * Real-world implementation of the pack engine. Imports the CLI's
 * `runCodePack` lazily so MCP servers without `@opencodehub/cli`
 * installed (e.g. embed-only deployments) still type-check; the import
 * happens only on engine=pack invocations.
 */
async function callRealPackEngine(args: {
  repo: string;
  budget: number;
  tokenizer: string;
}): Promise<{ outDir: string; packHash: string; bomItemCount: number }> {
  // Inline the same wiring as `runCodePack` rather than importing
  // `@opencodehub/cli` (which would create a cycle, MCP <- CLI <- MCP).
  // Open the DuckStore directly, call generatePack, rename into place.
  const { mkdtemp, rename, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { openStore, resolveDbPath } = await import("@opencodehub/storage");
  const dbPath = resolveDbPath(args.repo);
  if (!existsSync(dbPath)) {
    throw new Error(
      `pack_codebase: no graph index at ${dbPath}. ` +
        "Run `codehub analyze` first to populate the store.",
    );
  }
  const store = await openStore({ path: dbPath, backend: "duck", readOnly: true });
  const stagingDir = await mkdtemp(join(tmpdir(), "codehub-pack-mcp-"));
  try {
    const manifest = await defaultGeneratePack(
      {
        repoPath: args.repo,
        outDir: stagingDir,
        budgetTokens: args.budget,
        tokenizerId: args.tokenizer,
      },
      { store },
    );
    const finalOutDir = resolve(args.repo, ".codehub", "packs", manifest.packHash);
    await mkdir(dirname(finalOutDir), { recursive: true });
    if (existsSync(finalOutDir)) {
      await rm(finalOutDir, { recursive: true, force: true });
    }
    await rename(stagingDir, finalOutDir);
    return {
      outDir: finalOutDir,
      packHash: manifest.packHash,
      bomItemCount: manifest.files.length + 1,
    };
  } finally {
    await store.close();
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/** Real-world repomix shell-out. */
async function callRealRepomixEngine(args: {
  repoPath: string;
  style: "xml" | "markdown" | "json" | "plain";
  compress: boolean;
  removeComments: boolean;
}): Promise<{ outputPath: string; bytes: number; durationMs: number }> {
  const outputPath = join(args.repoPath, ".codehub", "pack", `repo.${extForStyle(args.style)}`);
  await mkdir(dirname(outputPath), { recursive: true });

  const cmdArgs = [
    `repomix@${DEFAULT_REPOMIX_VERSION}`,
    "--style",
    args.style,
    "--output",
    outputPath,
  ];
  if (args.compress) cmdArgs.push("--compress");
  if (args.removeComments) cmdArgs.push("--remove-comments");

  const start = Date.now();
  await new Promise<void>((res, rej) => {
    const child = spawn("npx", cmdArgs, {
      cwd: args.repoPath,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      rej(
        err.code === "ENOENT"
          ? new Error("pack_codebase: `npx` not found on PATH. Install Node.js 20+.")
          : err,
      );
    });
    child.on("exit", (code) => {
      if (code === 0) res();
      else rej(new Error(`pack_codebase: repomix exited ${code}. ${stderr.slice(-400)}`));
    });
  });
  const durationMs = Date.now() - start;
  if (!existsSync(outputPath)) {
    throw new Error(`pack_codebase: repomix did not produce ${outputPath}`);
  }
  const bytes = statSync(outputPath).size;
  return { outputPath, bytes, durationMs };
}

export function registerPackCodebaseTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "pack_codebase",
    {
      title: "Pack a repo into an LLM-ready snapshot",
      description:
        "Produce a snapshot of a registered repo. The default `pack` engine writes the deterministic " +
        "9-item BOM (manifest + skeleton + file-tree + deps + ast-chunks + xrefs + findings + " +
        "licenses + readme + optional embeddings.parquet) under <repo>/.codehub/packs/<packHash>/. " +
        "The legacy `repomix` engine is retained as an opt-in single-file snapshot (drop deferred to M7). " +
        "For relational/structural questions about the repo, prefer query/context/impact — those are " +
        "backed by the SCIP graph and give graph-aware answers without consuming context window.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: PackInput.shape,
    },
    async (input) => fromToolResult(await runPackCodebase(ctx, input as PackInput)),
  );
}

function extForStyle(style: "xml" | "markdown" | "json" | "plain"): string {
  switch (style) {
    case "xml":
      return "xml";
    case "markdown":
      return "md";
    case "json":
      return "json";
    case "plain":
      return "txt";
  }
}
