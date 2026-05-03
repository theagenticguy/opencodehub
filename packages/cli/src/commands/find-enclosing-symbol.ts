/**
 * `findEnclosingSymbolId` — deterministic tightest-span lookup that maps a
 * `(filePath, line)` pair back to the OpenCodeHub graph node that owns the
 * line (a Function / Method / Class / etc.). Used by `ingest-sarif` to link
 * SARIF `Finding` nodes to the enclosing code symbol when the scanner did
 * not populate `result.properties["opencodehub.symbolId"]` itself.
 *
 * This is a clone of the algorithm in
 * `packages/ingestion/src/pipeline/phases/scip-index.ts:indexNodesByFile` +
 * `findEnclosingNodeId`. The two call sites live in different packages
 * (`@opencodehub/cli` vs `@opencodehub/ingestion`), and extracting a shared
 * helper would require a cross-package refactor that is explicitly out of
 * scope for the SARIF linkage task. If these functions need to converge
 * later, promote this file to a shared util package (e.g.
 * `@opencodehub/graph-utils`) and delete the duplicate in scip-index.ts in
 * a single atomic change.
 *
 * Notes on 1-indexing: both SARIF 2.1.0 `region.startLine` and
 * OpenCodeHub node `startLine`/`endLine` are 1-based, so no offset
 * adjustment is needed at the call site.
 */

import type { NodeId, NodeKind } from "@opencodehub/core-types";

/** A graph node projection carrying only the fields the lookup needs. */
export interface NodeRow {
  readonly id: NodeId;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: NodeKind;
}

/** Per-file, start-line-ascending index used by `findEnclosingSymbolId`. */
export type NodesByFile = ReadonlyMap<string, readonly NodeRow[]>;

/**
 * Code-kind allow set used when resolving SARIF findings back to an
 * enclosing symbol. Matches the set enumerated in the T-M1-4 packet
 * conventions (Function, Method, Constructor, Class, Interface, Struct,
 * Enum, Trait) and is a strict superset of `SCIP_SYMBOL_KINDS` — we
 * additionally allow `Constructor` here because SARIF tooling routinely
 * emits findings inside constructor bodies.
 */
export const ENCLOSING_SYMBOL_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "Function",
  "Method",
  "Constructor",
  "Class",
  "Interface",
  "Struct",
  "Enum",
  "Trait",
]);

/**
 * Build a per-file, start-line-ascending index over the supplied node
 * rows, filtering to nodes whose `kind` is in `ENCLOSING_SYMBOL_KINDS`.
 * Rows missing either `startLine` or `endLine` are skipped silently —
 * they cannot participate in a range containment check.
 *
 * Ordering: within each file the array is sorted by `startLine` ascending
 * with `endLine` ascending as the tie-breaker. `findEnclosingSymbolId`
 * still scans the whole candidate list for the tightest span, so the
 * sort is primarily an early-break optimization (once `startLine > line`
 * we can stop).
 */
export function indexNodesByFile(rows: readonly NodeRow[]): NodesByFile {
  const map = new Map<string, NodeRow[]>();
  for (const row of rows) {
    if (!ENCLOSING_SYMBOL_KINDS.has(row.kind)) continue;
    if (!Number.isFinite(row.startLine) || !Number.isFinite(row.endLine)) continue;
    const bucket = map.get(row.filePath);
    if (bucket === undefined) map.set(row.filePath, [row]);
    else bucket.push(row);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.endLine - b.endLine;
    });
  }
  return map;
}

/**
 * Return the id of the tightest-span node in `nodesByFile[filePath]`
 * that encloses `line` (`startLine <= line <= endLine`). "Tightest"
 * means smallest `endLine - startLine` span — this makes nested methods
 * win over their containing classes. When two candidates have the same
 * span, the earlier `startLine` wins (which falls out of the deterministic
 * input sort).
 *
 * Returns `undefined` when the file is unknown, when no candidate
 * contains the line, or when every candidate has been filtered out by
 * the allow-set at index time.
 */
export function findEnclosingSymbolId(
  nodesByFile: NodesByFile,
  filePath: string,
  line: number,
): NodeId | undefined {
  const candidates = nodesByFile.get(filePath);
  if (candidates === undefined) return undefined;
  let best: NodeRow | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const rec of candidates) {
    // Candidates are sorted by startLine; once we pass the target line
    // no later row can enclose it.
    if (rec.startLine > line) break;
    if (rec.endLine < line) continue;
    const span = rec.endLine - rec.startLine;
    if (span < bestSpan) {
      best = rec;
      bestSpan = span;
    }
  }
  return best?.id;
}
