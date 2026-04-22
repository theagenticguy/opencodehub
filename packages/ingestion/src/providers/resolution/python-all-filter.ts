// __all__ post-processor for wildcard Python imports.
//
// Upstream stack-graphs does not honour `__all__` lists; its edge model
// makes every top-level def reachable from a wildcard import. When a
// resolution candidate comes in via a wildcard path and the target
// module has an `__all__` declaration, we filter candidates down to the
// listed names only. If no `__all__` is declared we pass everything through.

import { readFileSync } from "node:fs";
import type { ResolutionCandidate } from "./context.js";

/**
 * Parse `__all__ = [...]` from a Python source string.
 *
 * Supports three syntactic forms in common use:
 *   __all__ = ["a", "b"]
 *   __all__ = ('a', 'b')
 *   __all__ = ["a", "b",]  # trailing comma
 *
 * Returns `null` when no recognisable declaration exists, which the
 * caller treats as "filter is disabled".
 */
export function parsePythonAll(source: string): readonly string[] | null {
  // Regex matches the right-hand-side list/tuple literal. We accept single
  // or double-quoted string entries; bare identifiers and f-strings are
  // deliberately ignored — they aren't part of the idiomatic pattern.
  const m = /__all__\s*=\s*[[(]([\s\S]*?)[\])]/m.exec(source);
  if (m === null) return null;
  const body = m[1] ?? "";
  const names: string[] = [];
  const item = /['"]([A-Za-z_][\w]*)['"]/g;
  let match: RegExpExecArray | null = item.exec(body);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined) names.push(name);
    match = item.exec(body);
  }
  return names;
}

/**
 * Filter resolution candidates against a target module's `__all__` list.
 *
 * `targetModuleInitPath` is an absolute path to the module's `__init__.py`
 * (or the module file itself). If the file can't be read we pass candidates
 * through — degradation is strictly friendlier than rejection.
 *
 * `candidateName` is the bare Python identifier being imported (already
 * stripped of any `module.` prefix).
 */
export function filterByPythonAll(
  candidates: readonly ResolutionCandidate[],
  targetModuleInitPath: string,
  candidateName: string,
): readonly ResolutionCandidate[] {
  let source: string;
  try {
    source = readFileSync(targetModuleInitPath, "utf8");
  } catch {
    return candidates;
  }
  const allowed = parsePythonAll(source);
  if (allowed === null) return candidates;
  if (!allowed.includes(candidateName)) return [];
  return candidates;
}
