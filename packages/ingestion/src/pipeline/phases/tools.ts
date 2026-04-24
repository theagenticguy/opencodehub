/**
 * Tools phase — materialises MCP / JSON-RPC tool definitions as graph
 * nodes and edges.
 *
 * For every scanned JS/TS file we run the heuristic MCP tool detector; each
 * `{ name, description }` pair it returns becomes a `Tool` node keyed by
 * handler file + tool name. `HANDLES_TOOL` edges connect each declaring
 * File node to the tool with confidence 0.85.
 *
 * Duplicate tool names across files are tallied and warned globally — a
 * common sign that two modules registered the same slug, which agent
 * runtimes will reject at dispatch time.
 */

import { promises as fs } from "node:fs";
import type { ToolNode } from "@opencodehub/core-types";
import { makeNodeId } from "@opencodehub/core-types";
import { detectMcpTools } from "../../extract/tool-detector.js";
import type { ExtractedTool } from "../../extract/types.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";

const JS_TS_EXTS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export interface ToolsOutput {
  readonly toolCount: number;
  readonly duplicateCount: number;
}

export const TOOLS_PHASE_NAME = "tools";

export const toolsPhase: PipelinePhase<ToolsOutput> = {
  name: TOOLS_PHASE_NAME,
  deps: [PARSE_PHASE_NAME],
  async run(ctx) {
    const scan = ctx.phaseOutputs.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (scan === undefined) {
      throw new Error("tools: scan output missing from phase outputs");
    }
    return runTools(ctx, scan);
  },
};

async function runTools(ctx: PipelineContext, scan: ScanOutput): Promise<ToolsOutput> {
  const candidates = scan.files.filter((f) => JS_TS_EXTS.has(extLower(f.relPath)));

  const collected: ExtractedTool[] = [];
  for (const f of candidates) {
    let content: string;
    try {
      const buf = await fs.readFile(f.absPath);
      content = buf.toString("utf8");
    } catch (err) {
      ctx.onProgress?.({
        phase: TOOLS_PHASE_NAME,
        kind: "warn",
        message: `tools: cannot read ${f.relPath}: ${(err as Error).message}`,
      });
      continue;
    }
    for (const t of detectMcpTools({ filePath: f.relPath, content })) {
      collected.push(t);
    }
  }

  // Global duplicate detection keyed purely on tool name.
  const nameCounts = new Map<string, number>();
  for (const t of collected) {
    nameCounts.set(t.toolName, (nameCounts.get(t.toolName) ?? 0) + 1);
  }

  // Stable order for byte-identical graph output.
  const ordered = [...collected].sort(compareTool);

  let duplicateCount = 0;
  const warnedNames = new Set<string>();
  let toolCount = 0;

  for (const t of ordered) {
    const toolId = makeNodeId("Tool", t.handlerFile, t.toolName);
    const node: ToolNode = {
      id: toolId,
      kind: "Tool",
      name: t.toolName,
      filePath: t.handlerFile,
      toolName: t.toolName,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.inputSchemaJson !== undefined ? { inputSchemaJson: t.inputSchemaJson } : {}),
    };
    ctx.graph.addNode(node);
    toolCount += 1;

    const fileId = makeNodeId("File", t.handlerFile, t.handlerFile);
    ctx.graph.addEdge({
      from: fileId,
      to: toolId,
      type: "HANDLES_TOOL",
      confidence: 0.85,
      reason: "mcp-tool-definition",
    });

    if ((nameCounts.get(t.toolName) ?? 0) > 1 && !warnedNames.has(t.toolName)) {
      warnedNames.add(t.toolName);
      duplicateCount += 1;
      ctx.onProgress?.({
        phase: TOOLS_PHASE_NAME,
        kind: "warn",
        message: `tools: duplicate tool name '${t.toolName}' declared in multiple files`,
      });
    }
  }

  return { toolCount, duplicateCount };
}

function compareTool(a: ExtractedTool, b: ExtractedTool): number {
  if (a.handlerFile !== b.handlerFile) return a.handlerFile < b.handlerFile ? -1 : 1;
  if (a.toolName !== b.toolName) return a.toolName < b.toolName ? -1 : 1;
  return 0;
}

function extLower(relPath: string): string {
  const idx = relPath.lastIndexOf(".");
  if (idx < 0) return "";
  return relPath.slice(idx).toLowerCase();
}
