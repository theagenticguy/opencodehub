// Python-specific ResolverStrategy backed by the clean-room stack-graphs
// evaluator. Uses the three-tier walker as a fallback whenever stack-graphs
// can't produce an answer — missing rule file, empty graph cache, parse
// errors, traversal timeout — so a Python ingest never regresses versus the
// default resolver.
//
// The strategy is registered in resolver-strategy.ts under the key
// "stack-graphs"; the python provider opts in via `resolverStrategyName`.
//
// Cross-module graph wiring is provided by the caller via `registerStackGraphs`
// — the ingestion pipeline prepares one `StackGraph` per Python file during
// parse and primes the cache before resolution begins. Tests drive this same
// API with in-memory fixtures.

import type { ResolutionCandidate, ResolutionQuery, SymbolIndex } from "./context.js";
import { CONFIDENCE_BY_TIER, resolve as threeTierResolve } from "./context.js";
import type { ResolverStrategy } from "./resolver-strategy.js";
import { resolveViaStackGraphs } from "./stack-graphs/glue.js";
import type { ReferenceQuery, StackGraph } from "./stack-graphs/types.js";
import { STACK_GRAPHS_HIT_CONFIDENCE } from "./stack-graphs/types.js";

/**
 * Per-reference lookup info the ingestion pipeline attaches to the query
 * when delegating to stack-graphs. The default three-tier `ResolutionQuery`
 * lacks line/column, so strategies that want them advertise a sibling
 * interface and the pipeline downcasts when invoking stack-graphs.
 */
export interface StackGraphsHintedQuery extends ResolutionQuery {
  readonly referenceLine?: number;
  readonly referenceColumn?: number;
}

interface StackGraphStore {
  readonly graphs: Map<string, StackGraph>;
  fallbacks: number;
  stackGraphHits: number;
}

const STORE: StackGraphStore = {
  graphs: new Map(),
  fallbacks: 0,
  stackGraphHits: 0,
};

/**
 * Prime the cache with per-file stack graphs. Called by the ingestion parse
 * phase before resolution runs.
 */
export function registerStackGraphs(graphs: ReadonlyMap<string, StackGraph>): void {
  STORE.graphs.clear();
  for (const [k, v] of graphs) STORE.graphs.set(k, v);
}

/** For tests: drop all graphs. */
export function clearStackGraphsForTests(): void {
  STORE.graphs.clear();
  STORE.fallbacks = 0;
  STORE.stackGraphHits = 0;
}

/** Stats surfaced to the pipeline for telemetry. */
export function getStackGraphsStats(): { readonly fallbacks: number; readonly hits: number } {
  return { fallbacks: STORE.fallbacks, hits: STORE.stackGraphHits };
}

/** Is this provider Python? Strategy no-ops on non-Python inputs. */
function isPythonQuery(q: ResolutionQuery): boolean {
  return q.provider.id === "python";
}

function mapTargetKeyToResolutionId(targetKey: string): string {
  // targetKey is `${file}:${line}:${qualifiedName}`. We emit this as the
  // resolver's `targetId`. The storage layer treats opaque ids, so any
  // shape that's unique works. Using `:` as the separator mirrors the
  // qualified-name convention elsewhere in the ingestion pipeline.
  return targetKey;
}

function runStackGraphs(q: StackGraphsHintedQuery): ResolutionCandidate | null {
  if (STORE.graphs.size === 0) return null;
  const line = q.referenceLine;
  const column = q.referenceColumn;
  if (line === undefined || column === undefined) return null;

  const ref: ReferenceQuery = {
    file: q.callerFile,
    line,
    column,
    name: q.calleeName,
  };
  try {
    const { results } = resolveViaStackGraphs(ref, STORE.graphs);
    const best = results[0];
    if (best === undefined) return null;
    return {
      targetId: mapTargetKeyToResolutionId(best.targetKey),
      tier: "import-scoped",
      confidence: STACK_GRAPHS_HIT_CONFIDENCE,
    };
  } catch {
    return null;
  }
}

export const stackGraphsPythonResolver: ResolverStrategy = {
  name: "stack-graphs",
  resolve(q: ResolutionQuery, index: SymbolIndex): ResolutionCandidate[] {
    if (!isPythonQuery(q)) {
      return threeTierResolve(q, index);
    }
    const hinted = q as StackGraphsHintedQuery;
    const hit = runStackGraphs(hinted);
    if (hit !== null) {
      STORE.stackGraphHits++;
      // Stack-graphs resolutions always outrank the three-tier import-scoped
      // confidence — we emit the fixed STACK_GRAPHS_HIT_CONFIDENCE score and
      // leave re-ranking to the caller.
      const clamped: ResolutionCandidate = {
        targetId: hit.targetId,
        tier: hit.tier,
        confidence: Math.max(hit.confidence, CONFIDENCE_BY_TIER["import-scoped"]),
      };
      return [clamped];
    }
    STORE.fallbacks++;
    return threeTierResolve(q, index);
  },
};
