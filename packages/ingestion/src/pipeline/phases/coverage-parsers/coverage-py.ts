/**
 * coverage.py JSON report parser (Stream Q.2).
 *
 * Shape emitted by `coverage json` (a.k.a. `coverage report --format=json`):
 *   {
 *     "files": {
 *       "src/foo.py": {
 *         "executed_lines": [1, 2, 3],
 *         "missing_lines":  [7, 10],
 *         "summary": { "covered_lines": 3, "num_statements": 5, ... }
 *       }
 *     }
 *   }
 *
 * We key on `executed_lines` for the covered set and sum
 * `executed_lines + missing_lines` to get the total. That matches coverage.py
 * semantics more precisely than the `summary.num_statements` field, which
 * excludes excluded-but-executable lines.
 *
 * Paths are already repo-relative POSIX in coverage.py output, so no
 * rewriting is necessary.
 */

import { canonLines, type FileCoverage, ratio } from "./types.js";

interface CovPyFile {
  readonly executed_lines?: readonly number[];
  readonly missing_lines?: readonly number[];
}

interface CovPyReport {
  readonly files?: Record<string, CovPyFile>;
}

export function parseCoveragePy(raw: string, _repoRoot: string): ReadonlyMap<string, FileCoverage> {
  const out = new Map<string, FileCoverage>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const files = (parsed as CovPyReport)?.files;
  if (files === undefined || typeof files !== "object") return out;

  for (const [path, rec] of Object.entries(files)) {
    const executed = Array.isArray(rec?.executed_lines) ? rec.executed_lines : [];
    const missing = Array.isArray(rec?.missing_lines) ? rec.missing_lines : [];
    const total = executed.length + missing.length;
    if (total === 0) continue;
    out.set(path, {
      filePath: path,
      coveredLines: canonLines(executed),
      totalLines: total,
      coveragePercent: ratio(executed.length, total),
    });
  }
  return out;
}
