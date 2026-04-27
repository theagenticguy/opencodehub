/**
 * `pack_codebase` — produce a single-file LLM-ready snapshot of a repo
 * via the `repomix` CLI, optionally with tree-sitter AST compression.
 *
 * This is the output-side companion to the (input-side, SCIP-driven)
 * graph tools. Agents call this when they want a broad dump of the
 * repo's surface area to paste into their own context window; they
 * still call `query` / `context` / `impact` for relational facts.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { resolveRepo } from "../repo-resolver.js";
import { fromToolResult, type ToolContext, type ToolResult, toToolResult } from "./shared.js";

const DEFAULT_REPOMIX_VERSION = "1.14.0";

const PackInput = z.object({
  repo: z.string().describe("Registered repo name (see list_repos)."),
  style: z
    .enum(["xml", "markdown", "json", "plain"])
    .optional()
    .default("xml")
    .describe("Output style. xml is Anthropic-friendly; markdown is human-readable."),
  compress: z
    .boolean()
    .optional()
    .default(true)
    .describe("Apply tree-sitter signature compression (~70% token reduction)."),
  removeComments: z.boolean().optional().default(false),
});
type PackInput = z.infer<typeof PackInput>;

export async function runPackCodebase(ctx: ToolContext, input: PackInput): Promise<ToolResult> {
  try {
    const entry = await resolveRepo(input.repo, {
      ...(ctx.home !== undefined ? { home: ctx.home } : {}),
      skipMeta: true,
    });
    const outputPath = join(entry.repoPath, ".codehub", "pack", `repo.${extForStyle(input.style)}`);
    await mkdir(dirname(outputPath), { recursive: true });

    const args = [
      `repomix@${DEFAULT_REPOMIX_VERSION}`,
      "--style",
      input.style,
      "--output",
      outputPath,
    ];
    if (input.compress) args.push("--compress");
    if (input.removeComments) args.push("--remove-comments");

    const start = Date.now();
    await new Promise<void>((res, rej) => {
      const child = spawn("npx", args, {
        cwd: entry.repoPath,
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

    const body = [
      `Packed ${entry.name} to ${outputPath}`,
      `  bytes:    ${bytes}`,
      `  style:    ${input.style}`,
      `  compress: ${input.compress}`,
      `  duration: ${durationMs}ms`,
    ].join("\n");

    return toToolResult(
      withNextSteps(body, { outputPath, bytes, style: input.style, durationMs }, [
        "load the output file into your context; structural questions go to `query`/`context`/`impact`.",
      ]),
    );
  } catch (err) {
    return toToolResult(toolErrorFromUnknown(err));
  }
}

export function registerPackCodebaseTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "pack_codebase",
    {
      title: "Pack a repo into an LLM-ready snapshot",
      description:
        "Produce a single-file snapshot of a registered repo via repomix, optionally with tree-sitter AST compression for ~70% token reduction. Output goes under <repo>/.codehub/pack/. For relational/structural questions about the repo, prefer query/context/impact — those are backed by the SCIP graph and give graph-aware answers without consuming context window.",
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
