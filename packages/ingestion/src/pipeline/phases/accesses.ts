/**
 * Accesses phase — emits ACCESSES edges from Function/Method/Constructor
 * nodes to Property nodes, tagged `read` or `write`.
 *
 * Scope (v2): providers that opt in (TS, TSX, JS, Python) supply an
 * {@link LanguageProvider.extractPropertyAccesses} hook; everyone else is a
 * silent no-op. The hook receives per-file `definitions`, `captures`,
 * `sourceText`, and `filePath` (mirroring the parse-phase hand-off) and
 * returns {@link PropertyAccess} records keyed by the enclosing symbol's
 * `NodeId`.
 *
 * Resolution: property names are FLAT. For every access we look up a matching
 * `Property` node in order:
 *   1. Same-file property with identical `name`. Matches by name only; a
 *      future pass will tighten to (owner, name) pairs once TS classes
 *      reliably surface field members.
 *   2. Any other `Property` node with the same name (deterministically the
 *      one with the smallest NodeId).
 *   3. If neither hits, we synthesise a `Property:unresolved:<name>` stub
 *      node. The stub serves as a stable anchor so a later re-run that
 *      introduces the real field produces a CLEAN graph-hash delta instead
 *      of orphaned accesses being silently dropped.
 *
 * Determinism:
 *   - Files are iterated in sorted order.
 *   - Providers sort their accesses before returning.
 *   - The phase re-sorts by (fromId, toId, startLine) before calling
 *     `graph.addEdge` so the final emit order is independent of provider
 *     output order.
 *   - A 50,000 edges-per-file cap guards against pathological generated
 *     files; overage is dropped with a `warn` event.
 */

import type { GraphNode, NodeId } from "@opencodehub/core-types";
import { makeNodeId } from "@opencodehub/core-types";
import { getProvider } from "../../providers/registry.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import { PARSE_PHASE_NAME, type ParseOutput } from "./parse.js";

export const ACCESSES_PHASE_NAME = "accesses";

/** Cap on ACCESSES edges emitted per file; protects against generated code. */
const MAX_ACCESSES_PER_FILE = 50_000;

export interface AccessesOutput {
  /** Count of ACCESSES edges actually emitted across all files. */
  readonly edgeCount: number;
  /** Files whose accesses were truncated at {@link MAX_ACCESSES_PER_FILE}. */
  readonly truncatedFiles: readonly string[];
  /** Synthesised `Property:unresolved:<name>` anchors added to the graph. */
  readonly unresolvedCount: number;
}

export const accessesPhase: PipelinePhase<AccessesOutput> = {
  name: ACCESSES_PHASE_NAME,
  deps: [PARSE_PHASE_NAME, CROSS_FILE_PHASE_NAME],
  async run(ctx, deps) {
    const parse = deps.get(PARSE_PHASE_NAME) as ParseOutput | undefined;
    if (parse === undefined) {
      throw new Error("accesses: parse output missing from dependency map");
    }
    return runAccesses(ctx, parse);
  },
};

