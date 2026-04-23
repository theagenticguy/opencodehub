// Glue layer that wires rule-parser → builder → engine into one entry point.
//
// Exposed as a small function set so the per-language resolver strategy can
// build graphs lazily per file and hand them to the partial-path engine as
// references get resolved. Nothing here knows about the ResolverStrategy
// interface — that lives in `stack-graphs-python.ts`.

import { buildStackGraph, type MinimalTsTree } from "./node-edge-builder.js";
import { resolveReference } from "./partial-path-engine.js";
import { type ParsedTsg, parseTsg } from "./rule-parser.js";
import type { PartialPathResult, ReferenceQuery, StackGraph, TsgRule } from "./types.js";

/** Cache key: SHA-less; in v1 we only load the rule file once per process. */
interface RuleCache {
  parsed: ParsedTsg | null;
}

const RULES: RuleCache = { parsed: null };

/** Parse the rule file text once. Safe to call repeatedly. */
export function loadRules(source: string): ParsedTsg {
  if (RULES.parsed !== null) return RULES.parsed;
  RULES.parsed = parseTsg(source);
  return RULES.parsed;
}

/** For tests: clear the memoized rule cache. */
export function resetRulesForTests(): void {
  RULES.parsed = null;
}

/**
 * Build one stack-graph per file up front. Callers normally feed in every
 * Python file in the index so cross-module resolution can hop through ROOT.
 */
export function buildAllStackGraphs(
  files: ReadonlyMap<string, MinimalTsTree>,
  rules: readonly TsgRule[],
): ReadonlyMap<string, StackGraph> {
  const out = new Map<string, StackGraph>();
  for (const [file, tree] of files) {
    out.set(file, buildStackGraph(file, tree, rules));
  }
  return out;
}

/** Resolve a single reference, returning path results and truncation info. */
export function resolveViaStackGraphs(
  query: ReferenceQuery,
  graphs: ReadonlyMap<string, StackGraph>,
): PartialPathResult {
  const graph = graphs.get(query.file);
  if (graph === undefined) return { results: [], truncated: false };
  const key = `${query.line}:${query.column}`;
  const refNodeId = graph.referenceIndex.get(key);
  if (refNodeId === undefined) return { results: [], truncated: false };
  return resolveReference(graphs, query.file, refNodeId);
}
