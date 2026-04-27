/**
 * Derive caller -> callee edges from a SCIP index.
 *
 * Ported from the POC `scip_graph_poc/ingest.py`. SCIP's
 * `Occurrence.enclosing_range` covers the full body of a defined symbol;
 * every non-definition Occurrence whose `range` falls inside some
 * definition's enclosing range is a call/reference from the enclosing
 * definition. Innermost enclosing wins.
 */

import type { ScipDocument, ScipIndex, ScipOccurrence, ScipRange } from "./parse.js";
import { SCIP_ROLE_DEFINITION } from "./parse.js";

export interface DerivedEdge {
  readonly caller: string;
  readonly callee: string;
  readonly document: string;
  readonly callLine: number;
  readonly callChar: number;
  readonly kind: "CALLS" | "REFERENCES";
}

export interface DerivedSymbol {
  readonly symbol: string;
  readonly displayName: string;
  readonly kind: number;
  readonly documentation: string;
  readonly document: string | null;
  readonly definition: ScipRange | null;
}

export interface DerivedIndex {
  readonly tool: { readonly name: string; readonly version: string };
  readonly projectRoot: string;
  readonly symbols: readonly DerivedSymbol[];
  readonly edges: readonly DerivedEdge[];
}

/**
 * SCIP symbol strings look like
 *   `<scheme> <manager> <package-name> <version> <descriptor>+`
 * or `local <N>`. We keep locals out of the graph — they inflate edge
 * counts without providing cross-file reach. Call-graph edges are only
 * emitted between function-like descriptors (ending in `().` or `#`).
 */
function isFunctionLike(symbol: string): boolean {
  if (!symbol || symbol.startsWith("local ")) return false;
  // Function / method descriptors
  if (symbol.endsWith("().")) return true;
  return false;
}

function isReferenceable(symbol: string): boolean {
  return symbol.length > 0 && !symbol.startsWith("local ");
}

function spanOf(r: ScipRange): [number, number] {
  return [r.endLine - r.startLine, r.endChar - r.startChar];
}

function rangeContains(outer: ScipRange, inner: ScipRange): boolean {
  if (
    inner.startLine < outer.startLine ||
    (inner.startLine === outer.startLine && inner.startChar < outer.startChar)
  ) {
    return false;
  }
  if (
    inner.endLine > outer.endLine ||
    (inner.endLine === outer.endLine && inner.endChar > outer.endChar)
  ) {
    return false;
  }
  return true;
}

function innermostEnclosing(
  defs: readonly { symbol: string; range: ScipRange }[],
  site: ScipRange,
): string | null {
  let best: string | null = null;
  let bestSpan: [number, number] = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  for (const d of defs) {
    if (!rangeContains(d.range, site)) continue;
    const span = spanOf(d.range);
    if (span[0] < bestSpan[0] || (span[0] === bestSpan[0] && span[1] < bestSpan[1])) {
      bestSpan = span;
      best = d.symbol;
    }
  }
  return best;
}

export function deriveEdges(doc: ScipDocument): DerivedEdge[] {
  const defs: { symbol: string; range: ScipRange }[] = [];
  for (const occ of doc.occurrences) {
    if (!(occ.symbolRoles & SCIP_ROLE_DEFINITION)) continue;
    if (!occ.symbol) continue;
    const range = occ.enclosingRange ?? occ.range;
    defs.push({ symbol: occ.symbol, range });
  }
  // Sort by outer-first so innermostEnclosing's span comparison is stable.
  defs.sort((a, b) => {
    if (a.range.startLine !== b.range.startLine) return a.range.startLine - b.range.startLine;
    if (a.range.startChar !== b.range.startChar) return a.range.startChar - b.range.startChar;
    if (a.range.endLine !== b.range.endLine) return b.range.endLine - a.range.endLine;
    return b.range.endChar - a.range.endChar;
  });

  const edges: DerivedEdge[] = [];
  for (const occ of doc.occurrences) {
    if (occ.symbolRoles & SCIP_ROLE_DEFINITION) continue;
    if (!isReferenceable(occ.symbol)) continue;
    // The call graph is function-to-function. REFERENCES across types
    // (e.g. `builtins/float#`) are handled by the downstream structural
    // tier and would otherwise distort blast-radius rankings with noise
    // from stdlib types. See POC `scip_graph_poc/ingest.py` for the
    // same contract.
    if (!isFunctionLike(occ.symbol)) continue;
    const caller = innermostEnclosing(defs, occ.range);
    if (!caller || caller === occ.symbol) continue;
    if (!isFunctionLike(caller)) continue;
    edges.push({
      caller,
      callee: occ.symbol,
      document: doc.relativePath,
      callLine: occ.range.startLine,
      callChar: occ.range.startChar,
      kind: "CALLS",
    });
  }
  return edges;
}

export function deriveIndex(index: ScipIndex): DerivedIndex {
  const symbols = new Map<string, DerivedSymbol>();

  // Populate from external_symbols (hover/metadata) and per-document symbols.
  for (const s of index.externalSymbols) {
    symbols.set(s.symbol, {
      symbol: s.symbol,
      displayName: s.displayName,
      kind: s.kind,
      documentation: s.documentation.join("\n"),
      document: null,
      definition: null,
    });
  }
  for (const doc of index.documents) {
    for (const s of doc.symbols) {
      symbols.set(s.symbol, {
        symbol: s.symbol,
        displayName: s.displayName,
        kind: s.kind,
        documentation: s.documentation.join("\n"),
        document: doc.relativePath,
        definition: findDefinition(doc, s.symbol),
      });
    }
  }

  const edges: DerivedEdge[] = [];
  for (const doc of index.documents) {
    for (const edge of deriveEdges(doc)) edges.push(edge);
  }

  return {
    tool: index.tool,
    projectRoot: index.projectRoot,
    symbols: [...symbols.values()],
    edges,
  };
}

function findDefinition(doc: ScipDocument, symbol: string): ScipRange | null {
  for (const occ of doc.occurrences) {
    if (occ.symbol !== symbol) continue;
    if (!(occ.symbolRoles & SCIP_ROLE_DEFINITION)) continue;
    return occ.enclosingRange ?? occ.range;
  }
  return null;
}

export function findOccurrencesBySymbol(
  doc: ScipDocument,
  symbol: string,
): readonly ScipOccurrence[] {
  return doc.occurrences.filter((o) => o.symbol === symbol);
}