function runAccesses(ctx: PipelineContext, parse: ParseOutput): AccessesOutput {
  // ---- Build a global Property index by bare name. ----------------------
  // Per-file pre-filter + global fallback pools. Both are deterministic:
  // NodeIds are sorted before being inserted into each bucket.
  const propByFileAndName = new Map<string, Map<string, NodeId>>();
  const propByName = new Map<string, NodeId[]>();
  for (const n of ctx.graph.nodes()) {
    if (n.kind !== "Property") continue;
    const bucket = propByName.get(n.name) ?? [];
    bucket.push(n.id);
    propByName.set(n.name, bucket);
    let perFile = propByFileAndName.get(n.filePath ?? "");
    if (perFile === undefined) {
      perFile = new Map<string, NodeId>();
      propByFileAndName.set(n.filePath ?? "", perFile);
    }
    // Most-recent-wins is fine: if two properties share a file+name the
    // graph is already inconsistent, and the walker only observes one.
    perFile.set(n.name, n.id);
  }
  for (const [name, list] of propByName) {
    propByName.set(name, [...list].sort());
  }

  // ---- Per-file provider dispatch + edge emission. ----------------------
  let edgeCount = 0;
  let unresolvedCount = 0;
  const truncatedFiles: string[] = [];
  const syntheticIds = new Set<string>();

  const files = [...parse.definitionsByFile.keys()].sort();
  for (const filePath of files) {
    const language = languageForFile(filePath, parse);
    if (language === undefined) continue;
    const provider = getProvider(language);
    if (provider.extractPropertyAccesses === undefined) continue;

    const defs = parse.definitionsByFile.get(filePath) ?? [];
    const sourceText = parse.sourceByFile.get(filePath);
    if (sourceText === undefined || sourceText === "") continue;
    // `captures` is reserved for a future AST-driven path; the walker
    // only consumes `definitions` + `sourceText` today.
    const accesses = provider.extractPropertyAccesses({
      filePath,
      definitions: defs,
      captures: [],
      sourceText,
    });

    // Cap enforcement — emit a warning once and drop the tail. The
    // providers already sort by (enclosingSymbolId, propertyName,
    // startLine), so truncation is stable across runs.
    let usableAccesses: readonly (typeof accesses)[number][] = accesses;
    if (accesses.length > MAX_ACCESSES_PER_FILE) {
      truncatedFiles.push(filePath);
      usableAccesses = accesses.slice(0, MAX_ACCESSES_PER_FILE);
      ctx.onProgress?.({
        phase: ACCESSES_PHASE_NAME,
        kind: "warn",
        message: `accesses: ${filePath} produced ${accesses.length} accesses; capped at ${MAX_ACCESSES_PER_FILE}`,
      });
    }

    // Resolve each access to a Property NodeId. Synthesise an unresolved
    // stub when both same-file and global lookups fail.
    interface EmitEdge {
      readonly from: NodeId;
      readonly to: NodeId;
      readonly reason: "read" | "write";
      readonly startLine: number;
    }
    const edges: EmitEdge[] = [];
    const perFile = propByFileAndName.get(filePath);
    for (const acc of usableAccesses) {
      let target: NodeId | undefined = perFile?.get(acc.propertyName);
      if (target === undefined) {
        const global = propByName.get(acc.propertyName);
        if (global !== undefined && global.length > 0) target = global[0];
      }
      if (target === undefined) {
        // Synthesise the stub on first use so the graph stays minimal.
        const stubId = makeNodeId("Property", "<unresolved>", acc.propertyName);
        if (!syntheticIds.has(stubId)) {
          syntheticIds.add(stubId);
          unresolvedCount += 1;
          const node: GraphNode = {
            id: stubId,
            kind: "Property",
            name: acc.propertyName,
            filePath: "<unresolved>",
            startLine: 0,
            endLine: 0,
          };
          ctx.graph.addNode(node);
        }
        target = stubId;
      }
      edges.push({
        from: acc.enclosingSymbolId as NodeId,
        to: target,
        reason: acc.reason,
        startLine: acc.startLine,
      });
    }

    // Re-sort for emit determinism: (fromId, toId, startLine, reason).
    edges.sort((a, b) => {
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      if (a.to !== b.to) return a.to < b.to ? -1 : 1;
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.reason < b.reason ? -1 : 1;
    });

    for (const e of edges) {
      ctx.graph.addEdge({
        from: e.from,
        to: e.to,
        type: "ACCESSES",
        confidence: 0.8,
        reason: e.reason,
      });
      edgeCount += 1;
    }
  }

  return { edgeCount, truncatedFiles, unresolvedCount };
}

function languageForFile(
  filePath: string,
  _parse: ParseOutput,
): "typescript" | "tsx" | "javascript" | "python" | undefined {
  const idx = filePath.lastIndexOf(".");
  if (idx < 0) return undefined;
  const ext = filePath.slice(idx).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".jsx":
      return "javascript";
    case ".py":
    case ".pyi":
      return "python";
    default:
      return undefined;
  }
}
