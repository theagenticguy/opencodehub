import type { LanguageProvider } from "../types.js";

/**
 * Three-tier name resolution. Ordered from most to least specific; each tier
 * has a fixed confidence score so callers can rank candidates across tiers
 * without re-deriving weights.
 */
export type ResolutionTier = "same-file" | "import-scoped" | "global";

export const CONFIDENCE_BY_TIER: Readonly<Record<ResolutionTier, number>> = {
  "same-file": 0.95,
  "import-scoped": 0.9,
  global: 0.5,
};

export interface ResolutionQuery {
  readonly callerFile: string;
  readonly calleeName: string;
  readonly provider: LanguageProvider;
}

export interface ResolutionCandidate {
  readonly targetId: string;
  readonly tier: ResolutionTier;
  readonly confidence: number;
}

/**
 * Minimal symbol-lookup surface. Concrete implementations sit atop the
 * DuckDB-backed `IGraphStore`, but every resolver strategy speaks to this
 * interface so unit tests can drive it with in-memory fixtures.
 */
export interface SymbolIndex {
  findInFile(filePath: string, name: string): string | undefined;
  findInImports(importerFile: string, name: string): string | undefined;
  findGlobal(name: string): readonly string[];
}

/**
 * Walk the three tiers in specificity order and emit candidates.
 *  1. Same-file hit: single high-confidence candidate, short-circuit.
 *  2. Import-scoped: the declaration brought in by an `import` statement.
 *  3. Global: any candidate with a matching name anywhere in the workspace.
 *
 * Results are sorted by descending confidence — callers may truncate.
 */
export function resolve(q: ResolutionQuery, index: SymbolIndex): ResolutionCandidate[] {
  const sameFile = index.findInFile(q.callerFile, q.calleeName);
  if (sameFile !== undefined) {
    return [
      {
        targetId: sameFile,
        tier: "same-file",
        confidence: CONFIDENCE_BY_TIER["same-file"],
      },
    ];
  }

  const imported = index.findInImports(q.callerFile, q.calleeName);
  if (imported !== undefined) {
    return [
      {
        targetId: imported,
        tier: "import-scoped",
        confidence: CONFIDENCE_BY_TIER["import-scoped"],
      },
    ];
  }

  const globals = index.findGlobal(q.calleeName);
  const globalCandidates: ResolutionCandidate[] = globals.map((id) => ({
    targetId: id,
    tier: "global" as const,
    confidence: CONFIDENCE_BY_TIER.global,
  }));

  // Tiers are already in descending confidence; sort guards future tier
  // reordering without changing callers.
  return globalCandidates.slice().sort((a, b) => b.confidence - a.confidence);
}
