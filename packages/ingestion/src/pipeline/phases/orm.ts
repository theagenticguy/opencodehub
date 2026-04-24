/**
 * ORM phase — turns Prisma / Supabase call sites into `QUERIES` edges.
 *
 * For every scanned JS/TS file the phase runs both ORM detectors. Each
 * emitted `ExtractedOrmEdge` is materialised as:
 *   1. A target node — preferably an existing `Class` / `Interface`
 *      definition whose name matches the model/table identifier
 *      (same-file hit beats global), falling back to a `CodeElement`
 *      placeholder pinned to the synthetic `<external>` path.
 *   2. A `QUERIES` edge from the caller File → target node, tagged with
 *      `reason: "<orm>-<operation>"` and the detector's confidence score.
 *
 * The placeholder node lives under the sentinel `<external>` file path so
 * downstream queries can filter it out trivially, and its id is stable
 * across runs: `CodeElement:<external>:${orm}:${modelName}`.
 */

import { promises as fs } from "node:fs";
import type { CodeElementNode } from "@opencodehub/core-types";
import { makeNodeId, type NodeId } from "@opencodehub/core-types";
import { detectPrismaCalls, detectSupabaseCalls } from "../../extract/orm-detector.js";
import type { ExtractedOrmEdge } from "../../extract/types.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { PARSE_PHASE_NAME, type ParseOutput } from "./parse.js";
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

/** Sentinel file path for placeholder nodes that don't resolve to a repo file. */
export const ORM_EXTERNAL_PATH = "<external>";

export interface OrmOutput {
  readonly queriesCount: number;
  readonly placeholderCount: number;
}

export const ORM_PHASE_NAME = "orm";

export const ormPhase: PipelinePhase<OrmOutput> = {
  name: ORM_PHASE_NAME,
  deps: [PARSE_PHASE_NAME],
  async run(ctx, deps) {
    const parse = deps.get(PARSE_PHASE_NAME) as ParseOutput | undefined;
    if (parse === undefined) {
      throw new Error("orm: parse output missing from dependency map");
    }
    const scan = ctx.phaseOutputs.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (scan === undefined) {
      throw new Error("orm: scan output missing from phase outputs");
    }
    return runOrm(ctx, scan, parse);
  },
};

async function runOrm(
  ctx: PipelineContext,
  scan: ScanOutput,
  parse: ParseOutput,
): Promise<OrmOutput> {
  const candidates = scan.files.filter((f) => JS_TS_EXTS.has(extLower(f.relPath)));

  const collected: ExtractedOrmEdge[] = [];
  for (const f of candidates) {
    let content: string;
    try {
      const buf = await fs.readFile(f.absPath);
      content = buf.toString("utf8");
    } catch (err) {
      ctx.onProgress?.({
        phase: ORM_PHASE_NAME,
        kind: "warn",
        message: `orm: cannot read ${f.relPath}: ${(err as Error).message}`,
      });
      continue;
    }
    for (const e of detectPrismaCalls({ filePath: f.relPath, content })) collected.push(e);
    for (const e of detectSupabaseCalls({ filePath: f.relPath, content })) collected.push(e);
  }

  // Sort deterministically before emission so node/edge IDs land in the
  // same order across runs.
  collected.sort(compareOrmEdge);

  // Track which (file, model, op, orm) tuples we've already emitted so
  // repeat call sites within the same file don't double-count. The edge
  // store itself dedupes on (from, type, to, step); we use `step` to
  // distinguish per-operation edges between the same file/model pair.
  const emittedEdges = new Set<string>();
  const stepByEdgeBase = new Map<string, number>();
  const placeholderIds = new Set<NodeId>();
  let queriesCount = 0;

  for (const e of collected) {
    const edgeKey = `${e.callerFile}\u0000${e.modelName}\u0000${e.operation}\u0000${e.orm}`;
    if (emittedEdges.has(edgeKey)) continue;
    emittedEdges.add(edgeKey);

    const targetId = resolveModelTarget(e, parse, ctx);
    const callerFileId = makeNodeId("File", e.callerFile, e.callerFile);
    // `step` makes each (file -> model) pair a unique edge per operation.
    const edgeBase = `${callerFileId}\u0000${targetId}`;
    const nextStep = (stepByEdgeBase.get(edgeBase) ?? 0) + 1;
    stepByEdgeBase.set(edgeBase, nextStep);

    ctx.graph.addEdge({
      from: callerFileId,
      to: targetId,
      type: "QUERIES",
      confidence: e.confidence,
      reason: `${e.orm}-${e.operation}`,
      step: nextStep,
    });
    queriesCount += 1;

    // A placeholder was created only if its id landed under ORM_EXTERNAL_PATH.
    if (targetId.includes(`:${ORM_EXTERNAL_PATH}:`)) {
      placeholderIds.add(targetId);
    }
  }

  return {
    queriesCount,
    placeholderCount: placeholderIds.size,
  };
}

/**
 * Prefer a same-file definition, then a globally-unique one, otherwise
 * synthesise a `CodeElement` placeholder anchored at `<external>`.
 */
function resolveModelTarget(e: ExtractedOrmEdge, parse: ParseOutput, ctx: PipelineContext): NodeId {
  const sameFile = parse.symbolIndex.findInFile(e.callerFile, e.modelName);
  if (sameFile !== undefined && isModelNode(sameFile as NodeId)) {
    return sameFile as NodeId;
  }

  const globals = parse.symbolIndex.findGlobal(e.modelName);
  const firstModelHit = globals.find((id) => isModelNode(id as NodeId));
  if (firstModelHit !== undefined) {
    return firstModelHit as NodeId;
  }

  // Placeholder. Deterministic id: ORM + model. The id is also keyed on
  // the orm family so `prisma.User` and `supabase.user` don't collide.
  const placeholderId = makeNodeId("CodeElement", ORM_EXTERNAL_PATH, `${e.orm}:${e.modelName}`);
  const node: CodeElementNode = {
    id: placeholderId,
    kind: "CodeElement",
    name: e.modelName,
    filePath: ORM_EXTERNAL_PATH,
    content: `${e.orm} model: ${e.modelName}`,
  };
  ctx.graph.addNode(node);
  return placeholderId;
}

/**
 * Return `true` when the node id's kind is a definition-like kind that
 * could plausibly represent a model (Class, Interface, TypeAlias, Struct,
 * Record). We inspect the node id prefix rather than touching the graph
 * because the id already encodes the kind.
 */
function isModelNode(id: NodeId): boolean {
  const colonIdx = id.indexOf(":");
  if (colonIdx < 0) return false;
  const kind = id.slice(0, colonIdx);
  return (
    kind === "Class" ||
    kind === "Interface" ||
    kind === "TypeAlias" ||
    kind === "Struct" ||
    kind === "Record"
  );
}

function compareOrmEdge(a: ExtractedOrmEdge, b: ExtractedOrmEdge): number {
  if (a.callerFile !== b.callerFile) return a.callerFile < b.callerFile ? -1 : 1;
  if (a.orm !== b.orm) return a.orm < b.orm ? -1 : 1;
  if (a.modelName !== b.modelName) return a.modelName < b.modelName ? -1 : 1;
  if (a.operation !== b.operation) return a.operation < b.operation ? -1 : 1;
  return 0;
}

function extLower(relPath: string): string {
  const idx = relPath.lastIndexOf(".");
  if (idx < 0) return "";
  return relPath.slice(idx).toLowerCase();
}
