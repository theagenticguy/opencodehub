/**
 * `findEnclosingSymbolId` — deterministic tightest-span lookup mapping a
 * `(filePath, line)` pair back to the OpenCodeHub graph node that owns the
 * line (a Function / Method / Class / …).
 *
 * Canonical home for an algorithm that was previously cloned in two places —
 * `@opencodehub/cli`'s `ingest-sarif` (SARIF finding → enclosing symbol) and
 * `@opencodehub/ingestion`'s `scip-index` (SCIP call site → enclosing symbol).
 * Both now import from here. `@opencodehub/analysis` is the shared home
 * because both `cli` and `ingestion` already depend on it (no new edge, no
 * cycle).
 *
 * The two former clones differed only in their kind allow-set and their node
 * source, so this module exposes the pure core parameterized by a kind-set
 * plus the two named sets; each caller projects its own nodes into `NodeRow[]`
 * and calls the shared index/lookup.
 *
 * 1-indexing note: SARIF 2.1.0 `region.startLine` and OpenCodeHub node
 * `startLine`/`endLine` are both 1-based, so call sites pass lines through
 * unadjusted.
 */

import type { NodeId, NodeKind } from "@opencodehub/core-types";

/** A graph-node projection carrying only the fields the lookup needs. */
export interface NodeRow {
  readonly id: NodeId;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: NodeKind;
}

/** Per-file, start-line-ascending index used by {@link findEnclosingSymbolId}. */
export type NodesByFile = ReadonlyMap<string, readonly NodeRow[]>;

/**
 * SARIF-linkage allow-set — a strict superset of {@link SCIP_SYMBOL_KINDS}
 * that additionally admits `Constructor`, because SARIF tooling routinely
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
 * SCIP-derivation allow-set — the kinds the scip-index phase resolves call
 * sites and definitions against. No `Constructor` (SCIP definition occurrences
 * never land on a bare constructor in the indexers OpenCodeHub ships).
 */
export const SCIP_SYMBOL_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "Class",
  "Method",
  "Function",
  "Interface",
  "Struct",
  "Enum",
  "Trait",
]);

/**
 * Build a per-file, start-line-ascending index over `rows`, keeping only nodes
 * whose `kind` is in `kinds` (default {@link ENCLOSING_SYMBOL_KINDS}) and that
 * carry finite `startLine`/`endLine`. Within each file the array is sorted by
 * `startLine` asc, `endLine` asc — the sort lets {@link findEnclosingSymbolId}
 * early-break once it passes the target line.
 */
export function indexNodesByFile(
  rows: readonly NodeRow[],
  kinds: ReadonlySet<NodeKind> = ENCLOSING_SYMBOL_KINDS,
): NodesByFile {
  const map = new Map<string, NodeRow[]>();
  for (const row of rows) {
    if (!kinds.has(row.kind)) continue;
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
 * Return the id of the tightest-span node in `nodesByFile[filePath]` that
 * encloses `line` (`startLine <= line <= endLine`). "Tightest" means smallest
 * `endLine - startLine`, so a nested method wins over its containing class.
 * Returns `undefined` when the file is unknown or no candidate contains the
 * line.
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
